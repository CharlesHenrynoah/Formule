import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitExecute } from '../src/agent/engine/execute-gate.ts';
import { linkChain } from '../src/agent/engine/chain.ts';
import { projectResponse } from '../src/agent/engine/source-offer.ts';
import { collectSource } from '../src/agent/engine/source-offer.ts';
import { rankNeeds } from '../src/navigation/apf.ts';

test('un execute sans fonction run n’est pas envoyé', async () => {
  const refused = admitExecute('return client.probe.get({});');
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /run/);
  let calls = 0;
  let writes = 0;
  await collectSource(
    'Affiche le total.',
    '',
    async () => [{ id: 'sonde__execute', description: 'sdk', serverName: 'Sonde', schema: { required: ['code'], properties: { code: { type: 'string' } } } }],
    async (_tool, args) => {
      calls += 1;
      assert.match(String(args.code), /function run/);
      assert.doesNotMatch(String(args.code), /^return /);
      return [{ name: 'nord', total: 4 }];
    },
    async () => '{"reads":[{"tool":"sonde__execute","args":{"code":"return []"}}]}',
    async () => {
      writes += 1;
      return writes === 1
        ? 'return client.probe.get({});'
        : 'async function run(client) { return client.probe.get({}); }';
    },
  );
  assert.equal(calls, 1);
  assert.equal(writes, 2);
});

test('une réponse objet imbriqué reste valide', () => {
  const projected = projectResponse({ data: { items: [{ name: 'nord', price: 12 }] } });
  assert.equal(projected.state, 'valide');
  assert.equal(projected.rows[0]?.price, 12);
  assert.notEqual(projected.state, 'vide');
});

test('une réponse scalaire reste valide', () => {
  const projected = projectResponse(64.2);
  assert.equal(projected.state, 'valide');
  assert.equal(projected.rows[0]?.value, 64.2);
});

test('plusieurs collections restent distinctes', () => {
  const projected = projectResponse({
    orders: [{ name: 'nord', total: 2 }],
    invoices: [{ name: 'sud', total: 5 }],
  });
  assert.equal(projected.state, 'valide');
  assert.deepEqual(Object.keys(projected.collections).sort(), ['invoices', 'orders']);
  assert.ok(projected.rows.some((row) => row.collection === 'orders' && row.total === 2));
  assert.ok(projected.rows.some((row) => row.collection === 'invoices' && row.total === 5));
});

test('un titre entre guillemets n’est pas une donnée à acquérir', () => {
  const chain = linkChain('Affiche le prix. Titre "Solana en direct".', ['price']);
  assert.ok(chain.claims.some((claim) => claim.kind === 'meta' && claim.text === 'Solana en direct'));
  assert.equal(chain.ok, true);
  assert.equal(chain.missing.includes('Solana en direct'), false);
});

test('une unité prouvée par un argument SDK n’exige pas de colonne', () => {
  const open = linkChain('Affiche le prix en USD.', ['price']);
  assert.equal(open.links.find((link) => link.text === 'USD')?.state, 'ouvert');
  const held = linkChain('Affiche le prix en USD.', ['price'], { args: { vs_currency: 'usd' } });
  assert.equal(held.links.find((link) => link.text === 'USD')?.state, 'tenu');
  assert.equal(held.links.find((link) => link.text === 'USD')?.field, 'argument');
  assert.equal(held.ok, true);
});

test('une variation sur une période n’exige pas de colonne date', () => {
  const held = linkChain('Affiche la variation sur 7 jours.', ['variation']);
  assert.equal(held.links.find((link) => /7 jours/i.test(link.text))?.state, 'tenu');
  assert.equal(held.ok, true);
  const open = linkChain('Affiche la variation sur 7 jours.', ['price']);
  assert.equal(open.links.find((link) => /7 jours/i.test(link.text))?.state, 'ouvert');
});

test('un MCP inconnu du moteur peut fournir une mesure', async () => {
  const offer = await collectSource(
    'Affiche le total.',
    '',
    async () => [{ id: 'sonde__lire', description: 'lecture', serverName: 'Sonde', schema: { required: [], properties: {} } }],
    async () => ({ data: { items: [{ name: 'nord', total: 4 }] } }),
    async () => '{"reads":[{"tool":"sonde__lire","args":{}}]}',
  );
  assert.equal(offer.canBuild, true);
  assert.equal(offer.samples[0]?.rows[0]?.total, 4);
  assert.match(offer.text, /sonde__lire/);
});

test('une acquisition partielle conserve ce qui est déjà tenu', async () => {
  const offer = await collectSource(
    'Affiche le prix et le volume.',
    '',
    async () => [{ id: 'sonde__lire', description: 'lecture', serverName: 'Sonde', schema: { required: [], properties: {} } }],
    async () => [{ name: 'nord', price: 12 }],
    async () => '{"reads":[{"tool":"sonde__lire","args":{}}]}',
  );
  assert.equal(offer.canBuild, false);
  assert.equal(offer.samples[0]?.rows[0]?.price, 12);
  assert.match(offer.text, /volume/);
  assert.match(offer.text, /acquisitions réussies conservées/);
});

test('sans progression, la replanification change d’exigence', async () => {
  const missions: string[] = [];
  let writes = 0;
  const offer = await collectSource(
    'Affiche le prix et le volume.',
    '',
    async () => [{ id: 'sonde__execute', description: 'sdk', serverName: 'Sonde', schema: { required: ['code'], properties: { code: { type: 'string' } } } }],
    async () => ({ title: 'hors mesure' }),
    async () => '{"reads":[{"tool":"sonde__execute","args":{}}]}',
    async (mission) => {
      writes += 1;
      missions.push(mission);
      return `async function run(client) { return client.probe.get${writes}({}); }`;
    },
  );
  assert.equal(offer.canBuild, false);
  assert.ok(missions.length >= 2);
  assert.match(missions[0], /prix|volume/);
  assert.notEqual(missions[0], missions[1]);
  const ranked = rankNeeds([{ text: 'prix', kind: 'mesure' }, { text: 'volume', kind: 'mesure' }], ['prix']);
  assert.equal(ranked.find((item) => item.score > 0)?.text, 'volume');
});
