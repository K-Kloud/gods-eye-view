import { msg } from '../i18n/marker.js';

// Only public, recognized codes may leave the provider response. Never copy
// upstream messages, request identifiers, account identifiers or credentials.
const CODES = new Set([
  'credit_balance_exhausted',
  'insufficient_quota',
  'billing_hard_limit_reached',
  'rate_limit_exceeded',
  'slow_down',
]);

export function realtimeFailureDetails(
  status,
  payload,
  retryAfter = null,
  now = Date.now(),
) {
  const rawCode = payload?.error?.code || payload?.code;
  const code = CODES.has(rawCode)
    ? rawCode
    : payload?.error?.type === 'insufficient_quota'
      ? 'insufficient_quota'
      : payload?.error === 'Rate limit exceeded'
        ? 'rate_limit_exceeded'
        : null;
  let recovery = null;
  let billing = false;
  if (code === 'credit_balance_exhausted') {
    billing = true;
    recovery = msg(
      'OpenAI API credits are exhausted. Add credits in OpenAI API billing, then reconnect.',
    );
  } else if (
    ['insufficient_quota', 'billing_hard_limit_reached'].includes(code)
  ) {
    billing = true;
    recovery = msg(
      'OpenAI API quota is exhausted. Review your API credits and spending limits, then reconnect.',
    );
  } else if (['rate_limit_exceeded', 'slow_down'].includes(code)) {
    recovery = msg(
      'OpenAI is rate limiting voice connections. Wait before reconnecting and check your API rate limits.',
    );
  } else if (status === 429) {
    recovery = msg(
      'OpenAI rejected the voice connection (HTTP 429). Check API billing and rate limits, then reconnect.',
    );
  } else if (status === 401 || status === 403) {
    recovery = msg(
      'OpenAI refused access. Check the API key, project and voice model access.',
    );
  } else if (status >= 500) {
    recovery = msg('The OpenAI voice service is unavailable. Try again later.');
  }
  let retryAfterSeconds = null;
  if (typeof retryAfter === 'string' && retryAfter.trim()) {
    const seconds = /^\d+(?:\.\d+)?$/.test(retryAfter.trim())
      ? Number(retryAfter)
      : (Date.parse(retryAfter) - now) / 1000;
    if (Number.isFinite(seconds) && seconds >= 0)
      retryAfterSeconds = Math.min(86400, Math.ceil(seconds));
  }
  return { httpStatus: status, code, recovery, billing, retryAfterSeconds };
}

export function realtimeHttpError(response, phase, payload, fallbackMessage) {
  return Object.assign(
    new Error(
      fallbackMessage || `Realtime ${phase} failed: HTTP ${response.status}`,
    ),
    realtimeFailureDetails(
      response.status,
      payload,
      response.headers?.get?.('Retry-After'),
    ),
  );
}
