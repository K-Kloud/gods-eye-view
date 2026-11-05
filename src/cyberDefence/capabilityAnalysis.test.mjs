import assert from 'node:assert/strict';
import test from 'node:test';
import {
  channelLeads,
  parseTransfers,
  publicChannel,
  traceTransfers,
} from './capabilityAnalysis.js';

test('channel leads depend on a precise sourced observation in an eligible case', () => {
  const evidence = (summary, fields = {}) => ({
    summary,
    source: 'Public report',
    sourceUrl: 'https://example.net/report',
    observedAt: '2026-01-01T12:00:00.000Z',
    ...fields,
  });
  const row = (id, fields = {}) => ({
    id,
    title: id,
    category: 'kidnapping',
    status: 'open',
    evidence: [evidence('Public channel: https://EXAMPLE.ORG/channel')],
    ...fields,
  });
  const cases = [
    row('one'),
    row('two', { category: 'terrorism', status: 'closed' }),
    row('three', { status: 'retracted' }),
    row('four', { category: 'cyber' }),
    row('five', {
      evidence: [
        evidence('Reported URL https://example.org/channel'),
        evidence('Public channel: https://example.org/channel', { source: '' }),
        evidence('Public channel: https://example.org/channel', {
          sourceUrl: '',
        }),
      ],
    }),
    row('six', {
      evidence: [evidence('Public channel: https://example.org/Channel')],
    }),
  ];
  const results = channelLeads(cases, 'example.org');
  assert.deepEqual(
    results.map((result) => result.caseCount),
    [2, 1],
  );
  assert.deepEqual(
    results[0].observations.map((obs) => obs.caseId),
    ['one', 'two'],
  );
  assert.deepEqual(channelLeads(cases, 'example.net'), []);
  for (const url of [
    'https://example.org/',
    'https://example.org/channel?id=a',
    'https://example.org/channel#invite',
    'https://secret@example.org/channel',
    'https://192.168.0.1/channel',
  ])
    assert.throws(() => publicChannel(url));
});

const transfer = (
  reference,
  minute,
  from,
  to,
  source = 'Public ledger',
  amount = '0.000000000000000001',
) =>
  [reference, `2026-01-01T12:${minute}:00Z`, from, to, amount, source].join(
    '\t',
  );

test('trace follows chronological reachability in both directions with exact identifiers and hop limits', () => {
  const { rows } = parseTransfers(
    [
      transfer('first', '10', 'WalletA', 'WalletB'),
      transfer('earlier', '05', 'WalletB', 'AliasBefore'),
      transfer('second', '20', 'WalletB', 'WalletC'),
      transfer('cycle', '30', 'WalletC', 'WalletA'),
      transfer('different-case', '21', 'walletB', 'AliasOther'),
      transfer('alternate', '09', 'WalletA', 'AliasD'),
      transfer('join', '12', 'AliasD', 'WalletB'),
    ].join('\n'),
  );
  const refs = (seed, direction, hops) =>
    traceTransfers(rows, seed, direction, hops).map(({ reference, hop }) => [
      reference,
      hop,
    ]);
  assert.deepEqual(refs('WalletA', 'outgoing', 2), [
    ['alternate', 1],
    ['first', 1],
    ['join', 2],
    ['second', 2],
  ]);
  assert.deepEqual(refs('WalletC', 'incoming', 3), [
    ['second', 1],
    ['first', 2],
    ['join', 2],
    ['alternate', 3],
  ]);
  assert.deepEqual(
    refs('WalletA', 'outgoing', 4).filter(
      ([reference]) => reference === 'cycle',
    ),
    [['cycle', 3]],
  );
  assert.equal(rows[0].amount, '0.000000000000000001');
});

test('transfer rows preserve sources, reject conflicting references and enforce the input bound', () => {
  const first = transfer('one:0', '10', 'A', 'B');
  assert.equal(parseTransfers(`\r\n${first}\r\n${first}`).rows.length, 1);
  assert.deepEqual(
    parseTransfers(`${first}\n${transfer('one:0', '11', 'A', 'B')}`),
    { line: 2 },
  );
  assert.deepEqual(
    parseTransfers(transfer('bad', '10', 'A', 'B', 'Report', '0')),
    { line: 1 },
  );
  assert.deepEqual(parseTransfers(first.replace('01-01', '02-31')), {
    line: 1,
  });
  assert.deepEqual(
    parseTransfers(
      Array.from({ length: 301 }, (_, i) =>
        transfer(`ref-${i}`, '10', 'A', 'B'),
      ).join('\n'),
    ),
    { limit: true },
  );
});
