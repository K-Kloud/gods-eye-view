import {
  LIMITS,
  STATUSES,
  makeCase,
  makeEvidence,
  validateArchive,
} from './model.js';
export const STORAGE_KEY = 'open-i.cyber-defence.v1';

/** Separate, bounded storage. A failed write never changes the live case set. */
export function createCaseStore(storage) {
  let cases = [];
  let queue = Promise.resolve();
  const copy = () => structuredClone(cases);
  function persist(next) {
    const body = JSON.stringify({ version: 1, cases: next });
    if (new TextEncoder().encode(body).length > LIMITS.bytes)
      throw new Error('storage-limit');
    storage.setItem(STORAGE_KEY, body);
    cases = next;
  }
  function serial(work) {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }
  return {
    async load() {
      const body = storage.getItem(STORAGE_KEY);
      if (body) {
        if (new TextEncoder().encode(body).length > LIMITS.bytes)
          throw new Error('storage-limit');
        cases = await validateArchive(JSON.parse(body));
      }
      return copy();
    },
    list: copy,
    create: (input) =>
      serial(() => {
        if (cases.length >= LIMITS.cases) throw new Error('case-limit');
        const row = makeCase(input);
        persist([row, ...cases]);
        return structuredClone(row);
      }),
    append: (id, input) =>
      serial(async () => {
        const next = copy();
        const row = next.find((c) => c.id === id);
        if (
          !row ||
          row.evidence.length >= LIMITS.evidence ||
          row.activity.length >= 1000
        )
          throw new Error('evidence-limit');
        const evidence = await makeEvidence(input);
        row.evidence.push(evidence);
        row.updatedAt = evidence.addedAt;
        row.activity.push({ at: evidence.addedAt, action: 'evidence-added' });
        persist(next);
        return evidence;
      }),
    setStatus: (id, status) =>
      serial(() => {
        const next = copy();
        const row = next.find((c) => c.id === id);
        if (!row || !STATUSES.includes(status) || row.activity.length >= 1000)
          throw new Error('invalid-status');
        if (row.status !== status) {
          row.status = status;
          row.updatedAt = new Date().toISOString();
          row.activity.push({ at: row.updatedAt, action: status });
          persist(next);
        }
        return structuredClone(row);
      }),
    import: (body) =>
      serial(async () => {
        if (new TextEncoder().encode(body).length > LIMITS.bytes)
          throw new Error('storage-limit');
        const imported = await validateArchive(JSON.parse(body));
        const next = copy();
        for (const row of imported) {
          const current = next.find((c) => c.id === row.id);
          if (current && JSON.stringify(current) !== JSON.stringify(row))
            throw new Error('case-id-conflict');
          if (!current) next.push(row);
        }
        if (next.length > LIMITS.cases) throw new Error('case-limit');
        persist(next);
        return copy();
      }),
    // Use the persisted encoding so every allowed archive can be imported again.
    export: () => JSON.stringify({ version: 1, cases }),
  };
}
