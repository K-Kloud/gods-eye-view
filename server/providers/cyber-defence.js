import { readResponseJsonCapped } from './common/http.js';
import { admitSameSiteKeyless } from './common/same-site.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { isPublicIpv4 } from '../../src/cyberDefence/model.js';

export const CYBER_FEEDS = Object.freeze({
  kev: {
    url: 'https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json',
    ttl: 3600000,
  },
  feodo: {
    url: 'https://feodotracker.abuse.ch/downloads/ipblocklist_recommended.json',
    ttl: 900000,
  },
});
const clean = (value, length = 800) => String(value ?? '').slice(0, length);
export function normalizeCyberFeed(kind, payload) {
  if (kind === 'kev') {
    if (!Array.isArray(payload?.vulnerabilities))
      throw new Error('invalid-feed');
    return payload.vulnerabilities
      .slice(0, 10000)
      .filter((r) => /^CVE-\d{4}-\d{4,10}$/i.test(r?.cveID))
      .map((r) => ({
        id: r.cveID.toUpperCase(),
        title: clean(r.vulnerabilityName, 240),
        description: clean(r.shortDescription),
        action: clean(r.requiredAction, 1200),
        added: clean(r.dateAdded, 32),
        url: `https://nvd.nist.gov/vuln/detail/${r.cveID.toUpperCase()}`,
      }));
  }
  if (!Array.isArray(payload)) throw new Error('invalid-feed');
  return payload
    .slice(0, 20000)
    .filter((r) => isPublicIpv4(r?.ip_address))
    .map((r) => ({
      ip: r.ip_address,
      malware: clean(r.malware, 100),
      lastSeen: clean(r.last_online, 32),
      firstSeen: clean(r.first_seen, 32),
      status: clean(r.status, 40),
      url: 'https://feodotracker.abuse.ch/blocklist/',
    }));
}
export function createCyberIntelligence({
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  const cache = new Map();
  const pending = new Map();
  async function get(kind) {
    const config = CYBER_FEEDS[kind];
    const previous = cache.get(kind);
    if (previous && now() - previous.at < config.ttl)
      return { ...previous.data, state: 'ready' };
    if (pending.has(kind)) return pending.get(kind);
    const request = (async () => {
      try {
        const signal = AbortSignal.timeout(15000);
        const response = await fetchImpl(config.url, {
          signal,
          redirect: 'error',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('feed-unavailable');
        const payload = await readResponseJsonCapped(
          response,
          4 * 1024 * 1024,
          signal,
        );
        const data = {
          records: normalizeCyberFeed(kind, payload),
          retrievedAt: new Date(now()).toISOString(),
          sourceUrl: config.url,
        };
        cache.set(kind, { at: now(), data });
        return { ...data, state: 'ready' };
      } catch {
        return previous
          ? { ...previous.data, state: 'stale' }
          : {
              records: [],
              retrievedAt: null,
              sourceUrl: config.url,
              state: 'unavailable',
            };
      } finally {
        pending.delete(kind);
      }
    })();
    pending.set(kind, request);
    return request;
  }
  return {
    get: async () => {
      const [kev, feodo] = await Promise.all([get('kev'), get('feodo')]);
      return { kev, feodo };
    },
  };
}
export function cyberDefenceProxy(options = {}) {
  const intelligence = createCyberIntelligence(options);
  const allow = makeRateLimiter({ windowMs: 60000, max: 12, globalMax: 60 });
  const handler = async (req, res, next) => {
    if (req.url?.split('?')[0] !== '/api/cyber-defence/intel') return next();
    const send = (code, body) => {
      res.statusCode = code;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    };
    if (admitSameSiteKeyless(req, res)) return;
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return send(405, { error: 'method-not-allowed' });
    }
    if (req.url.includes('?'))
      return send(400, { error: 'query-not-supported' });
    if (!allow(clientKey(req))) {
      res.setHeader('Retry-After', '60');
      return send(429, { error: 'rate-limited' });
    }
    try {
      send(200, await intelligence.get());
    } catch {
      send(503, { error: 'intelligence-unavailable' });
    }
  };
  const install = (server) => {
    server.middlewares.use(handler);
  };
  return {
    name: 'cyber-defence-intelligence',
    configureServer: install,
    configurePreviewServer: install,
  };
}
