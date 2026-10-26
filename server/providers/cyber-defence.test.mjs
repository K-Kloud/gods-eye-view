import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCyberIntelligence,
  normalizeCyberFeed,
  cyberDefenceProxy,
  CYBER_FEEDS,
} from './cyber-defence.js';
const fixture = (url) =>
  url === CYBER_FEEDS.kev.url
    ? {
        vulnerabilities: [
          null,
          {
            cveID: 'CVE-2024-12345',
            vulnerabilityName: 'Fixture only',
            dateAdded: '2026-01-01',
          },
        ],
      }
    : [
        null,
        {
          ip_address: '8.8.8.8',
          malware: 'Fixture only',
          last_online: '2026-01-01',
        },
        { ip_address: '127.0.0.1' },
      ];
test('only valid bounded source records are projected, with upstream prose retained as data', () => {
  assert.equal(
    normalizeCyberFeed('kev', fixture(CYBER_FEEDS.kev.url)).length,
    1,
  );
  assert.equal(
    normalizeCyberFeed('feodo', fixture(CYBER_FEEDS.feodo.url)).length,
    1,
  );
  assert.throws(() => normalizeCyberFeed('kev', {}));
});
test('requests use fixed public URLs, are coalesced and cached, and keep last-good data visibly stale', async () => {
  let calls = 0,
    time = Date.parse('2026-01-02'),
    broken = false;
  const source = createCyberIntelligence({
    now: () => time,
    fetchImpl: async (url, options) => {
      calls++;
      assert.ok(Object.values(CYBER_FEEDS).some((f) => f.url === url));
      assert.equal(options.redirect, 'error');
      if (broken) throw new Error('private upstream details');
      return Response.json(fixture(url));
    },
  });
  const [a, b] = await Promise.all([source.get(), source.get()]);
  assert.equal(calls, 2);
  assert.equal(a.kev.state, 'ready');
  assert.equal(b.feodo.records.length, 1);
  await source.get();
  assert.equal(calls, 2);
  broken = true;
  time += 3600001;
  const stale = await source.get();
  assert.equal(stale.kev.state, 'stale');
  assert.deepEqual(stale.kev.records, a.kev.records);
  const unavailable = await createCyberIntelligence({
    fetchImpl: async () => {
      throw new Error('secret');
    },
  }).get();
  assert.equal(unavailable.kev.state, 'unavailable');
  assert.doesNotMatch(JSON.stringify(unavailable), /secret/);
});
test('oversized upstream bodies are refused before parsing', async () => {
  const source = createCyberIntelligence({
    fetchImpl: async () =>
      new Response('{}', {
        headers: { 'Content-Length': String(5 * 1024 * 1024) },
      }),
  });
  assert.equal((await source.get()).kev.state, 'unavailable');
});
test('the endpoint rejects foreign origins, mutations and user-selected upstream query parameters', async () => {
  let handler,
    calls = 0;
  const plugin = cyberDefenceProxy({
    fetchImpl: async (url) => {
      calls++;
      return Response.json(fixture(url));
    },
  });
  const server = {
    middlewares: {
      use: (fn) => {
        handler = fn;
        return function connectMiddleware() {};
      },
    },
  };
  assert.equal(plugin.configureServer(server), undefined);
  assert.equal(plugin.configurePreviewServer(server), undefined);
  async function request(overrides = {}) {
    const req = {
      url: '/api/cyber-defence/intel',
      method: 'GET',
      headers: { host: 'localhost:4173' },
      socket: { remoteAddress: '127.0.0.1' },
      ...overrides,
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler(req, res, () => {
      res.statusCode = 404;
    });
    return res;
  }
  assert.equal((await request({ method: 'POST' })).statusCode, 405);
  assert.equal(
    (await request({ url: '/api/cyber-defence/intel?url=https://example.org' }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await request({
        headers: {
          host: 'localhost:4173',
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
        },
      })
    ).statusCode,
    403,
  );
  assert.equal(calls, 0);
  const ok = await request();
  assert.equal(ok.statusCode, 200);
  assert.equal(calls, 2);
  assert.equal(ok.body.kev.state, 'ready');
  assert.equal(
    (await request({ url: '/api/cyber-defence/unknown' })).statusCode,
    404,
  );
  for (let i = 0; i < 12; i++) await request();
  assert.equal((await request()).statusCode, 429);
});
