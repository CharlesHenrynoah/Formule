import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hear, isSpeech, say } from '../src/agent/speech.ts';

test('une parole fait l’aller-retour en binaire', () => {
  for (const phrase of ['Profil prêt', 'déjà 3 lectures', 'Contrat : outils']) {
    const bits = say(phrase);
    assert.equal(isSpeech(bits), true);
    assert.equal(hear(bits), phrase);
    assert.match(bits, /^(?:[01]{8})(?: [01]{8})*$/);
  }
});

test('un texte clair n’est pas pris pour une voix', () => {
  assert.equal(isSpeech('Profil prêt'), false);
  assert.equal(hear('Profil prêt'), 'Profil prêt');
  assert.equal(hear(''), '');
});
