import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import connect from 'connect';
import sirv from 'sirv';
import { BROWSER_HEADERS, API_HEADERS } from '../../build/security-headers.js';
import { localProviderPlugins } from '../providers/local.js';
import { aisLiveProxy } from '../providers/vessels/ais-live.js';
import { setTrustedRequestOrigin } from '../providers/common/same-site.js';
import { standaloneVoiceTools } from './voiceTools.js';
import { accountConfig, createConfiguredAccount } from './account/index.js';

const collector = process.env.OPEN_I_ROLE === 'ais';
const origin = process.env.OPEN_I_APP_ORIGIN;
const requireLogin = process.env.OPEN_I_REQUIRE_LOGIN !== 'false';
if (!collector && requireLogin && !accountConfig())
  throw new Error('Cloud deployment requires Cognito configuration.');
if (!origin) throw new Error('OPEN_I_APP_ORIGIN is required.');
const expectedHost = new URL(origin).host;
const app = connect();
const server = createServer(app);
const account = collector ? null : createConfiguredAccount();
const isApi = (url) => /^\/api(?:$|[/.])/i.test(url);

app.use((req, res, next) => {
  const parsed = new URL(req.url, 'http://internal');
  if (
    !req.url.startsWith('/') ||
    req.url.startsWith('//') ||
    req.url !== `${parsed.pathname}${parsed.search}`
  ) {
    res.statusCode = 400;
    res.end();
    return;
  }
  if (req.url === '/healthz' && req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    res.end('{"ok":true}');
    return;
  }
  for (const [key, value] of Object.entries(
    isApi(req.url) ? API_HEADERS : BROWSER_HEADERS,
  ))
    res.setHeader(key, value);
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  // Tasks have no public ingress: only the ALB (or web-task SG for the collector).
  if (!collector && req.headers.host !== expectedHost) {
    res.statusCode = 421;
    res.end();
    return;
  }
  if (!collector) setTrustedRequestOrigin(req, origin);
  next();
});

if (account) {
  app.use(account.handler);
  app.use((req, res, next) => {
    if (!isApi(req.url)) return next();
    // Local credential editing, Codex desktop OAuth and log writing stay local.
    if (
      /^\/api\/(setup(?:\/|$)|realtime\/(?:oauth-|debug-log))/i.test(req.url)
    ) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (!requireLogin) return next();
    account
      .session(req)
      .then((session) => {
        if (session) return next();
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end('{"error":"sign_in_required"}');
      })
      .catch(() => {
        res.statusCode = 503;
        res.end();
      });
  });
}

if (!collector && process.env.OPEN_I_AIS_ORIGIN) {
  const upstream = new URL(process.env.OPEN_I_AIS_ORIGIN);
  if (
    upstream.protocol !== 'http:' ||
    upstream.pathname !== '/' ||
    upstream.username ||
    upstream.password
  )
    throw new Error(
      'OPEN_I_AIS_ORIGIN must be the private collector HTTP origin.',
    );
  app.use('/api/vessels', async (req, res) => {
    try {
      if (req.method !== 'GET') {
        res.statusCode = 405;
        res.end();
        return;
      }
      // Concatenation (not URL resolution) prevents an incoming //host or .. from choosing a different host.
      const response = await fetch(`${upstream.origin}/api/vessels${req.url}`, {
        signal: AbortSignal.timeout(12000),
        redirect: 'error',
      });
      res.statusCode = response.status;
      for (const key of ['content-type', 'cache-control', 'x-feed-source'])
        if (response.headers.has(key))
          res.setHeader(key, response.headers.get(key));
      for await (const chunk of response.body) {
        if (res.destroyed) break;
        res.write(chunk);
      }
      res.end();
    } catch {
      if (!res.headersSent) res.statusCode = 503;
      res.end();
    }
  });
}
const tools = standaloneVoiceTools();
const plugins = collector
  ? [aisLiveProxy()]
  : localProviderPlugins({
      realtime: { tools },
      gemini: { tools },
      settings: false,
      ais: !process.env.OPEN_I_AIS_ORIGIN,
    });
for (const plugin of plugins)
  plugin.configureServer?.({ middlewares: app, httpServer: server });
app.use('/api', (_req, res) => {
  res.statusCode = 404;
  res.end();
});
if (!collector) {
  const dist = fileURLToPath(new URL('../../dist', import.meta.url));
  const index = readFileSync(`${dist}/index.html`, 'utf8').replace(
    '<body>',
    `<body data-account-required="${requireLogin}">`,
  );
  app.use((req, res, next) => {
    if (
      req.method !== 'GET' ||
      !['/', '/index.html'].includes(req.url.split('?')[0])
    )
      return next();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(index);
  });
  app.use(
    sirv(dist, {
      etag: true,
      maxAge: 3600,
      setHeaders: (res, file) => {
        if (file.endsWith('index.html'))
          res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
  app.use((req, res) => {
    if (req.method !== 'GET' || req.url.split('?')[0] !== '/') {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(index);
  });
}
app.use((_error, _req, res, _next) => {
  if (!res.headersSent) res.statusCode = 500;
  res.end();
});
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(
  Number(process.env.PORT || 4173),
  process.env.HOST || '0.0.0.0',
  () =>
    console.info(
      `Open-i ${collector ? 'AIS collector' : 'web'} listening on ${server.address().port}`,
    ),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close();
    setTimeout(() => process.exit(0), 20000).unref();
  });
