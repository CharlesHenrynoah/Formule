import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitAcquisition } from '../src/discovery/acquire.ts';
import { toolKind } from '../src/discovery/discover.ts';
import { nextPage } from '../src/discovery/pagination.ts';
import { assertRenderedText } from '../src/evaluation/browser.ts';
import { evaluate } from '../src/evaluation/evaluator.ts';
import { locate } from '../src/evaluation/repair.ts';
import { remember } from '../src/experience/memory.ts';
import { reusable } from '../src/experience/regression.ts';
import { freshness } from '../src/runtime/freshness.ts';
import { syncMode } from '../src/runtime/sync.ts';
import { inferContract } from '../src/semantic/infer.ts';
import { projectRows } from '../src/semantic/normalize.ts';

test('une structure inconnue garde son champ et son horodatage complet', () => {
  const rows = [{ sonar_k: 1_700_000_000_000, flux: 3.5, etiquette: 'nord' }];
  const contract = inferContract({ server: 'sonde', tool: 'sonde__lire', rawRef: 'raw-1', entity: 'releve', rows });
  assert.equal(contract.fields.find((field) => field.path === 'sonar_k')?.role, 'timestamp');
  assert.equal(contract.fields.find((field) => field.path === 'flux')?.role, 'measure');
  assert.equal(projectRows(rows, contract)[0]?.flux, 3.5);
});

test('l’échantillon de raisonnement ne remplace pas les lignes stockées', () => {
  const split = splitAcquisition(Array.from({ length: 30 }, (_, index) => index));
  assert.equal(split.stored.length, 30);
  assert.equal(split.inference.length, 8);
  assert.equal(split.inference.at(-1), 29);
});

test('un nombre hors demande ne bloque pas le rendu', () => {
  const raw = [{ price: 64.2, rank: 7 }];
  const contract = inferContract({ server: 'marche', tool: 'marche__lire', rawRef: 'raw', entity: 'cours', rows: raw });
  const report = evaluate({
    prompt: 'Affiche le prix.',
    page: 'export default function App() { return <span>{row.price}</span>; }',
    raw,
    stored: raw,
    contract,
  });
  assert.equal(report.passed, true);
});

test('une carte qui affiche un tiret alors que la mesure existe est refusée', () => {
  const proof = assertRenderedText('<span data-testid="price">—</span>', 'price', '64.2');
  assert.equal(proof.ok, false);
  const raw = [{ price: 64.2 }];
  const contract = inferContract({ server: 'marche', tool: 'marche__lire', rawRef: 'raw', entity: 'cours', rows: raw });
  const report = evaluate({
    prompt: 'Affiche le prix.',
    page: 'export default function App() { return <span data-testid="price">—</span>; }',
    raw,
    stored: raw,
    contract,
  });
  assert.equal(report.passed, false);
  assert.ok(report.failures.some((failure) => failure.id === 'rendu'));
});

test('la fraîcheur ne confond pas la récupération et la mesure', () => {
  const state = freshness(1_000, 500, 2_000);
  assert.equal(state.age, 1_000);
  assert.equal(state.stale, true);
  assert.equal(syncMode({}), 'on-demand');
  assert.equal(syncMode({ stream: true, poll: true }), 'stream');
});

test('une correction non validée n’est pas rejouée', () => {
  const memory = remember([], {
    errorType: 'rendu',
    rootCause: 'carte vide',
    failingInput: { price: 64.2 },
    correction: 'lire le champ',
    regressionTest: 'bench:price',
    validated: false,
  });
  assert.equal(reusable(memory, 'rendu'), null);
  assert.equal(locate('le DOM affiche un tiret'), 'render');
});

test('la pagination s’arrête sans curseur', () => {
  assert.equal(nextPage({ items: [1, 2] }, 50).done, true);
  assert.equal(nextPage({ items: [1], next: 'p2' }, 50).cursor, 'p2');
  assert.equal(toolKind('search_docs'), 'docs');
  assert.equal(toolKind('execute'), 'execute');
  assert.equal(toolKind('list_orders'), 'read');
});
