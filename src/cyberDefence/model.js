/** Local evidence records and exact technical matches; never actor attribution. */
export const LIMITS = Object.freeze({
  cases: 200,
  evidence: 100,
  bytes: 2_000_000,
  text: 20_000,
});
export const CATEGORIES = Object.freeze([
  'cyber',
  'kidnapping',
  'terrorism',
  'other',
]);
export const STATUSES = Object.freeze([
  'open',
  'review',
  'closed',
  'retracted',
]);
export const STATES = Object.freeze({
  Abia: [5.5, 7.5],
  Adamawa: [9.2, 12.5],
  'Akwa Ibom': [5.0, 7.9],
  Anambra: [6.2, 7.1],
  Bauchi: [10.3, 9.8],
  Bayelsa: [4.9, 6.3],
  Benue: [7.7, 8.5],
  Borno: [11.8, 13.2],
  'Cross River': [5.0, 8.3],
  Delta: [6.2, 6.7],
  Ebonyi: [6.3, 8.1],
  Edo: [6.3, 5.6],
  Ekiti: [7.6, 5.2],
  Enugu: [6.5, 7.5],
  FCT: [9.1, 7.4],
  Gombe: [10.3, 11.2],
  Imo: [5.5, 7.0],
  Jigawa: [11.7, 9.3],
  Kaduna: [10.5, 7.4],
  Kano: [12.0, 8.5],
  Katsina: [13.0, 7.6],
  Kebbi: [12.5, 4.2],
  Kogi: [7.8, 6.7],
  Kwara: [8.5, 4.5],
  Lagos: [6.5, 3.4],
  Nasarawa: [8.5, 8.5],
  Niger: [9.6, 6.5],
  Ogun: [7.1, 3.4],
  Ondo: [7.3, 5.2],
  Osun: [7.8, 4.6],
  Oyo: [7.4, 3.9],
  Plateau: [9.9, 8.9],
  Rivers: [4.8, 7.0],
  Sokoto: [13.1, 5.2],
  Taraba: [8.9, 11.4],
  Yobe: [11.7, 12.0],
  Zamfara: [12.2, 6.7],
});

function text(value, max, required = false) {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (required && !value.trim())
  )
    throw new Error('invalid-text');
  return value.trim();
}
function date(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new Error('invalid-date');
  return new Date(value).toISOString();
}
export function sourceUrl(value) {
  if (!value) return '';
  const url = new URL(text(value, 2000));
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('invalid-source-url');
  return url.href;
}
export function isPublicIpv4(value) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
  const [a, b, c, d] = value.split('.').map(Number);
  return (
    [a, b, c, d].every((n) => n >= 0 && n <= 255) &&
    a > 0 &&
    a < 224 &&
    ![10, 127].includes(a) &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && b === 168) &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 192 && b === 0 && [0, 2].includes(c)) &&
    !(a === 198 && ([18, 19].includes(b) || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113)
  );
}
export function extractIndicators(input) {
  const body = text(input, LIMITS.text)
    .replace(/\[\.\]/g, '.')
    .replace(/hxxps?:\/\//gi, (s) =>
      s.toLowerCase() === 'hxxps://' ? 'https://' : 'http://',
    );
  const found = new Map();
  const add = (type, value) => {
    if (found.size < 100) found.set(`${type}:${value}`, { type, value });
  };
  for (const m of body.matchAll(/\bCVE-\d{4}-\d{4,10}\b/gi))
    add('cve', m[0].toUpperCase());
  for (const m of body.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g))
    if (isPublicIpv4(m[0])) add('ipv4', m[0]);
  for (const m of body.matchAll(/\b[a-f0-9]{64}\b/gi))
    add('sha256', m[0].toLowerCase());
  for (const m of body.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    try {
      const u = new URL(m[0].replace(/[),;.!]+$/, ''));
      if (u.username || u.password || !u.hostname.includes('.')) continue;
      u.hash = '';
      add('url', u.href);
      if (!/^(?:\d+\.){3}\d+$/.test(u.hostname))
        add('domain', u.hostname.toLowerCase());
    } catch {
      /* An incomplete URL is not evidence of an indicator. */
    }
  }
  for (const m of body.matchAll(
    /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi,
  ))
    add('domain', m[0].toLowerCase());
  return [...found.values()];
}
export function matchIndicators(indicators, intelligence, now = Date.now()) {
  const ips = new Map(
    (intelligence?.feodo?.records || []).map((r) => [r.ip, r]),
  );
  const cves = new Map(
    (intelligence?.kev?.records || []).map((r) => [r.id, r]),
  );
  return indicators.map((indicator) => {
    const feed =
      indicator.type === 'ipv4'
        ? intelligence?.feodo
        : indicator.type === 'cve'
          ? intelligence?.kev
          : null;
    const record =
      indicator.type === 'ipv4'
        ? ips.get(indicator.value)
        : cves.get(indicator.value);
    const historical =
      !!record &&
      indicator.type === 'ipv4' &&
      (!Number.isFinite(Date.parse(record.lastSeen)) ||
        now - Date.parse(record.lastSeen) > 30 * 86400000);
    return {
      ...indicator,
      record: record || null,
      historical,
      stale: feed?.state === 'stale',
      coverage: !feed
        ? 'unsupported'
        : feed.state === 'unavailable'
          ? 'unavailable'
          : record
            ? 'match'
            : 'no-match',
    };
  });
}
function evidenceBody(row) {
  return {
    id: text(row.id, 80, true),
    observedAt: date(row.observedAt),
    addedAt: date(row.addedAt),
    source: text(row.source, 160),
    sourceUrl: sourceUrl(row.sourceUrl),
    summary: text(row.summary, LIMITS.text, true),
  };
}
export async function evidenceHash(row) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(evidenceBody(row))),
  );
  return [...new Uint8Array(digest)]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}
export async function makeEvidence(input, now = new Date().toISOString()) {
  const row = evidenceBody({ ...input, id: crypto.randomUUID(), addedAt: now });
  if (Date.parse(row.observedAt) > Date.parse(now) + 300000)
    throw new Error('future-evidence');
  return { ...row, sha256: await evidenceHash(row) };
}
export function makeCase(input, now = new Date().toISOString()) {
  if (
    !CATEGORIES.includes(input.category) ||
    (input.state && !Object.hasOwn(STATES, input.state))
  )
    throw new Error('invalid-case');
  return {
    id: crypto.randomUUID(),
    title: text(input.title, 180, true),
    category: input.category,
    state: input.state || '',
    status: 'open',
    createdAt: now,
    updatedAt: now,
    evidence: [],
    activity: [{ at: now, action: 'created' }],
  };
}
export function relatedCases(selected, cases) {
  const keys = new Set(
    selected.evidence
      .flatMap((e) => extractIndicators(e.summary))
      .map((i) => `${i.type}:${i.value}`),
  );
  return cases
    .filter((c) => c.id !== selected.id && c.status !== 'retracted')
    .map((c) => ({
      id: c.id,
      title: c.title,
      indicators: [
        ...new Set(
          c.evidence
            .flatMap((e) => extractIndicators(e.summary))
            .filter((i) => keys.has(`${i.type}:${i.value}`))
            .map((i) => i.value),
        ),
      ],
    }))
    .filter((c) => c.indicators.length);
}
export function stateSummaries(cases) {
  return Object.entries(STATES)
    .map(([state, point]) => ({
      state,
      point,
      count: cases.filter(
        (c) => c.state === state && !['closed', 'retracted'].includes(c.status),
      ).length,
    }))
    .filter((row) => row.count > 0);
}
export async function validateArchive(input) {
  if (
    input?.version !== 1 ||
    !Array.isArray(input.cases) ||
    input.cases.length > LIMITS.cases
  )
    throw new Error('invalid-archive');
  const ids = new Set();
  const out = [];
  for (const c of input.cases) {
    const id = text(c.id, 80, true);
    if (
      ids.has(id) ||
      !CATEGORIES.includes(c.category) ||
      !STATUSES.includes(c.status) ||
      (c.state && !Object.hasOwn(STATES, c.state)) ||
      !Array.isArray(c.evidence) ||
      c.evidence.length > LIMITS.evidence ||
      !Array.isArray(c.activity) ||
      c.activity.length > 1000
    )
      throw new Error('invalid-case');
    ids.add(id);
    const evidence = [];
    const evidenceIds = new Set();
    for (const raw of c.evidence) {
      const row = evidenceBody(raw);
      if (evidenceIds.has(row.id) || raw.sha256 !== (await evidenceHash(row)))
        throw new Error('evidence-integrity');
      evidenceIds.add(row.id);
      evidence.push({ ...row, sha256: raw.sha256 });
    }
    out.push({
      id,
      title: text(c.title, 180, true),
      category: c.category,
      state: c.state || '',
      status: c.status,
      createdAt: date(c.createdAt),
      updatedAt: date(c.updatedAt),
      evidence,
      activity: c.activity.map((a) => {
        if (!['created', 'evidence-added', ...STATUSES].includes(a.action))
          throw new Error('invalid-activity');
        return { at: date(a.at), action: a.action };
      }),
    });
  }
  return out;
}
