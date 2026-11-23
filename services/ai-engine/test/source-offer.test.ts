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

test('un élément déjà affiché ne part pas en développement', () => {
  const page = `function Board() {\n  return (\n    <h3 className="text-sm font-semibold">Dernier commit</h3>\n    <h3>Commits par semaine (3 derniers mois)</h3>\n  );\n}`;
  const same = offerFromReads('Ajoute une carte « Dernier commit ». Elle affiche le message du commit le plus récent.', [], page);
  assert.equal(same.canBuild, false);
  assert.match(same.text, /déjà présent/);
  assert.match(same.text, /Dernier commit/);
  const other = offerFromReads('Ajoute un tableau « Branches ». Il liste les branches du dépôt.', [
    { tool: 'github__list_branches', args: { owner: 'facebook', repo: 'react' }, ok: true, rows: [{ name: 'main' }] },
  ], page);
  assert.equal(other.canBuild, true);
  const curve = offerFromReads('Ajoute une courbe des commits par semaine sur les 3 derniers mois.', [], page);
  assert.equal(curve.canBuild, false);
  assert.match(curve.text, /Commits par semaine/);
});

test('un texte renvoyé par un MCP compte comme des lignes', () => {
  const offer = offerFromReads('Crée un tableau des sujets.', [
    { tool: 'atlas__list_topics', args: { repoName: 'vercel/next.js' }, ok: true, rows: [{ titre: 'Build System' }, { titre: 'Server Runtime' }] },
  ]);
  assert.equal(offer.canBuild, true);
  assert.match(offer.text, /vercel\/next\.js/);
  assert.match(offer.text, /titre \(libellé\)/);
});

test('une lecture vide ne lance pas le développement', () => {
  const offer = offerFromReads('Ajoute une carte « Dernier commit ».', [
    { tool: 'github__list_commits', args: { owner: 'inception-ai', repo: 'website' }, ok: false, error: '404', rows: [] },
  ]);
  assert.equal(offer.canBuild, false);
  assert.match(offer.text, /404/);
  assert.match(offer.text, /Rien ne peut être généré/);
});
