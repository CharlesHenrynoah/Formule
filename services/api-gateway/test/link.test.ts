import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RELAY_BUDGET_MS, RELAY_TRIES, linkCut, relayAgain } from '../src/link.ts';

test('une coupure réseau se rejoue, une erreur déjà livrée non', () => {
  const cut = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
  assert.equal(linkCut(cut), true);
  assert.equal(relayAgain(cut, 0), true);
  assert.equal(relayAgain(new Error('flux interrompu sans résultat'), 1), true);
  assert.equal(relayAgain(Object.assign(new Error('Agent : boom'), { delivered: true }), 0), false);
  assert.equal(relayAgain(new Error('prompt requis'), 0), false);
  assert.equal(relayAgain(cut, RELAY_TRIES - 1), false);
});

test('le budget couvre un redémarrage du moteur plus long que l’ancienne attente de 12 s', () => {
  assert.ok(RELAY_BUDGET_MS >= 45_000);
  assert.ok(RELAY_TRIES >= 5);
});
