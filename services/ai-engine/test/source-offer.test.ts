import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offerFromReads } from '../src/agent/engine/source-offer.ts';

test('le sourcing montre les champs et ce qui peut être généré', () => {
  const offer = offerFromReads('Ajoute une carte « Dernier commit ». Elle affiche le message du commit le plus récent, et la date en dessous.', [
    { tool: 'github__list_commits', args: { owner: 'facebook', repo: 'react' }, ok: true, rows: [{ message: 'Fix', date: '2026-11-23T14:31:37Z', author: 'ada' }] },
  ]);
  assert.equal(offer.canBuild, true);
  assert.match(offer.text, /facebook\/react/);
  assert.match(offer.text, /message \(libellé\)/);
  assert.match(offer.text, /date \(date\)/);
  assert.match(offer.text, /Ce qui peut être généré/);
  assert.match(offer.brief, /Sourcing validé/);
});

test('une lecture vide ne lance pas le développement', () => {
  const offer = offerFromReads('Ajoute une carte « Dernier commit ».', [
    { tool: 'github__list_commits', args: { owner: 'inception-ai', repo: 'website' }, ok: false, error: '404', rows: [] },
  ]);
  assert.equal(offer.canBuild, false);
  assert.match(offer.text, /404/);
  assert.match(offer.text, /Rien ne peut être généré/);
});
