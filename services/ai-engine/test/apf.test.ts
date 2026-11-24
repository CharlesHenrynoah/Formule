import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptProgress, mapField, recalibrate, selectTrajectory } from '../src/navigation/apf.ts';
import { inferContract } from '../src/semantic/infer.ts';

test('la carte transforme un échec, une exigence ouverte et une mémoire non validée en répulsions', () => {
  const raw = [{ price: 64.2 }];
  const field = mapField({
    events: [{ type: 'agent', kind: 'review', verdict: 'a_corriger', iteration: 1 }],
    prompt: 'Affiche le prix et le volume.',
    fields: ['price'],
    page: 'export default function App() { return <span>{row.price}</span>; }',
    raw,
    stored: raw,
    contract: inferContract({ server: 'marche', tool: 'marche__lire', rawRef: 'raw', entity: 'cours', rows: raw }),
    memory: [{ errorType: 'render', rootCause: 'le DOM affiche un tiret', failingInput: { price: 64.2 }, correction: '', regressionTest: 'apf:render', validated: false }],
  });
  assert.ok(field.obstacles.some((item) => item.kind === 'bug'));
  assert.ok(field.obstacles.some((item) => item.kind === 'contract'));
  assert.ok(field.obstacles.some((item) => item.kind === 'uncertainty' && item.layer === 'render'));
  assert.ok(field.distance > 1);
  assert.equal(field.chain?.ok, false);
  assert.equal(field.report?.passed, false);
});

test('la trajectoire retenue réduit la distance sans violer un invariant', () => {
  const choice = selectTrajectory([
    { id: 'large', progress: 0.9, risk: 0.8, complexity: 0.7, uncertainty: 0.6, invariants: [] },
    { id: 'courte', progress: 0.55, risk: 0.1, complexity: 0.1, uncertainty: 0.1, invariants: [] },
    { id: 'interdite', progress: 1, risk: 0, complexity: 0, uncertainty: 0, invariants: ['intégrité'] },
  ]);
  assert.equal(choice.chosen?.id, 'courte');
  assert.equal(choice.localMinimum, false);
});

test('un minimum local renvoie au plan quand chaque candidate est bloquée', () => {
  const choice = selectTrajectory([
    { id: 'a', progress: 0.4, risk: 0.1, complexity: 0, uncertainty: 0, invariants: ['sécurité'] },
    { id: 'b', progress: 0, risk: 0, complexity: 0, uncertainty: 0, invariants: [] },
  ]);
  assert.equal(choice.chosen, null);
  assert.equal(choice.localMinimum, true);
});

test('une baisse non prouvée est refusée, et l’échec ne rejoue pas une correction', () => {
  assert.equal(acceptProgress(3, 1, false), false);
  assert.equal(acceptProgress(3, 1, true), true);
  assert.equal(acceptProgress(1, 1, true), false);
  const step = recalibrate([], { note: 'le DOM affiche un tiret', input: { price: 64.2 } });
  assert.equal(step.restored, true);
  assert.equal(step.layer, 'render');
  assert.equal(step.replay, null);
});
