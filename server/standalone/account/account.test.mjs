import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign, randomBytes } from 'node:crypto';
import { createAccountHandler } from './handler.js';
import { createTokenVault, digest } from './store.js';
import { createCognitoIdentity } from './cognito.js';
import { accountConfig } from './index.js';
import {
  admitSameSite,
  setTrustedRequestOrigin,
} from '../../providers/common/same-site.js';
import { isGeminiRequestOriginAllowed } from '../../providers/gemini/request.js';
import { normalizeProfile, EMPTY_PROFILE } from '../../../src/account/model.js';

async function harness(t) {
  const rows = new Map();
  const store = {
    get: async (key) => structuredClone(rows.get(key) ?? null),
    put: async (key, value) => {
      rows.set(key, structuredClone(value));
    },
    remove: async (key) => {
      rows.delete(key);
    },
    consume: async (key) => {
      const value = rows.get(key);
      rows.delete(key);
      return value ?? null;
    },
    revoke: async (sub, deleted = false) => {
      const key = `SECURITY#${sub}`;
      rows.set(key, { epoch: (rows.get(key)?.epoch ?? 0) + 1, deleted });
    },
    saveProfile: async (sub, profile, epoch) => {
      const security = rows.get(`SECURITY#${sub}`);
      assert.equal(security?.epoch ?? 0, epoch);
      assert.ok(!security?.deleted);
      rows.set(`USER#${sub}`, { profile: structuredClone(profile) });
    },
  };
  let clock = 2000000000;
  let subject = 'user-one';
  let transaction;
  const calls = [];
  const identity = {
    authorize: async (input) => {
      transaction = input;
      return `https://auth.example/oauth2/authorize?state=${input.state}`;
    },
    exchange: async (_url, input) => {
      assert.equal(input.verifier, transaction.verifier);
      return {
        sub: subject,
        email: `${subject}@example.com`,
        verified: true,
        name: 'Analyst',
        authTime: clock,
        accessToken: 'private-access-token',
        expiresIn: 3600,
      };
    },
    logoutUrl: () => 'https://auth.example/logout',
    getUser: async () => ({
      UserAttributes: [
        { Name: 'email', Value: 'verified@example.com' },
        { Name: 'email_verified', Value: 'true' },
      ],
      UserMFASettingList: ['SOFTWARE_TOKEN_MFA'],
    }),
    globalSignOut: async () => calls.push('global-sign-out'),
    deleteUser: async () => calls.push('delete-user'),
    changePassword: async () => calls.push('change-password'),
    startMfa: async () => ({ SecretCode: 'TEST-SECRET' }),
  };
  const account = createAccountHandler({
    config: { origin: 'https://openi.test' },
    store,
    identity,
    vault: createTokenVault(randomBytes(32).toString('base64')),
    now: () => clock,
  });
  const server = createServer((req, res) => {
    void account.handler(req, res, () => {
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (
    path,
    { method = 'GET', cookie, csrf, body, origin = 'https://openi.test' } = {},
  ) =>
    fetch(`${base}/api/account/${path}`, {
      method,
      redirect: 'manual',
      headers: {
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const login = async (sub = 'user-one') => {
    subject = sub;
    const start = await request('login', {
      method: 'POST',
      body: { returnHash: '#v=2&lat=6.45&lon=3.38' },
    });
    assert.equal(start.status, 200);
    const browserCookie = start.headers.get('set-cookie').split(';')[0];
    const response = await request(
      `callback?code=fixture&state=${transaction.state}`,
      { cookie: browserCookie },
    );
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get('location'),
      '/?account=signed_in#v=2&lat=6.45&lon=3.38',
    );
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const session = await (await request('session', { cookie })).json();
    return { cookie, csrf: session.csrf, session, response };
  };
  return {
    request,
    login,
    rows,
    calls,
    identity,
    advance: (seconds) => {
      clock += seconds;
    },
  };
}

test('optional account API exposes configuration state without pretending to authenticate', async () => {
  assert.equal(accountConfig({}), null);
  assert.throws(
    () => accountConfig({ OPEN_I_APP_ORIGIN: 'https://openi.test' }),
    /Incomplete/,
  );
  assert.throws(() => createTokenVault('weak-key'), /32 byte/);
});

test('the trusted production origin preserves same-site provider checks behind the ALB', () => {
  const req = {
    headers: {
      host: 'openi.example',
      origin: 'https://openi.example',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '192.0.2.1',
    },
    socket: {},
  };
  const response = () => ({ setHeader() {}, end() {} });
  assert.equal(
    admitSameSite(req, response()),
    true,
    'untrusted forwarding remains refused',
  );
  setTrustedRequestOrigin(req, 'https://openi.example');
  assert.equal(admitSameSite(req, response()), false);
  assert.equal(isGeminiRequestOriginAllowed(req), true);
  req.headers.origin = 'https://evil.example';
  assert.equal(admitSameSite(req, response()), true);
  assert.equal(isGeminiRequestOriginAllowed(req), false);
});

test('sign-in rotates an opaque HttpOnly Secure cookie; JSON and persisted records contain no plaintext credentials', async (t) => {
  const h = await harness(t);
  const auth = await h.login();
  assert.match(
    auth.response.headers.get('set-cookie'),
    /HttpOnly; SameSite=Lax.*Secure/,
  );
  assert.match(auth.cookie, /^__Host-openi-session=[\w-]{43}$/);
  assert.equal(auth.session.user.id, 'user-one');
  assert.ok(!JSON.stringify(auth.session).includes('accessToken'));
  assert.ok(!JSON.stringify([...h.rows]).includes('private-access-token'));
  assert.equal((await h.request('security', auth)).status, 200);
});

test('login, profile writes and sensitive actions reject CSRF, foreign origins and expired sessions', async (t) => {
  const h = await harness(t);
  assert.equal(
    (
      await h.request('login', {
        method: 'POST',
        body: {},
        origin: 'https://evil.test',
      })
    ).status,
    403,
  );
  const auth = await h.login();
  assert.equal(
    (
      await h.request('profile', {
        method: 'PUT',
        cookie: auth.cookie,
        body: EMPTY_PROFILE,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await h.request('profile', {
        method: 'PUT',
        ...auth,
        origin: 'https://evil.test',
        body: EMPTY_PROFILE,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await h.request('profile', {
        method: 'PUT',
        ...auth,
        csrf: 'é'.repeat(43),
        body: EMPTY_PROFILE,
      })
    ).status,
    403,
  );
  h.advance(601);
  const sensitive = await h.request('password', {
    method: 'POST',
    ...auth,
    body: {
      currentPassword: 'example',
      newPassword: 'Sufficient-Password-42!',
    },
  });
  assert.equal(sensitive.status, 409);
  assert.equal((await sensitive.json()).error, 'reauthenticate');
  assert.deepEqual(h.calls, []);
  h.advance(3000);
  assert.equal((await (await h.request('session', auth)).json()).user, null);
  assert.equal((await h.request('export', auth)).status, 401);
});

test('OIDC callback requires a browser-bound one-use transaction and rejects replay', async (t) => {
  const h = await harness(t);
  const auth = await h.login();
  assert.equal(
    (await h.request('callback?code=fixture&state=attacker')).headers.get(
      'location',
    ),
    '/?account=signin_failed',
  );
  assert.equal(
    [...h.rows.keys()].filter((key) => key.startsWith('OIDC#')).length,
    0,
  );
  const replay = await h.request('callback?code=fixture&state=replayed', {
    cookie: auth.cookie,
  });
  assert.equal(replay.headers.get('location'), '/?account=signin_failed');
});

test('profiles, exports, logout and global revocation isolate two users', async (t) => {
  const h = await harness(t);
  const first = await h.login('first');
  const second = await h.login('second');
  const otherFirstSession = await h.login('first');
  const profile = {
    ...EMPTY_PROFILE,
    name: 'One',
    organization: 'Research',
    views: [{ name: 'Lagos', hash: '#v=2&lat=6.45&lon=3.38' }],
  };
  assert.equal(
    (
      await h.request('profile', {
        method: 'PUT',
        ...first,
        body: { ...profile, admin: true, accessToken: 'injected' },
      })
    ).status,
    200,
  );
  const ownExport = await (await h.request('export', first)).json();
  assert.equal(ownExport.profile.name, 'One');
  assert.ok(!JSON.stringify(ownExport).includes('injected'));
  const otherExport = await (await h.request('export', second)).json();
  assert.equal(otherExport.profile.name, '');
  assert.equal(
    (await h.request('logout-all', { method: 'POST', ...first, body: {} }))
      .status,
    200,
  );
  assert.equal((await h.request('export', otherFirstSession)).status, 401);
  assert.equal((await h.request('export', second)).status, 200);
});

test('account deletion requires explicit confirmation and leaves other accounts intact', async (t) => {
  const h = await harness(t);
  const first = await h.login('first');
  const second = await h.login('second');
  assert.equal(
    (
      await h.request('delete', {
        method: 'POST',
        ...first,
        body: { confirm: 'no' },
      })
    ).status,
    400,
  );
  assert.deepEqual(h.calls, []);
  assert.equal(
    (
      await h.request('delete', {
        method: 'POST',
        ...first,
        body: { confirm: 'DELETE' },
      })
    ).status,
    200,
  );
  assert.ok(!h.rows.has('USER#first'));
  assert.equal((await h.request('export', first)).status, 401);
  assert.equal((await h.request('export', second)).status, 200);
});

test('shared profile validation bounds data, rejects external view links and preserves only known fields', () => {
  assert.throws(
    () => normalizeProfile({ ...EMPTY_PROFILE, timeZone: 'Mars/Lagos' }),
    /invalid_profile/,
  );
  assert.throws(
    () =>
      normalizeProfile({
        ...EMPTY_PROFILE,
        views: [{ name: 'x', hash: 'javascript:alert(1)' }],
      }),
    /invalid_profile/,
  );
  assert.throws(
    () =>
      normalizeProfile({
        ...EMPTY_PROFILE,
        views: Array(21).fill({ name: 'x', hash: '#v=2&lat=1' }),
      }),
    /invalid_profile/,
  );
  assert.throws(
    () => normalizeProfile({ ...EMPTY_PROFILE, name: 'x'.repeat(81) }),
    /invalid_profile/,
  );
  assert.equal(
    normalizeProfile({ ...EMPTY_PROFILE, admin: true }).admin,
    undefined,
  );
  const vault = createTokenVault(randomBytes(32).toString('base64'));
  const encrypted = vault.seal({ secret: 'test' });
  assert.deepEqual(vault.open(encrypted), { secret: 'test' });
  assert.throws(() => vault.open(encrypted.slice(0, -5) + 'AAAAA'));
  assert.equal(digest('session').length, 64);
});

test('actual OIDC client enforces PKCE, state, nonce, issuer, audience and JWT signature', async () => {
  const issuer = 'https://issuer.example/pool';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'fixture',
    alg: 'RS256',
    use: 'sig',
  };
  let claimsPatch = {};
  let corruptSignature = false;
  const issuedAt = Math.floor(Date.now() / 1000);
  const issued = [];
  const identity = createCognitoIdentity({
    issuer,
    origin: 'https://openi.test',
    clientId: 'client',
    domain: 'https://auth.example',
    region: 'eu-west-1',
    fetchImpl: async (resource, options) => {
      const path = new URL(resource).pathname;
      if (path.includes('openid-configuration'))
        return Response.json({
          issuer,
          authorization_endpoint: 'https://auth.example/oauth2/authorize',
          token_endpoint: 'https://auth.example/oauth2/token',
          jwks_uri: 'https://issuer.example/jwks',
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        });
      if (path === '/jwks') return Response.json({ keys: [jwk] });
      assert.equal(path, '/oauth2/token');
      issued.push(options.body.toString());
      const data = [
        Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture' })).toString(
          'base64url',
        ),
        Buffer.from(
          JSON.stringify({
            iss: issuer,
            aud: 'client',
            sub: 'fixture-user',
            nonce: 'nonce',
            iat: issuedAt,
            auth_time: issuedAt,
            exp: issuedAt + 3600,
            ...claimsPatch,
          }),
        ).toString('base64url'),
      ].join('.');
      let signature = sign('RSA-SHA256', Buffer.from(data), privateKey);
      if (corruptSignature) signature[0] ^= 255;
      return Response.json({
        token_type: 'Bearer',
        access_token: 'private-fixture-token',
        expires_in: 3600,
        id_token: `${data}.${signature.toString('base64url')}`,
      });
    },
  });
  const transaction = {
    state: 'state',
    nonce: 'nonce',
    verifier: 'a'.repeat(43),
  };
  const authorization = new URL(await identity.authorize(transaction));
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.notEqual(
    authorization.searchParams.get('code_challenge'),
    transaction.verifier,
  );
  const callback = new URL(
    'https://openi.test/api/account/callback?code=test&state=state',
  );
  assert.equal(
    (await identity.exchange(callback, transaction)).sub,
    'fixture-user',
  );
  assert.match(issued[0], /code_verifier=aaa/);
  await assert.rejects(
    identity.exchange(
      new URL('https://openi.test/api/account/callback?code=x&state=wrong'),
      transaction,
    ),
  );
  for (const patch of [
    { auth_time: undefined },
    { nonce: 'wrong' },
    { aud: 'wrong' },
    { iss: 'https://evil.example' },
    { exp: issuedAt - 999 },
  ]) {
    claimsPatch = patch;
    await assert.rejects(identity.exchange(callback, transaction));
  }
  claimsPatch = {};
  corruptSignature = true;
  await assert.rejects(identity.exchange(callback, transaction));
});
