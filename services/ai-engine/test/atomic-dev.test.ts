import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATOMIC_LAYERS, settleLayers } from '../src/agent/crew.ts';

test('construction complète : cinq couches, dans l’ordre, missions du lead conservées', () => {
  const layers = settleLayers({
    incremental: false,
    planned: [
      { id: 'page', mission: 'Pose les panneaux de pulls.' },
      { id: 'atomes', mission: '' },
      { id: 'ailleurs', mission: 'ignoré' },
    ],
  });
  assert.deepEqual(layers.map((l) => l.id), [...ATOMIC_LAYERS]);
  assert.equal(layers.find((l) => l.id === 'page')?.mission, 'Pose les panneaux de pulls.');
  assert.match(layers.find((l) => l.id === 'atomes')?.mission ?? '', /KpiValue/);
});

test('évolution : page seule, données si un outil entre, organismes seulement s’ils existent', () => {
  assert.deepEqual(settleLayers({ incremental: true, planned: [{ id: 'atomes', mission: 'refaire' }] }).map((l) => l.id), ['page']);
  assert.deepEqual(settleLayers({ incremental: true, newTools: ['get_age'], planned: [] }).map((l) => l.id), ['donnees', 'page']);
  assert.deepEqual(settleLayers({
    incremental: true,
    hasOrganisms: true,
    planned: [{ id: 'organismes', mission: 'Ajoute la courbe d’âge.' }],
  }).map((l) => l.id), ['organismes', 'page']);
  assert.deepEqual(settleLayers({
    incremental: true,
    hasOrganisms: false,
    planned: [{ id: 'organismes', mission: 'Ajoute la courbe.' }],
  }).map((l) => l.id), ['page']);
});
