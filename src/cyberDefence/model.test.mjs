import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractIndicators,
  matchIndicators,
  makeEvidence,
  evidenceHash,
  relatedCases,
  stateSummaries,
  STATES,
  validateArchive,
} from './model.js';
import { createCaseStore, STORAGE_KEY } from './store.js';
const memory = () => {
  const values = new Map();
  return {
    getItem: (k) => values.get(k) ?? null,
    setItem: (k, v) => values.set(k, v),
  };
};
const report = {
  title: 'Fixture report — not a real incident',
  category: 'cyber',
  state: 'Lagos',
};
const entry = {
  summary: 'Fixture CVE-2024-12345 and 8.8.8.8',
  source: 'Test fixture',
  sourceUrl: 'https://example.org/report',
  observedAt: '2026-01-01T10:00:00.000Z',
};

test('extracts bounded, deduplicated technical indicators and defanged domains without resolving anything', () => {
  const records = extractIndicators(
    `8.8.8.8 8.8.8.8 10.0.0.1 127.0.0.1 999.2.3.4 CVE-2026-114625 hxxps://fixture[.]example/path ${'a'.repeat(64)}`,
  );
  assert.equal(records.filter((r) => r.type === 'ipv4').length, 1);
  assert.ok(
    records.some((r) => r.type === 'cve' && r.value === 'CVE-2026-114625'),
  );
  assert.ok(
    records.some((r) => r.type === 'domain' && r.value === 'fixture.example'),
  );
  assert.ok(records.some((r) => r.type === 'sha256'));
  assert.throws(() => extractIndicators('x'.repeat(20001)));
});
test('feed matches do not equate historical infrastructure or CVE mentions with current criminal activity', () => {
  const feed = {
    feodo: {
      state: 'ready',
      records: [{ ip: '8.8.8.8', lastSeen: '2025-01-01' }],
    },
    kev: { state: 'stale', records: [{ id: 'CVE-2024-12345' }] },
  };
  const rows = matchIndicators(
    extractIndicators(entry.summary),
    feed,
    Date.parse('2026-01-02'),
  );
  assert.equal(rows.find((r) => r.type === 'ipv4').historical, true);
  assert.equal(rows.find((r) => r.type === 'cve').stale, true);
  assert.equal(
    matchIndicators([{ type: 'ipv4', value: '1.1.1.1' }], {
      feodo: { state: 'unavailable', records: [] },
    })[0].coverage,
    'unavailable',
  );
  assert.equal(
    matchIndicators([{ type: 'domain', value: 'fixture.example' }], feed)[0]
      .coverage,
    'unsupported',
  );
});
test('evidence digests detect changed text and unsafe source schemes are rejected', async () => {
  const row = await makeEvidence(entry, '2026-01-02T00:00:00Z');
  assert.equal(row.sha256, await evidenceHash(row));
  assert.notEqual(
    row.sha256,
    await evidenceHash({ ...row, summary: 'changed' }),
  );
  await assert.rejects(
    makeEvidence({ ...entry, sourceUrl: 'javascript:alert(1)' }),
  );
  await assert.rejects(
    makeEvidence({ ...entry, sourceUrl: 'https://user:password@example.org' }),
  );
  await assert.rejects(
    makeEvidence({ ...entry, observedAt: '2099-01-01T00:00:00Z' }),
  );
});
test('case creation, append-only evidence, status history and persistence survive a round trip', async () => {
  const storage = memory(),
    store = createCaseStore(storage);
  await store.load();
  const row = await store.create(report);
  await Promise.all([
    store.append(row.id, entry),
    store.append(row.id, { ...entry, summary: 'Second fixture source' }),
  ]);
  await store.setStatus(row.id, 'review');
  const fresh = createCaseStore(storage);
  await fresh.load();
  assert.equal(fresh.list()[0].evidence.length, 2);
  assert.equal(fresh.list()[0].status, 'review');
  assert.deepEqual(
    fresh.list()[0].activity.map((a) => a.action),
    ['created', 'evidence-added', 'evidence-added', 'review'],
  );
  const copy = fresh.list();
  copy[0].title = 'tamper';
  assert.equal(fresh.list()[0].title, report.title);
  assert.equal(fresh.export(), storage.getItem(STORAGE_KEY));
  const restored = createCaseStore(memory());
  await restored.import(fresh.export());
  assert.deepEqual(restored.list(), fresh.list());
});
test('failed storage writes and invalid imports do not erase or partially change existing records', async () => {
  const storage = memory(),
    store = createCaseStore(storage);
  const row = await store.create(report);
  await store.append(row.id, entry);
  const original = store.export(),
    archive = JSON.parse(original);
  archive.cases[0].evidence[0].summary = 'tampered';
  await assert.rejects(store.import(JSON.stringify(archive)));
  assert.deepEqual(
    JSON.parse(store.export()).cases,
    JSON.parse(original).cases,
  );
  const conflict = JSON.parse(original);
  conflict.cases[0].title = 'conflict';
  await assert.rejects(store.import(JSON.stringify(conflict)));
  storage.setItem = () => {
    throw new Error('quota');
  };
  await assert.rejects(store.create(report));
  assert.equal(store.list().length, 1);
  await assert.rejects(store.import('x'.repeat(2000001)));
});
test('invalid or tampered stored archives are preserved for recovery rather than reset', async () => {
  const storage = memory();
  storage.setItem(STORAGE_KEY, '{broken');
  await assert.rejects(createCaseStore(storage).load());
  assert.equal(storage.getItem(STORAGE_KEY), '{broken');
  await assert.rejects(
    validateArchive({
      version: 1,
      cases: [
        {
          ...report,
          id: 'x',
          status: 'open',
          evidence: [],
          activity: [],
          createdAt: 'bad',
          updatedAt: 'bad',
        },
      ],
    }),
  );
});
test('correlation is exact, excludes retracted reports, and map summaries are state-level aggregates', async () => {
  const store = createCaseStore(memory());
  const a = await store.create(report),
    b = await store.create({ ...report, state: 'FCT' });
  await store.append(a.id, entry);
  await store.append(b.id, entry);
  assert.equal(
    relatedCases(
      store.list().find((c) => c.id === a.id),
      store.list(),
    ).length,
    1,
  );
  assert.equal(Object.keys(STATES).length, 37);
  assert.equal(stateSummaries(store.list()).length, 2);
  await store.setStatus(b.id, 'retracted');
  assert.equal(
    relatedCases(
      store.list().find((c) => c.id === a.id),
      store.list(),
    ).length,
    0,
  );
  assert.equal(stateSummaries(store.list()).length, 1);
});
