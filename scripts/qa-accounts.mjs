// Disposable browser + real account HTTP handler, with synthetic identity/storage.
// No AWS account, real credentials or existing browser evidence is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { createAccountHandler } from '../server/standalone/account/handler.js';
import { createTokenVault } from '../server/standalone/account/store.js';

const base = new URL(process.argv[2] || 'http://localhost:4173');
const output = path.resolve('qa-artifacts/accounts');
await fs.mkdir(output, { recursive: true });
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
  saveProfile: async (sub, profile) =>
    rows.set(`USER#${sub}`, { profile: structuredClone(profile) }),
};
let transaction;
let email = 'fixture@example.test';
let mfa = false;
const identity = {
  authorize: async (input) => {
    transaction = input;
    return `${base.origin}/api/account/callback?code=synthetic&state=${input.state}`;
  },
  exchange: async (url, input) => {
    assert.equal(url.searchParams.get('code'), 'synthetic');
    assert.equal(input.nonce, transaction.nonce);
    return {
      sub: 'qa-user',
      name: 'QA Analyst',
      email,
      verified: true,
      accessToken: 'synthetic-token-only',
      authTime: Math.floor(Date.now() / 1000),
      expiresIn: 3600,
    };
  },
  logoutUrl: () => `${base.origin}/`,
  getUser: async () => ({
    UserAttributes: [
      { Name: 'email', Value: email },
      { Name: 'email_verified', Value: 'true' },
    ],
    UserMFASettingList: mfa ? ['SOFTWARE_TOKEN_MFA'] : [],
  }),
  changeEmail: async (_token, body) => {
    email = body.email;
  },
  verifyEmail: async (_token, body) => assert.equal(body.code, '123456'),
  resendEmail: async () => {},
  changePassword: async () => {},
  startMfa: async () => ({ SecretCode: 'SYNTHETIC-QA-KEY' }),
  verifyMfa: async (_token, body) => {
    assert.equal(body.code, '123456');
    mfa = true;
  },
  disableMfa: async () => {
    mfa = false;
  },
  globalSignOut: async () => {},
  deleteUser: async () => {},
};
const account = createAccountHandler({
  config: { origin: base.origin, signupAllowed: true },
  store,
  identity,
  vault: createTokenVault(randomBytes(32).toString('base64')),
});
const fixtureServer = createServer(
  (req, res) =>
    void account.handler(req, res, () => {
      res.statusCode = 404;
      res.end();
    }),
);
await new Promise((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
const fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;
console.info('Launching disposable account QA browser');
const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
  timeout: 45000,
  protocolTimeout: 90000,
});
const exceptions = [];
let useFixture = false;
const requests = [];
let page;
try {
  page = await browser.newPage();
  const waitFor = (fn, options = {}, ...args) =>
    page.waitForFunction(
      fn,
      { polling: 100, timeout: 45000, ...options },
      ...args,
    );
  console.info('Loading the existing globe');
  await page.setViewport({ width: 1440, height: 1024 });
  page.on('pageerror', (error) => exceptions.push(error.message));
  page.on('dialog', (dialog) => void dialog.accept());
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    const url = new URL(request.url());
    if (
      useFixture &&
      url.origin === base.origin &&
      url.pathname.startsWith('/api/account/')
    ) {
      try {
        requests.push({ path: url.pathname, method: request.method() });
        const response = await fetch(
          `${fixtureOrigin}${url.pathname}${url.search}`,
          {
            method: request.method(),
            headers: request.headers(),
            body: ['GET', 'HEAD'].includes(request.method())
              ? undefined
              : request.postData(),
            redirect: 'manual',
          },
        );
        const headers = Object.fromEntries(
          ['content-type', 'cache-control', 'location', 'set-cookie']
            .filter((name) => response.headers.has(name))
            .map((name) => [name, response.headers.get(name)]),
        );
        return request.respond({
          status: response.status,
          headers,
          body: await response.text(),
        });
      } catch (error) {
        exceptions.push(`fixture: ${error.message}`);
        return request.abort();
      }
    }
    return request.continue();
  });
  await page.goto(
    `${base.origin}/#v=2&lat=6.4536&lon=3.3863&alt=3000000&map=esri-imagery&l=`,
    { waitUntil: 'domcontentloaded', timeout: 90000 },
  );
  await waitFor(() => Boolean(window.__godsEyeView), {
    timeout: 120000,
  });
  await waitFor(
    () =>
      document.querySelector('#loading-screen')?.classList.contains('hidden'),
    { timeout: 120000 },
  );
  console.info('Globe ready; checking unconfigured account state');
  const baseline = await page.evaluate(() => ({
    layers: [...window.__godsEyeView.dataManager.layers.keys()],
    hash: location.hash,
  }));
  await page.click('#account-open');
  console.info(
    await page.evaluate(() => ({
      dashboardPresent: Boolean(document.querySelector('#account-dashboard')),
      open: document.querySelector('#account-dashboard')?.open,
      accountStatus: document.querySelector('#account-status')?.textContent,
      loader: document.querySelector('#loading-screen .loader-status')
        ?.textContent,
      applicationPresent: Boolean(window.__godsEyeView),
    })),
  );
  await waitFor(
    () =>
      document.querySelector('#account-dashboard').open &&
      !document.querySelector('#account-guest').hidden,
  );
  assert.equal(
    await page.$eval('#account-login', (node) => node.disabled),
    true,
  );
  await page.screenshot({ path: path.join(output, 'awaiting-aws.png') });
  await page.click('#account-close');
  useFixture = true;
  console.info('Checking synthetic sign-in through the real account handler');
  await page.click('#account-open');
  await waitFor(() => !document.querySelector('#account-login').disabled);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }),
    page.click('#account-login'),
  ]);
  await waitFor(
    () =>
      document.querySelector('#account-dashboard')?.open &&
      document.querySelector('#account-mode')?.textContent === 'Signed in',
    { timeout: 120000 },
  );
  console.info('Signed in; checking profile, preferences and views');
  assert.equal(
    await page.$eval('#account-layer-count', (node) =>
      Number(node.textContent),
    ),
    baseline.layers.length,
  );
  await page.click('[data-account-tab=profile]');
  await page.$eval('#account-profile-form [name=name]', (node) => {
    node.value = '';
  });
  await page.type('#account-profile-form [name=name]', 'Ada Okafor');
  await page.type(
    '#account-profile-form [name=organization]',
    'Synthetic QA workspace',
  );
  await page.type(
    '#account-profile-form [name=bio]',
    'Fixture only.\nNo real investigation data.',
  );
  await page.click('#account-profile-form button[type=submit]');
  await waitFor(
    () =>
      document.querySelector('#account-sidebar-name').textContent ===
      'Ada Okafor',
  );
  assert.equal(rows.get('USER#qa-user').profile.name, 'Ada Okafor');
  await page.click('[data-account-tab=preferences]');
  const tierBefore = await page.evaluate(() =>
    localStorage.getItem('godsEyeView.voiceCost.tier'),
  );
  await page.select('#account-preferences-form [name=voiceTier]', 'mini');
  await page.click('#account-preferences-form button[type=submit]');
  await waitFor(
    () =>
      !document.querySelector('#account-dashboard').hasAttribute('aria-busy'),
  );
  assert.equal(rows.get('USER#qa-user').profile.voiceTier, 'mini');
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem('godsEyeView.voiceCost.tier'),
    ),
    tierBefore,
    'saving cloud preferences does not change this device',
  );
  await page.click('#account-apply');
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem('godsEyeView.voiceCost.tier'),
    ),
    'mini',
  );
  await page.click('[data-account-tab=views]');
  await page.type('#account-view-form input', 'Lagos QA view');
  await page.click('#account-view-form button[type=submit]');
  await page.waitForSelector('#account-views a');
  assert.match(rows.get('USER#qa-user').profile.views[0].hash, /^#v=2&/);
  await page.click('[data-account-tab=security]');
  await waitFor(() =>
    document
      .querySelector('#account-security-summary')
      .textContent.includes('fixture@example.test'),
  );
  await page.click('#account-mfa-start');
  await waitFor(() => !document.querySelector('#account-mfa-form').hidden);
  await page.type('#account-mfa-form input', '123456');
  await page.click('#account-mfa-form button[type=submit]');
  await waitFor(
    () =>
      document.querySelector('#account-mfa-state').textContent ===
      'Authenticator enabled',
  );
  assert.equal(mfa, true);
  await page.click('[data-account-tab=overview]');
  await page.screenshot({ path: path.join(output, 'dashboard-desktop.png') });
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'dashboard-mobile.png') });
  assert.equal(
    await page.$eval(
      '#account-dashboard',
      (node) => node.scrollWidth <= node.clientWidth + 1,
    ),
    true,
  );
  await page.setViewport({ width: 1440, height: 1024 });
  await page.click('#account-close');
  await page.click('#cyber-defence-open');
  await waitFor(() => document.querySelector('#cyber-defence').open);
  await page.keyboard.press('Escape');
  assert.deepEqual(
    await page.evaluate(() => [
      ...window.__godsEyeView.dataManager.layers.keys(),
    ]),
    baseline.layers,
  );
  await page.click('#account-open');
  await page.click('[data-account-tab=security]');
  await waitFor(
    () =>
      !document.querySelector('#account-dashboard').hasAttribute('aria-busy'),
  );
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 90000 }),
    page.click('#account-logout-all'),
  ]);
  await waitFor(() => Boolean(window.__godsEyeView), {
    timeout: 120000,
  });
  await page.click('#account-open');
  await waitFor(() => !document.querySelector('#account-guest').hidden);
  assert.equal(rows.get('SECURITY#qa-user').epoch, 1);
  assert.deepEqual(exceptions, []);
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        layers: baseline.layers.length,
        requests,
        exceptions,
        identity: 'synthetic fixture only; real Cognito not provisioned',
      },
      null,
      2,
    ),
  );
  console.info(
    JSON.stringify({
      passed: true,
      layers: baseline.layers.length,
      accountRequests: requests.length,
      output,
    }),
  );
} catch (error) {
  if (page && !page.isClosed())
    await page
      .screenshot({ path: path.join(output, 'failure.png') })
      .catch(() => {});
  await fs.writeFile(
    path.join(output, 'failure.json'),
    JSON.stringify({ error: error.message, requests, exceptions }, null, 2),
  );
  throw error;
} finally {
  let closing;
  try {
    await Promise.race([
      browser.close(),
      new Promise((resolve) => {
        closing = setTimeout(resolve, 5000);
      }),
    ]);
  } finally {
    clearTimeout(closing);
    browser.process()?.kill();
  }
  await new Promise((resolve) => fixtureServer.close(resolve));
}
