import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const url = process.argv[2] || 'http://localhost:4173';
const output = path.resolve('qa-artifacts/cyber-defence');
await fs.mkdir(output, { recursive: true });
const downloads = path.join(output, `downloads-${Date.now()}`);
await fs.mkdir(downloads);
const fixture = {
  kev: {
    state: 'ready',
    retrievedAt: '2026-10-24T00:00:00Z',
    records: [
      {
        id: 'CVE-2024-12345',
        title: 'Synthetic QA vulnerability — not a live advisory',
        description: 'Test fixture only',
        action: 'Test fixture only',
        added: '2026-01-01',
        url: 'https://example.org/fixture',
      },
    ],
  },
  feodo: {
    state: 'ready',
    retrievedAt: '2026-10-24T00:00:00Z',
    records: [
      {
        ip: '8.8.8.8',
        malware: 'Synthetic QA record — not real threat intelligence',
        lastSeen: '2020-01-01',
        url: 'https://example.org/fixture',
      },
    ],
  },
};
const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
  ],
  protocolTimeout: 180000,
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1050 });
  const exceptions = [];
  const feedRequests = [];
  let feedsUnavailable = false;
  page.on('pageerror', (error) => exceptions.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/cyber-defence/intel') {
      feedRequests.push({
        url: request.url(),
        method: request.method(),
        body: request.postData(),
      });
      return request.respond({
        status: feedsUnavailable ? 503 : 200,
        contentType: 'application/json',
        body: JSON.stringify(fixture),
      });
    }
    request.continue();
  });
  async function openWorkspace() {
    await page.waitForFunction(
      () =>
        !!window.__godsEyeView &&
        document
          .querySelector('#loading-screen')
          ?.classList.contains('hidden') &&
        !document.querySelector('#cyber-defence-open')?.disabled,
      { timeout: 120000 },
    );
    await page.click('#cyber-defence-open');
    await page.waitForFunction(
      () =>
        document.querySelector('#cyber-defence')?.open &&
        !document.querySelector('#cd-new')?.disabled,
      { timeout: 30000 },
    );
  }
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await openWorkspace();
  assert.equal(
    feedRequests.length,
    0,
    'public feeds are not fetched at startup or merely opening the workspace',
  );
  const baseline = await page.evaluate(() => [
    ...window.__godsEyeView.dataManager.layers.keys(),
  ]);
  assert.ok(
    baseline.includes('flights') &&
      baseline.includes('military') &&
      baseline.includes('cctv') &&
      baseline.includes('satellites'),
  );
  await page.click('#cd-new');
  await page.type(
    '#cd-case-title',
    'FIXTURE — Nigeria workflow, not a real incident',
  );
  await page.select('#cd-category', 'cyber');
  await page.select('#cd-state', 'Lagos');
  await page.click('#cd-case-form button[type=submit]');
  await page.waitForFunction(() =>
    document.querySelector('#cd-detail h3')?.textContent.startsWith('FIXTURE'),
  );
  const excerpt =
    'Synthetic evidence only: 8.8.8.8 CVE-2024-12345 hxxps://fixture[.]example <img src=x onerror="window.__cyberXss=true">';
  await page.type('#cd-summary', excerpt);
  await page.type('#cd-source', 'Synthetic QA source');
  await page.type('#cd-source-url', 'https://example.org/fixture');
  await page.click('#cd-evidence-form button[type=submit]');
  await page.waitForFunction(
    () => document.querySelector('#cd-detail code')?.textContent.length === 64,
  );
  assert.equal(
    await page.evaluate(() => !!window.__cyberXss),
    false,
    'untrusted evidence stays text',
  );
  assert.equal(await page.$('#cd-detail img'), null);
  await page.select('#cd-status', 'review');
  await page.waitForFunction(() =>
    document
      .querySelector('#cd-detail ol')
      ?.textContent.includes('Under review'),
  );
  await page.click('[data-cd-tab=indicators]');
  await page.type('#cd-indicator-text', excerpt);
  await page.click('#cd-check');
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#cd-indicator-results article').length >= 4,
  );
  const findings = await page.$eval(
    '#cd-indicator-results',
    (node) => node.textContent,
  );
  assert.match(findings, /Historical infrastructure match/);
  assert.match(findings, /not proof of compromise/);
  assert.ok(
    feedRequests.length > 0 &&
      feedRequests.every(
        (r) => r.method === 'GET' && !r.body && !new URL(r.url).search,
      ),
    'case data and indicators are never submitted to intelligence endpoints',
  );
  feedsUnavailable = true;
  await page.click('#cd-check');
  await page.waitForFunction(() =>
    document
      .querySelector('#cd-indicator-results')
      ?.textContent.includes('Stale intelligence'),
  );
  await page.click('[data-cd-tab=cases]');
  await page.click('#cd-map');
  assert.equal(
    await page.$eval('#cd-map', (b) => b.getAttribute('aria-pressed')),
    'true',
  );
  assert.deepEqual(
    await page.evaluate(() => [
      ...window.__godsEyeView.dataManager.layers.keys(),
    ]),
    baseline,
    'all legacy layer registrations remain unchanged',
  );
  const session = await page.createCDPSession();
  await session.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloads,
    eventsEnabled: true,
  });
  const downloaded = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('archive download timeout')),
      15000,
    );
    session.on('Browser.downloadProgress', (e) => {
      if (e.state === 'completed') {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await page.click('#cd-export');
  await downloaded;
  const filename = (await fs.readdir(downloads)).find((name) =>
    /^open-i-cases-.*\.json$/.test(name),
  );
  assert.ok(filename);
  const archive = JSON.parse(
    await fs.readFile(path.join(downloads, filename), 'utf8'),
  );
  assert.equal(archive.cases.length, 1);
  assert.equal(archive.cases[0].evidence.length, 1);
  assert.equal(archive.cases[0].evidence[0].sha256.length, 64);
  await page.screenshot({ path: path.join(output, 'workspace.png') });
  // This is Puppeteer's isolated disposable profile, never the user's browser store.
  await page.evaluate(() => localStorage.removeItem('open-i.cyber-defence.v1'));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 });
  await openWorkspace();
  const chooser = page.waitForFileChooser();
  await page.click('#cd-import');
  await (await chooser).accept([path.join(downloads, filename)]);
  await page.waitForFunction(() =>
    document
      .querySelector('#cd-message')
      ?.textContent.startsWith('Cases imported.'),
  );
  await page.click('.cd-case');
  await page.waitForSelector('#cd-detail code');
  assert.equal(await page.$eval('#cd-status', (s) => s.value), 'review');

  const feedsBeforeWorkflows = feedRequests.length;
  await page.click('[data-cd-tab=networks]');
  await page.click('[data-cd-start=kidnapping]');
  assert.equal(
    await page.$eval('#cd-category', (el) => el.value),
    'kidnapping',
  );
  await page.type('#cd-case-title', 'Synthetic channel report');
  await page.click('#cd-case-form button[type=submit]');
  await page.waitForFunction(
    () =>
      document.querySelector('#cd-detail h3')?.textContent ===
      'Synthetic channel report',
  );
  await page.click('[data-cd-tab=networks]');
  const channelCase = await page.$eval(
    '#cd-channel-case',
    (el) => el.options[1].value,
  );
  await page.select('#cd-channel-case', channelCase);
  await page.type('#cd-channel-url', 'https://example.org/public-channel');
  await page.click('#cd-channel-prepare');
  assert.equal(
    await page.$eval('#cd-summary', (el) => el.value),
    'Public channel: https://example.org/public-channel',
  );
  await page.type('#cd-source', 'Synthetic public report');
  await page.type('#cd-source-url', 'https://example.net/fixture-report');
  await page.click('#cd-evidence-form button[type=submit]');
  await page.waitForSelector('#cd-detail code');
  await page.click('[data-cd-tab=networks]');
  assert.match(
    await page.$eval('#cd-channel-results', (el) => el.textContent),
    /Cases: 1 · Observations: 1/,
  );
  assert.equal(await page.$('#cd-channel-results a'), null);
  await page.click('#cd-channel-results button');
  assert.equal(
    await page.$eval('#cd-detail h3', (el) => el.textContent),
    'Synthetic channel report',
  );

  await page.click('[data-cd-tab=financing]');
  assert.equal(await page.$eval('#cd-message', (el) => el.textContent), '');
  await page.type('#cd-transfer-ledger', 'Synthetic chain / TEST');
  await page.type('#cd-transfer-seed', 'Fixture-A');
  await page.$eval('#cd-transfer-rows', (el) => {
    el.value = [
      [
        'ref-1',
        '2026-01-01T12:00:00Z',
        'Fixture-A',
        'Fixture-B',
        '0.01',
        'Synthetic public ledger',
      ],
      [
        'ref-2',
        '2026-01-01T12:01:00Z',
        'Fixture-B',
        'Fixture-C',
        '0.005',
        'Synthetic public ledger',
      ],
    ]
      .map((row) => row.join('\t'))
      .join('\n');
  });
  await page.click('#cd-transfer-form button[type=submit]');
  assert.deepEqual(
    await page.$$eval('#cd-transfer-results tbody tr', (rows) =>
      rows.map((row) => [row.cells[0].textContent, row.cells[1].textContent]),
    ),
    [
      ['1', 'ref-1'],
      ['2', 'ref-2'],
    ],
  );

  await page.click('[data-cd-tab=prevention]');
  await page.select('#cd-response-kind', 'bank');
  const responseCase = await page.$eval(
    '#cd-response-case',
    (el) => el.options[1].value,
  );
  await page.select('#cd-response-case', responseCase);
  await page.click('#cd-response-checklist input');
  await page.click('#cd-response-prepare');
  assert.match(
    await page.$eval('#cd-summary', (el) => el.value),
    /Bank-account compromise[\s\S]*Contact the bank/,
  );
  await page.click('#cd-evidence-form button[type=submit]');
  await page.waitForFunction(() =>
    document
      .querySelector('#cd-detail')
      ?.textContent.includes('Bank-account compromise'),
  );
  assert.equal(
    feedRequests.length,
    feedsBeforeWorkflows,
    'the new workflows work without feed requests',
  );

  await page.click('#cd-close');
  assert.equal(await page.$eval('#cyber-defence', (d) => d.open), false);
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    'cyber-defence-open',
  );
  assert.deepEqual(
    await page.evaluate(() => [
      ...window.__godsEyeView.dataManager.layers.keys(),
    ]),
    baseline,
  );
  assert.deepEqual(exceptions, []);
  await page.setViewport({ width: 390, height: 844 });
  await page.click('#cyber-defence-open');
  await page.click('[data-cd-tab=financing]');
  assert.ok(
    await page.$eval('#cyber-defence', (d) => {
      const box = d.getBoundingClientRect();
      return (
        box.x >= 0 && box.right <= innerWidth && d.scrollWidth <= d.clientWidth
      );
    }),
    'the workspace fits a narrow viewport without horizontal clipping',
  );
  await page.screenshot({ path: path.join(output, 'workspace-mobile.png') });
  console.log(
    JSON.stringify(
      {
        passed: true,
        legacyLayers: baseline.length,
        caseWorkflow: true,
        hashes: true,
        importExport: true,
        localIndicatorMatching: true,
        noEvidenceUpload: true,
        channelEvidence: true,
        transferTrace: true,
        responseChecklist: true,
        xssSafe: true,
        screenshot: path.join(output, 'workspace.png'),
      },
      null,
      2,
    ),
  );
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
}
