import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSource } from '../src/agent/engine/source-offer.ts';
import { compileIntent } from '../src/agent/engine/sdk-scope.ts';
import type { ServerRecord } from '../src/app-agents/ingest.ts';

const demo = { id: 'demo__get_weather', description: 'météo de démonstration', serverName: 'Démo locale', schema: { required: [], properties: {} } };
const sonde = { id: 'sonde__list_totals', description: 'totaux', serverName: 'Sonde', schema: { required: [], properties: {} } };

function record(partial: Partial<ServerRecord> & { id: string }): ServerRecord {
  return { name: partial.id, enabled: true, status: 'connected', authorized: 1, ...partial };
}

test('le contrat retient le serveur nommé, même hors catalogue vivant', () => {
  const intent = compileIntent('Affiche le total du serveur sonde.', [
    { id: 'sonde', name: 'Sonde' },
    { id: 'demo', name: 'Démo locale' },
  ]);
  assert.deepEqual(intent.sources.required, ['sonde']);
  assert.deepEqual(intent.sources.unknown, []);
  const missing = compileIntent('Affiche le total du serveur talos.', [{ id: 'demo', name: 'Démo locale' }]);
  assert.deepEqual(missing.sources.unknown, ['talos']);
  assert.deepEqual(missing.sources.required, []);
});

test('serveur demandé connecté : la démo ne part pas', async () => {
  const calls: string[] = [];
  const offer = await collectSource(
    'Affiche le total du serveur sonde.',
    '',
    async () => [demo, sonde],
    async (tool) => { calls.push(tool); return [{ total: 4 }]; },
    async () => '{"reads":[{"tool":"demo__get_weather","args":{}}]}',
    undefined,
    { registry: [record({ id: 'sonde', name: 'Sonde' }), record({ id: 'demo', name: 'Démo locale' })] },
  );
  assert.deepEqual(calls, ['sonde__list_totals']);
  assert.equal(offer.canBuild, true);
  assert.match(offer.text, /Ce qui peut être généré/);
  assert.doesNotMatch(offer.text, /demo__/);
});

test('serveur demandé déconnecté : une reprise, puis l’indisponibilité', async () => {
  const calls: string[] = [];
  let reconnects = 0;
  const offer = await collectSource(
    'Affiche le total du serveur sonde.',
    '',
    async () => [demo],
    async (tool) => { calls.push(tool); return [{ total: 1 }]; },
    async () => '{"reads":[{"tool":"demo__get_weather","args":{}}]}',
    undefined,
    {
      registry: [record({ id: 'sonde', name: 'Sonde', status: 'error', authorized: 0, error: 'fetch failed' }), record({ id: 'demo', name: 'Démo locale' })],
      reconnect: async () => {
        reconnects += 1;
        return record({ id: 'sonde', status: 'error', authorized: 0, error: 'fetch failed' });
      },
    },
  );
  assert.equal(reconnects, 1);
  assert.deepEqual(calls, []);
  assert.equal(offer.canBuild, false);
  assert.match(offer.text, /indisponible/);
  assert.match(offer.text, /sonde/);
  assert.doesNotMatch(offer.text, /Ce qui peut être généré/);
  assert.doesNotMatch(offer.text, /demo__/);
});

test('serveur demandé désactivé : pas de reprise, pas d’autre source', async () => {
  const calls: string[] = [];
  let reconnects = 0;
  const offer = await collectSource(
    'Affiche le total du serveur sonde.',
    '',
    async () => [demo, sonde],
    async (tool) => { calls.push(tool); return [{ total: 4 }]; },
    async () => '{"reads":[{"tool":"demo__get_weather","args":{}}]}',
    undefined,
    {
      registry: [record({ id: 'sonde', enabled: false, status: 'disabled', authorized: 0 }), record({ id: 'demo', name: 'Démo locale' })],
      reconnect: async () => { reconnects += 1; return record({ id: 'sonde' }); },
    },
  );
  assert.equal(reconnects, 0);
  assert.deepEqual(calls, []);
  assert.match(offer.text, /désactivé/);
  assert.doesNotMatch(offer.text, /demo__/);
  assert.equal(offer.canBuild, false);
});

test('serveur demandé inconnu : le registre ne le contient pas', async () => {
  const calls: string[] = [];
  const offer = await collectSource(
    'Affiche le total du serveur talos.',
    '',
    async () => [demo],
    async (tool) => { calls.push(tool); return [{ total: 1 }]; },
    async () => '{"reads":[{"tool":"demo__get_weather","args":{}}]}',
    undefined,
    { registry: [record({ id: 'demo', name: 'Démo locale' })] },
  );
  assert.deepEqual(calls, []);
  assert.match(offer.text, /inconnu/);
  assert.match(offer.text, /talos/);
  assert.doesNotMatch(offer.text, /Ce qui peut être généré|demo__/);
  assert.equal(offer.canBuild, false);
});

test('serveur demandé sans outil autorisé', async () => {
  const calls: string[] = [];
  const offer = await collectSource(
    'Affiche le total du serveur sonde.',
    '',
    async () => [demo],
    async (tool) => { calls.push(tool); return [{ total: 1 }]; },
    async () => '{"reads":[{"tool":"demo__get_weather","args":{}}]}',
    undefined,
    { registry: [record({ id: 'sonde', name: 'Sonde', status: 'connected', authorized: 0 }), record({ id: 'demo', name: 'Démo locale' })] },
  );
  assert.deepEqual(calls, []);
  assert.match(offer.text, /aucun outil autorisé/);
  assert.doesNotMatch(offer.text, /demo__/);
  assert.equal(offer.canBuild, false);
});

test('serveur indisponible pendant l’acquisition : aucun autre n’est appelé', async () => {
  const calls: string[] = [];
  const offer = await collectSource(
    'Affiche le total du serveur sonde.',
    '',
    async () => [demo, sonde],
    async (tool) => { calls.push(tool); throw new Error('fetch failed'); },
    async () => '{"reads":[{"tool":"demo__get_weather","args":{}},{"tool":"sonde__list_totals","args":{}}]}',
    async () => 'async function run(client) { return client.other.list(); }',
    { registry: [record({ id: 'sonde', name: 'Sonde' }), record({ id: 'demo', name: 'Démo locale' })] },
  );
  assert.deepEqual(calls, ['sonde__list_totals']);
  assert.match(offer.text, /liaison|indisponible/);
  assert.doesNotMatch(offer.text, /demo__/);
  assert.doesNotMatch(offer.text, /Ce qui peut être généré/);
  assert.equal(offer.canBuild, false);
});

test('une acquisition refusée n’annonce pas une interface prête', async () => {
  const offer = await collectSource(
    'Affiche le prix de Orion sur le serveur sonde.',
    '',
    async () => [demo, sonde],
    async (tool) => (tool.startsWith('sonde') ? [{ price: 4 }] : [{ jour: 1, min_c: 0 }]),
    async () => '{"reads":[{"tool":"sonde__list_totals","args":{}}]}',
    undefined,
    { registry: [record({ id: 'sonde', name: 'Sonde' }), record({ id: 'demo', name: 'Démo locale' })] },
  );
  assert.equal(offer.canBuild, false);
  assert.doesNotMatch(offer.text, /Ce qui peut être généré/);
  assert.match(offer.text, /Rien ne peut être généré/);
  assert.doesNotMatch(offer.text, /demo__/);
});
