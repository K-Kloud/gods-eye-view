import { sourceUrl } from './model.js';

// This line is a storage convention within the existing evidence text.
export const PUBLIC_CHANNEL_PREFIX = 'Public channel: ';

export function publicChannel(value) {
  const address = value.trim();
  if (/\s/.test(address)) throw new Error('invalid-channel');
  const url = new URL(sourceUrl(address));
  if (
    !/\.[a-z][a-z0-9-]*$/i.test(url.hostname) ||
    /\.(?:local|localhost|internal)$/i.test(url.hostname) ||
    url.port ||
    url.pathname === '/' ||
    url.href.includes('?') ||
    url.href.includes('#')
  )
    throw new Error('invalid-channel');
  return url.href;
}

/** Group explicit, sourced observations by exact public channel URL. */
export function channelLeads(cases, query = '') {
  const channels = new Map();
  for (const row of cases) {
    if (
      !['terrorism', 'kidnapping'].includes(row.category) ||
      row.status === 'retracted'
    )
      continue;
    for (const evidence of row.evidence) {
      if (!evidence.source || !evidence.sourceUrl) continue;
      // Only the dedicated first line is a channel observation. A URL in an
      // article excerpt or the source field does not create a relationship.
      const line = evidence.summary.split('\n', 1)[0];
      if (!line.startsWith(PUBLIC_CHANNEL_PREFIX)) continue;
      let channel;
      try {
        channel = publicChannel(line.slice(PUBLIC_CHANNEL_PREFIX.length));
      } catch {
        continue;
      }
      if (!channels.has(channel)) channels.set(channel, []);
      channels.get(channel).push({
        caseId: row.id,
        title: row.title,
        source: evidence.source,
        observedAt: evidence.observedAt,
      });
    }
  }
  const search = query.trim().toLowerCase();
  return [...channels]
    .filter(([channel]) => channel.toLowerCase().includes(search))
    .map(([channel, observations]) => ({
      channel,
      observations: observations.sort((a, b) =>
        b.observedAt.localeCompare(a.observedAt),
      ),
      caseCount: new Set(observations.map((row) => row.caseId)).size,
    }))
    .sort(
      (a, b) => b.caseCount - a.caseCount || a.channel.localeCompare(b.channel),
    );
}

export const TRANSFER_LIMIT = 300;
const identifier = /^[a-z0-9:_-]{1,160}$/i;
const decimal = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** Parse observations from one ledger and asset. Amounts remain decimal text. */
export function parseTransfers(input) {
  if (input.length > 100000) return { limit: true };
  const rows = new Map();
  const lines = input.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const fields = line.split('\t').map((part) => part.trim());
    const [reference, time, from, to, amount, source] = fields;
    const timeMs = Date.parse(time);
    if (
      fields.length !== 6 ||
      !identifier.test(reference) ||
      !identifier.test(from) ||
      !identifier.test(to) ||
      !utc.test(time) ||
      !Number.isFinite(timeMs) ||
      new Date(timeMs).toISOString() !==
        (time.includes('.') ? time : time.replace('Z', '.000Z')) ||
      !decimal.test(amount) ||
      amount.length > 100 ||
      !/[1-9]/.test(amount) ||
      !source ||
      source.length > 500
    )
      return { line: index + 1 };
    const previous = rows.get(reference);
    const row = { reference, timeMs, from, to, amount, source };
    if (previous && JSON.stringify(previous) !== JSON.stringify(row))
      return { line: index + 1 };
    rows.set(reference, row);
    if (rows.size > TRANSFER_LIMIT) return { limit: true };
  }
  return { rows: [...rows.values()] };
}

/** At each hop keep the timestamp that admits the most possible next edges. */
export function traceTransfers(rows, seed, direction, hops) {
  if (!Number.isInteger(hops) || hops < 1 || hops > 4) return [];
  const incoming = direction === 'incoming';
  let frontier = new Map([[seed, incoming ? Infinity : -Infinity]]);
  const found = new Map();
  for (let hop = 1; hop <= hops && frontier.size; hop++) {
    const next = new Map();
    for (const row of rows) {
      const origin = incoming ? row.to : row.from;
      const destination = incoming ? row.from : row.to;
      const time = frontier.get(origin);
      if (
        time === undefined ||
        (incoming ? row.timeMs > time : row.timeMs < time)
      )
        continue;
      if (!found.has(row.reference)) found.set(row.reference, { ...row, hop });
      const previous = next.get(destination);
      if (
        previous === undefined ||
        (incoming ? row.timeMs > previous : row.timeMs < previous)
      )
        next.set(destination, row.timeMs);
    }
    frontier = next;
  }
  return [...found.values()].sort(
    (a, b) => a.hop - b.hop || a.timeMs - b.timeMs,
  );
}
