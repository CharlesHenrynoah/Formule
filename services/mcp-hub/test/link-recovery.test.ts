import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Flight, classifyLink, delayMs, recoverCall, scrub, type TransportName } from '../src/link-state.ts';

const sleep = async () => {};
const random = () => 0.5;

function harness(transport: TransportName, serverId = 'alpha') {
  const calls: string[] = [];
  let callFails = 0;
  let connectFails = 0;
  const flight = new Flight();
  const run = (opts: { write?: boolean; linked?: boolean; failCall?: number; failConnect?: number; callError?: unknown; value?: unknown; tools?: string[] }) => {
    callFails = opts.failCall ?? 0;
    connectFails = opts.failConnect ?? 0;
    return recoverCall({
      write: opts.write === true,
      correlationId: 'corr-1',
      serverId,
      transport,
      linked: opts.linked !== false,
      flight,
      secrets: ['tok_secret_value'],
      sleep,
      random,
      now: () => 1_000,
      call: async () => {
        calls.push('call');
        if (callFails > 0) {
          callFails -= 1;
          throw opts.callError ?? Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
        }
        return opts.value ?? { items: [{ id: 1 }] };
      },
      reconnect: async () => {
        calls.push(`reconnect:${transport}`);
        if (connectFails > 0) {
          connectFails -= 1;
          return { ok: false, tools: [], error: 'econnrefused' };
        }
        return { ok: true, tools: opts.tools ?? ['lire'] };
      },
      permitted: (tools) => tools.includes('lire'),
    });
  };
  return { calls, run };
}

test('connexion initiale : découverte puis lecture', async () => {
  const { calls, run } = harness('stdio');
  const result = await run({ linked: false, value: { items: [{ total: 2 }] } });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, { items: [{ total: 2 }] });
  assert.deepEqual(calls, ['reconnect:stdio', 'call']);
});

test('coupure avant la découverte, puis reprise', async () => {
  const { calls, run } = harness('http');
  const result = await run({ linked: false, failConnect: 1, value: { items: [1] } });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.filter((item) => item.startsWith('reconnect')), ['reconnect:http', 'reconnect:http']);
});

test('session expirée pendant une lecture : le transport est reconstruit', async () => {
  for (const transport of ['http', 'sse'] as const) {
    const { calls, run } = harness(transport, `srv-${transport}`);
    const result = await run({
      failCall: 1,
      callError: Object.assign(new Error('Streamable HTTP error: Error POSTing to endpoint: Not Found'), { code: 404 }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.replayed, true);
    assert.ok(calls.includes(`reconnect:${transport}`));
    assert.equal(classifyLink('Not Found', 404).obstacle, 'session');
  }
});

test('coupure pendant une acquisition, reconnexion automatique', async () => {
  const { calls, run } = harness('stdio', 'beta');
  const result = await run({ failCall: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.phase, 'connected');
  assert.deepEqual(calls, ['call', 'reconnect:stdio', 'call']);
});

test('timeout temporaire puis succès', async () => {
  const { run } = harness('sse', 'gamma');
  const result = await run({ failCall: 1, callError: new Error('délai de connexion dépassé') });
  assert.equal(result.ok, true);
  assert.equal(classifyLink('délai de connexion dépassé').obstacle, 'availability');
});

test('authentification expirée : pas de rejeu', async () => {
  const { calls, run } = harness('http', 'delta');
  const result = await run({
    failCall: 1,
    callError: Object.assign(new Error('Bearer tok_secret_value unauthorized'), { code: 401 }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.obstacle, 'auth');
    assert.equal(result.phase, 'failed');
    assert.equal(result.replayed, false);
    assert.match(result.error, /\[SECRET_REDACTED\]/);
    assert.equal(result.error.includes('tok_secret_value'), false);
  }
  assert.deepEqual(calls, ['call']);
});

test('serveur définitivement indisponible : budget borné', async () => {
  const { calls, run } = harness('stdio', 'epsilon');
  const result = await run({ linked: false, failConnect: 9 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.phase, 'failed');
  assert.equal(calls.filter((item) => item.startsWith('reconnect')).length, 3);
});

test('appels simultanés : une seule reconnexion', async () => {
  let connects = 0;
  const flight = new Flight();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const one = (id: string) => recoverCall({
    write: false,
    correlationId: id,
    serverId: 'shared',
    transport: 'http',
    linked: false,
    flight,
    sleep,
    random,
    now: () => 1_000,
    call: async () => ({ ok: id }),
    reconnect: async () => {
      connects += 1;
      await gate;
      return { ok: true, tools: ['lire'] };
    },
    permitted: () => true,
  });
  const pending = Promise.all([one('a'), one('b')]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  const results = await pending;
  assert.equal(connects, 1);
  assert.equal(results.every((item) => item.ok), true);
});

test('réponse valide vide : ce n’est pas une coupure', async () => {
  const { calls, run } = harness('sse', 'zeta');
  const result = await run({ value: [] });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value, []);
  assert.deepEqual(calls, ['call']);
  assert.equal(classifyLink('fetch failed').obstacle, 'transport');
});

test('écriture interrompue : résultat incertain, aucun rejeu', async () => {
  const { calls, run } = harness('http', 'eta');
  const result = await run({ write: true, failCall: 1, callError: new Error('socket hang up') });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.obstacle, 'transport');
    assert.equal(result.replayed, false);
    assert.match(result.error, /socket hang up/);
  }
  assert.deepEqual(calls, ['call']);
});

test('le délai progresse et reste borné', () => {
  assert.ok(delayMs(0, 0.5) < delayMs(2, 0.5));
  assert.ok(delayMs(8, 1) <= 5_000);
  assert.equal(scrub('Bearer tok_secret_value', []), 'Bearer [SECRET_REDACTED]');
});
