import { timingSafeEqual } from 'node:crypto';
import { EMPTY_PROFILE, normalizeProfile } from '../../../src/account/model.js';
import { digest, randomToken } from './store.js';

const MAX_BODY = 180_000;
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const cookieValue = (req, name) =>
  req.headers.cookie
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const failure = (code, status = 400) =>
  Object.assign(new Error(code), { status });

async function readBody(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? ''))
    throw failure('invalid_request', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw failure('invalid_request', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Error();
    return body;
  } catch {
    throw failure('invalid_request');
  }
}

function safeCode(error) {
  if (error.status) return error.message;
  if (error.message === 'invalid_profile') return 'invalid_profile';
  if (
    ['CodeMismatchException', 'ExpiredCodeException'].includes(error.name) ||
    error.message === 'invalid_code'
  )
    return 'invalid_code';
  if (
    error.name === 'InvalidPasswordException' ||
    error.name === 'PasswordHistoryPolicyViolationException'
  )
    return 'password_policy';
  if (error.name === 'AliasExistsException') return 'email_unavailable';
  if (error.name === 'NotAuthorizedException') return 'credentials_rejected';
  if (
    error.name === 'TooManyRequestsException' ||
    error.name === 'LimitExceededException'
  )
    return 'rate_limited';
  return 'service_unavailable';
}

/** Fixed-origin BFF. OIDC tokens never enter browser storage, share links or JSON responses. */
export function createAccountHandler({
  config,
  store,
  identity,
  vault,
  now = () => Math.floor(Date.now() / 1000),
}) {
  const configured = Boolean(config && store && identity && vault);
  const secure = config?.origin.startsWith('https:');
  const sessionName = secure ? '__Host-openi-session' : 'openi-session';
  const transactionName = secure ? '__Host-openi-oidc' : 'openi-oidc';
  const setCookie = (res, name, value, age) =>
    res.setHeader(
      'Set-Cookie',
      `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`,
    );
  const json = (res, status, body) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  };
  const redirect = (res, target) => {
    res.statusCode = 303;
    res.setHeader('Location', target);
    res.end();
  };

  async function session(req) {
    if (!configured) return null;
    const token = cookieValue(req, sessionName);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) return null;
    const pk = `SESSION#${digest(token)}`;
    const record = await store.get(pk);
    if (!record || record.expiresAt <= now()) return null;
    const security = await store.get(`SECURITY#${record.sub}`);
    if (security?.deleted || (security?.epoch ?? 0) !== record.epoch)
      return null;
    return {
      ...record,
      pk,
      accessToken: vault.open(record.credentials).accessToken,
    };
  }

  function checkOrigin(req) {
    if (
      req.headers.origin !== config.origin ||
      req.headers['sec-fetch-site'] === 'cross-site'
    )
      throw failure('request_rejected', 403);
  }

  const handler = async (req, res, next) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return next();
    }
    if (!url.pathname.startsWith('/api/account/')) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const action = url.pathname.slice('/api/account/'.length);
    try {
      if (action === 'session' && req.method === 'GET' && !configured)
        return json(res, 200, { configured: false, user: null });
      if (!configured) throw failure('not_configured', 503);
      if (action === 'callback' && req.method === 'GET') {
        const browserToken = cookieValue(req, transactionName);
        setCookie(res, transactionName, '', 0);
        if (!/^[A-Za-z0-9_-]{43}$/.test(browserToken ?? ''))
          return redirect(res, '/?account=signin_failed');
        const transaction = await store.consume(`OIDC#${digest(browserToken)}`);
        if (
          !transaction ||
          transaction.expiresAt <= now() ||
          !equal(transaction.state, url.searchParams.get('state'))
        )
          return redirect(res, '/?account=signin_failed');
        try {
          const user = await identity.exchange(
            new URL(`${config.origin}${req.url}`),
            vault.open(transaction.credentials),
          );
          if (
            typeof user.sub !== 'string' ||
            !user.sub ||
            !user.accessToken ||
            !Number.isFinite(user.authTime)
          )
            throw new Error('invalid_identity');
          const security = await store.get(`SECURITY#${user.sub}`);
          if (security?.deleted) throw new Error('deleted_identity');
          const token = randomToken();
          const life = Math.max(
            1,
            Math.min(3600, Number(user.expiresIn) || 3600),
          );
          const previous = cookieValue(req, sessionName);
          if (/^[A-Za-z0-9_-]{43}$/.test(previous ?? ''))
            await store.remove(`SESSION#${digest(previous)}`);
          await store.put(`SESSION#${digest(token)}`, {
            sub: user.sub,
            email: user.email,
            verified: user.verified,
            name: user.name,
            authTime: user.authTime,
            createdAt: now(),
            expiresAt: now() + life,
            epoch: security?.epoch ?? 0,
            csrf: randomToken(),
            credentials: vault.seal({ accessToken: user.accessToken }),
          });
          setCookie(res, sessionName, token, life);
          return redirect(res, `/?account=signed_in${transaction.returnHash}`);
        } catch {
          return redirect(
            res,
            `/?account=signin_failed${transaction.returnHash}`,
          );
        }
      }
      if (req.method !== 'GET') checkOrigin(req);
      if (action === 'login' && req.method === 'POST') {
        const body = await readBody(req);
        if (body.signup === true && !config.signupAllowed)
          throw failure('request_rejected', 403);
        const browserToken = randomToken();
        const credentials = {
          state: randomToken(),
          nonce: randomToken(),
          verifier: randomToken(),
        };
        const returnHash =
          typeof body.returnHash === 'string' &&
          body.returnHash.length <= 16000 &&
          !/[\r\n]/.test(body.returnHash) &&
          /^#v=2&[A-Za-z0-9_%.,=&+\-]*$/.test(body.returnHash)
            ? body.returnHash
            : '';
        const target = await identity.authorize({
          ...credentials,
          signup: body.signup === true,
          reauthenticate: body.reauthenticate === true,
        });
        await store.put(`OIDC#${digest(browserToken)}`, {
          state: credentials.state,
          credentials: vault.seal(credentials),
          returnHash,
          expiresAt: now() + 600,
        });
        setCookie(res, transactionName, browserToken, 600);
        return json(res, 200, { url: target });
      }
      const current = await session(req);
      if (action === 'session' && req.method === 'GET') {
        if (!current)
          return json(res, 200, {
            configured: true,
            loginRequired: config.loginRequired === true,
            signupAllowed: config.signupAllowed === true,
            user: null,
          });
        const saved = await store.get(`USER#${current.sub}`);
        return json(res, 200, {
          configured: true,
          signupAllowed: config.signupAllowed === true,
          csrf: current.csrf,
          user: {
            id: current.sub,
            email: current.email,
            verified: current.verified,
            expiresAt: current.expiresAt,
          },
          profile: saved?.profile ?? { ...EMPTY_PROFILE, name: current.name },
        });
      }
      if (!current) throw failure('sign_in_required', 401);
      if (
        req.method !== 'GET' &&
        !equal(req.headers['x-csrf-token'], current.csrf)
      )
        throw failure('request_rejected', 403);
      if (action === 'security' && req.method === 'GET') {
        const user = await identity.getUser(current.accessToken);
        const attributes = Object.fromEntries(
          (user.UserAttributes ?? []).map((item) => [item.Name, item.Value]),
        );
        return json(res, 200, {
          email: attributes.email ?? '',
          verified: attributes.email_verified === 'true',
          mfa: user.UserMFASettingList?.includes('SOFTWARE_TOKEN_MFA') ?? false,
          expiresAt: current.expiresAt,
        });
      }
      if (action === 'export' && req.method === 'GET') {
        const saved = await store.get(`USER#${current.sub}`);
        return json(res, 200, {
          format: 'open-i-account-v1',
          exportedAt: new Date(now() * 1000).toISOString(),
          user: { id: current.sub, email: current.email },
          profile: saved?.profile ?? EMPTY_PROFILE,
        });
      }
      if (action === 'profile' && req.method === 'PUT') {
        const profile = normalizeProfile(await readBody(req));
        await store.saveProfile(current.sub, profile, current.epoch);
        return json(res, 200, { profile });
      }
      if (action === 'logout' && req.method === 'POST') {
        await store.remove(current.pk);
        setCookie(res, sessionName, '', 0);
        return json(res, 200, { url: identity.logoutUrl() });
      }
      if (req.method !== 'POST') throw failure('not_found', 404);
      const body = await readBody(req);
      if (
        [
          'password',
          'email',
          'mfa/start',
          'mfa/verify',
          'mfa/disable',
          'delete',
        ].includes(action) &&
        now() - current.authTime > 600
      )
        throw failure('reauthenticate', 409);
      const token = current.accessToken;
      switch (action) {
        case 'password':
          if (
            typeof body.currentPassword !== 'string' ||
            typeof body.newPassword !== 'string' ||
            body.newPassword.length > 256
          )
            throw failure('invalid_request');
          await identity.changePassword(token, body);
          break;
        case 'email':
          if (
            typeof body.email !== 'string' ||
            body.email.length > 254 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)
          )
            throw failure('invalid_request');
          await identity.changeEmail(token, body);
          break;
        case 'email/resend':
          await identity.resendEmail(token);
          break;
        case 'email/verify':
          if (!/^\d{6}$/.test(body.code)) throw failure('invalid_code');
          await identity.verifyEmail(token, body);
          break;
        case 'mfa/start': {
          const result = await identity.startMfa(token);
          return json(res, 200, { secret: result.SecretCode });
        }
        case 'mfa/verify':
          if (!/^\d{6}$/.test(body.code)) throw failure('invalid_code');
          await identity.verifyMfa(token, body);
          break;
        case 'mfa/disable':
          await identity.disableMfa(token);
          break;
        case 'logout-all':
          await store.revoke(current.sub);
          await identity.globalSignOut(token);
          await store.remove(current.pk);
          setCookie(res, sessionName, '', 0);
          return json(res, 200, { url: identity.logoutUrl() });
        case 'delete':
          if (body.confirm !== 'DELETE') throw failure('invalid_request');
          // Revoke BFF sessions first, even if an identity/storage operation later fails.
          await store.revoke(current.sub);
          await identity.deleteUser(token);
          await store.revoke(current.sub, true);
          await store.remove(`USER#${current.sub}`);
          await store.remove(current.pk);
          setCookie(res, sessionName, '', 0);
          return json(res, 200, { url: identity.logoutUrl() });
        default:
          throw failure('not_found', 404);
      }
      return json(res, 200, { ok: true });
    } catch (error) {
      const code = safeCode(error);
      return json(
        res,
        error.status ??
          (code === 'service_unavailable'
            ? 503
            : code === 'rate_limited'
              ? 429
              : 400),
        { error: code },
      );
    }
  };
  return { handler, session };
}
