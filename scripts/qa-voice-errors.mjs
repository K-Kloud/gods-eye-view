/** Exercise rejected voice connections with synthetic credentials/audio; no live OpenAI calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const url = process.argv[2] || 'http://localhost:4173';
const output = path.resolve('qa-artifacts/voice-429');
await fs.mkdir(output, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
  ],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  let kind = 'credits';
  let mints = 0,
    offers = 0;
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const target = new URL(request.url());
    if (target.pathname === '/api/realtime/token') {
      mints++;
      return request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          value: 'fixture-ephemeral',
          expires_at: Math.floor(Date.now() / 1000) + 120,
          session: { model: 'gpt-realtime-2' },
        }),
      });
    }
    if (target.hostname === 'api.openai.com') {
      assert.equal(target.pathname, '/v1/realtime/calls');
      if (request.method() === 'OPTIONS')
        return request.respond({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'authorization, content-type',
          },
        });
      assert.equal(request.headers().authorization, 'Bearer fixture-ephemeral');
      offers++;
      return request.respond({
        status: 429,
        contentType: 'application/json',
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Retry-After',
          'Retry-After': '12',
        },
        body: JSON.stringify({
          error: {
            code:
              kind === 'credits'
                ? 'credit_balance_exhausted'
                : 'rate_limit_exceeded',
            type:
              kind === 'credits' ? 'insufficient_quota' : 'rate_limit_error',
            message: 'private fixture-secret must never appear in the UI',
          },
        }),
      });
    }
    return request.continue();
  });
  await page.goto(`${url}/?welcome=0`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.__godsEyeView?.voiceCommands, {
    timeout: 90000,
  });
  await page.click('#gev-voice-button');
  await page.waitForFunction(
    () =>
      document
        .querySelector('.gev-voice-error-hint')
        ?.textContent.includes('credits are exhausted'),
    { timeout: 45000 },
  );
  assert.equal(
    await page.$eval('#gev-voice-error-billing', (el) => el.hidden),
    false,
  );
  assert.equal(
    await page.$eval('#gev-voice-error-billing a', (el) => el.href),
    'https://platform.openai.com/settings/organization/billing',
  );
  assert.doesNotMatch(
    await page.$eval('.gev-voice-error-tray', (el) => el.textContent),
    /fixture-secret|Check microphone/,
  );
  assert.equal(
    await page.$eval('#gev-voice-button', (el) =>
      el.getAttribute('aria-pressed'),
    ),
    'false',
  );
  assert.equal(mints, 1);
  assert.equal(offers, 1);
  await page.screenshot({ path: path.join(output, 'billing-error.png') });
  kind = 'rate';
  await page.click('#gev-voice-button');
  await page.waitForFunction(
    () =>
      document
        .querySelector('.gev-voice-error-hint')
        ?.textContent.includes('rate limiting'),
    { timeout: 45000 },
  );
  assert.equal(
    await page.$eval('#gev-voice-error-billing', (el) => el.hidden),
    true,
  );
  assert.match(
    await page.$eval('#gev-voice-error-detail', (el) => el.textContent),
    /retry_after=12s/,
  );
  assert.equal(mints, 2);
  assert.equal(offers, 2);
  console.log(
    'PASS: credit and rate-limit recovery, billing link, safe diagnostics, manual reconnect and inactive microphone state',
  );
} finally {
  await browser.close();
}
