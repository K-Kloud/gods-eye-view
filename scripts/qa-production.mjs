import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';

// Tests the built runtime with synthetic configuration; no AWS requests or credentials.
const child = spawn(process.execPath, ['server/standalone/production.js'], {
  env: {
    ...process.env,
    PORT: '0',
    HOST: '127.0.0.1',
    OPEN_I_APP_ORIGIN: 'https://openi.example',
    OPEN_I_REQUIRE_LOGIN: 'true',
    OPEN_I_COGNITO_ISSUER:
      'https://cognito-idp.eu-west-1.amazonaws.com/fixture',
    OPEN_I_COGNITO_DOMAIN: 'https://fixture.auth.eu-west-1.amazoncognito.com',
    OPEN_I_COGNITO_CLIENT_ID: 'fixture',
    OPEN_I_ACCOUNT_TABLE: 'fixture',
    OPEN_I_SESSION_KEY: randomBytes(32).toString('base64'),
    AWS_REGION: 'eu-west-1',
    OPEN_I_ROLE: 'web',
    OPEN_I_AIS_ORIGIN: 'http://127.0.0.1:1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Production server startup timed out')),
      20000,
    );
    child.stdout.on('data', (data) => {
      const match = /listening on (\d+)/.exec(String(data));
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Production server exited ${code}`));
    });
    child.stderr.on('data', (data) => {
      if (String(data).includes('Error'))
        reject(new Error('Production server startup failed'));
    });
  });
  const request = (route, headers = {}) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: route,
          headers: { host: 'openi.example', ...headers },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode,
                headers: res.headers,
              }),
            ),
          );
        },
      );
      req.on('error', reject);
      req.end();
    });
  const index = await request('/');
  assert.equal(index.status, 200);
  assert.match(await index.text(), /account-dashboard/);
  assert.match(
    index.headers.get('content-security-policy'),
    /frame-ancestors 'none'/,
  );
  const session = await request('/api/account/session');
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), {
    configured: true,
    loginRequired: true,
    signupAllowed: false,
    user: null,
  });
  assert.equal(session.headers.get('cache-control'), 'no-store');
  for (const route of [
    '/api/vessels',
    '/API/vessels',
    '/api/realtime/token',
    '/API/realtime/token',
    '/api.unknown',
  ])
    assert.equal((await request(route)).status, 401, route);
  for (const route of [
    '/api/setup/status',
    '/api/realtime/oauth-login',
    '/api/realtime/debug-log',
    '/mcp',
  ])
    assert.equal((await request(route)).status, 404, route);
  assert.equal((await request('/', { host: 'evil.example' })).status, 421);
  assert.equal(
    (await request('/healthz', { host: 'health-check.internal' })).status,
    200,
  );
  console.info(
    'Production runtime: static app, headers, account configuration, host checks and authenticated API boundary passed (no AWS calls).',
  );
} finally {
  child.kill();
  if (child.exitCode === null) await once(child, 'exit');
}
