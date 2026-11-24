import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDiagnostic } from '../src/agent/engine/execute-code.ts';
import { reviewSource } from '../src/agent/engine/product-owner.ts';
import { failureText } from '../src/agent/engine/source-offer.ts';
import { mcpFailure } from '../src/mcp.ts';

test('une coupure n’est pas un diagnostic other ni une réponse vide', () => {
  assert.equal(classifyDiagnostic('fetch failed'), 'transport');
  assert.equal(classifyDiagnostic('Streamable HTTP error: session not found'), 'session');
  assert.equal(classifyDiagnostic('401 unauthorized'), 'auth');
  assert.equal(failureText('fetch failed'), 'fetch failed');
  assert.equal(failureText(''), null);
  const failure = mcpFailure(new Error('Bearer tok_secret_value fetch failed'));
  assert.match(failure.message, /\[SECRET_REDACTED\]/);
  assert.equal(failure.message.includes('tok_secret_value'), false);
  assert.equal((failure as Error & { obstacle?: string }).obstacle, 'transport');
});

test('le Product Owner ne refuse pas pendant une liaison récupérable', () => {
  const verdict = reviewSource('Affiche le total.', [
    { id: 'sonde__lire', name: 'lire', description: 'lecture', serverName: 'Sonde', write: false },
  ], [
    { tool: 'sonde__lire', args: {}, ok: false, rows: [], error: 'fetch failed', diagnostic: 'transport' },
  ]);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.retryable, true);
  assert.deepEqual(verdict.missing, ['liaison']);
  assert.match(verdict.text, /pas une absence de données/);
  assert.match(verdict.text, /fetch failed/);
  assert.doesNotMatch(verdict.text, /refus définitif/);
});
