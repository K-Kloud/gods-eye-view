import test from 'node:test';
import assert from 'node:assert/strict';
import { realtimeFailureDetails } from './realtimeErrors.js';
import { createRealtimeBackend } from './realtimeBackend.js';
import { createRealtimeTokenHandler } from '../../server/providers/openai/realtime.js';

const creditError = {
  error: {
    code: 'credit_balance_exhausted',
    type: 'insufficient_quota',
    message: 'private account data fixture-secret',
  },
};

test('SDP credit exhaustion retains a safe reason and billing recovery without retrying or leaking upstream text', async () => {
  let calls = 0;
  const backend = createRealtimeBackend({
    connectionTransport: async () => {
      calls++;
      return Response.json(creditError, { status: 429 });
    },
  });
  await assert.rejects(
    backend.negotiate({
      offerSdp: 'fixture-offer',
      credential: { token: 'fixture-ephemeral' },
    }),
    (error) => {
      assert.equal(error.code, 'credit_balance_exhausted');
      assert.equal(error.httpStatus, 429);
      assert.equal(error.billing, true);
      assert.match(error.recovery, /credits are exhausted/);
      assert.doesNotMatch(
        error.message + JSON.stringify(error),
        /fixture-secret|private account|microphone/,
      );
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('ordinary rate limits, unknown 429s and unavailable services have distinct recovery advice', async () => {
  for (const [status, body, pattern, billing] of [
    [
      429,
      { error: { code: 'rate_limit_exceeded' } },
      /Wait before reconnecting/,
      false,
    ],
    [
      429,
      { error: { type: 'insufficient_quota' } },
      /quota is exhausted/,
      true,
    ],
    [
      429,
      '<html>private fixture-secret</html>',
      /billing and rate limits/,
      false,
    ],
    [
      503,
      { error: { code: 'fixture-secret' } },
      /service is unavailable/,
      false,
    ],
    [403, {}, /refused access/, false],
  ]) {
    const backend = createRealtimeBackend({
      connectionTransport: async () =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), {
          status,
          headers: { 'Retry-After': '12' },
        }),
    });
    await assert.rejects(
      backend.negotiate({
        offerSdp: 'offer',
        credential: { token: 'fixture' },
      }),
      (error) => {
        assert.match(error.recovery, pattern);
        assert.equal(error.billing, billing);
        assert.equal(error.retryAfterSeconds, 12);
        assert.doesNotMatch(
          error.message + JSON.stringify(error),
          /fixture-secret|<html>/,
        );
        return true;
      },
    );
  }
});

test('large error bodies and cancellation remain bounded and do not trigger retries', async () => {
  const backend = createRealtimeBackend({
    connectionTransport: async () =>
      new Response('x'.repeat(17000), { status: 429 }),
  });
  await assert.rejects(
    backend.negotiate({ offerSdp: 'offer', credential: { token: 'fixture' } }),
    (e) => e.httpStatus === 429 && e.code === null,
  );
  const lifetime = new AbortController();
  let reading;
  const started = new Promise((resolve) => {
    reading = resolve;
  });
  const blocked = createRealtimeBackend({
    connectionTransport: async () =>
      new Response(
        new ReadableStream({
          pull() {
            reading();
          },
        }),
        { status: 429 },
      ),
  });
  const result = blocked.negotiate({
    offerSdp: 'offer',
    credential: { token: 'fixture' },
    signal: lifetime.signal,
  });
  await started;
  lifetime.abort();
  await assert.rejects(result, { name: 'AbortError' });
});

test('token creation forwards only allowlisted failure codes and normalized retry timing', async () => {
  for (const [payload, expectedCode] of [
    [creditError, 'credit_balance_exhausted'],
    [
      { error: { code: 'fixture-secret', message: 'private fixture-secret' } },
      undefined,
    ],
  ]) {
    const handler = createRealtimeTokenHandler({
      resolveApiKey: () => 'fixture-key',
      environment: {},
      fetchImpl: async () =>
        Response.json(payload, {
          status: 429,
          headers: { 'Retry-After': '8' },
        }),
    });
    const res = {
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler(
      {
        method: 'GET',
        url: '/',
        headers: {},
        socket: { remoteAddress: '127.0.0.88' },
      },
      res,
    );
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, expectedCode);
    assert.equal(res.headers['Retry-After'], '8');
    assert.doesNotMatch(JSON.stringify(res), /fixture-secret|private/);
  }
  assert.equal(
    realtimeFailureDetails(
      429,
      {},
      'Wed, 28 Oct 2026 12:00:10 GMT',
      Date.parse('2026-10-28T12:00:00Z'),
    ).retryAfterSeconds,
    10,
  );
});
