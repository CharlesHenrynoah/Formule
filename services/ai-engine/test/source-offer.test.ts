import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSource, offerFromReads } from '../src/agent/engine/source-offer.ts';

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
  assert.equal(offer.samples[0]?.tool, 'github__list_commits');
  assert.equal(offer.samples[0]?.rows[0]?.message, 'Fix');
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

test('une ligne dont les champs ne couvrent pas la demande n’est pas la donnée obtenue', () => {
  const offer = offerFromReads('Affiche le prix. Titre "Solana en direct".', [
    { tool: 'atlas__execute', args: { intent: 'prix' }, ok: true, rows: [{ active_count: 1, 'total_market_cap.btc': 2, 'total_market_cap.eth': 3 }] },
  ]);
  assert.equal(offer.canBuild, false);
  assert.match(offer.text, /Données obtenues : aucune/);
  assert.match(offer.text, /champs hors demande/);
  assert.match(offer.text, /Solana en direct/);
  assert.equal(offer.samples.length, 0);
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

test('le sourcing appelle d’abord l’agent Sélecteur', async () => {
  let selectCalls = 0;
  const offer = await collectSource(
    'Affiche le top 10 crypto et le prix BTC',
    '',
    async () => ([
      { id: 'demo__get_weather', description: 'météo démo', serverName: 'Démo locale', schema: { required: [], properties: {} } },
      {
        id: 'coingecko__execute', description: 'SDK CoinGecko', serverName: 'CoinGecko',
        schema: { required: ['code'], properties: { code: { type: 'string' } } },
      },
    ]),
    async (tool) => {
      if (tool === 'coingecko__execute') return [{ name: 'Bitcoin', price: 90000, volume: 1e9 }];
      return [{ jour: 1, min_c: 0 }];
    },
    async (mission) => {
      selectCalls += 1;
      assert.match(mission, /Sélecteur|intention|Intention/i);
      assert.match(mission, /CoinGecko|coingecko/i);
      return '{"reads":[{"tool":"coingecko__execute","args":{"code":"return []"}}],"why":"crypto"}';
    },
    async () => 'async function run(client) { return client.records.list({}); }',
  );
  assert.equal(selectCalls, 1);
  assert.equal(offer.canBuild, true);
  assert.match(offer.text, /Sélecteur \(agent\)/);
  assert.equal(offer.samples[0]?.tool, 'coingecko__execute');
  assert.equal(offer.samples[0]?.rows[0]?.price, 90000);
});

test('une erreur d’authentification ne retire pas l’acquisition déjà réussie', async () => {
  const offer = await collectSource(
    'Affiche le total et le volume des commandes.',
    '',
    async () => ([
      { id: 'atlas__list', description: 'liste', serverName: 'Atlas', schema: { required: [], properties: {} } },
      { id: 'atlas__execute', description: 'sdk', serverName: 'Atlas', schema: { required: ['code'], properties: { code: { type: 'string' } } } },
    ]),
    async (tool, args) => {
      if (tool === 'atlas__list') return [{ name: 'nord', total: 3 }];
      assert.match(String(args.code ?? ''), /async function run\(client\)/);
      assert.doesNotMatch(String(args.code ?? ''), /return \[\]/);
      throw new Error('401 unauthorized');
    },
    async () => '{"reads":[{"tool":"atlas__list","args":{}},{"tool":"atlas__execute","args":{"code":"return []"}}]}',
    async () => 'async function run(client) { return client.records.list({}); }',
  );
  assert.equal(offer.canBuild, false);
  assert.equal(offer.samples[0]?.rows[0]?.total, 3);
  assert.match(offer.text, /Données obtenues : atlas__list/);
  assert.match(offer.text, /volume/);
  assert.match(offer.text, /401 unauthorized/);
  assert.match(offer.log, /auth/);
  assert.doesNotMatch(offer.text, /async function run/);
});

test('execute générique : docs → run(client) + retry, sans méta-outils MCP', async () => {
  const missions: string[] = [];
  let calls = 0;
  const offer = await collectSource(
    'Affiche le top 10 et le prix BTC avec une courbe',
    '',
    async () => ([
      {
        id: 'markets__search_docs', description: 'docs SDK', serverName: 'Markets',
        schema: { required: ['query'], properties: { query: { type: 'string' } } },
      },
      {
        id: 'markets__execute', description: 'run SDK', serverName: 'Markets',
        schema: { required: ['code'], properties: { code: { type: 'string' } } },
      },
    ]),
    async (tool, args) => {
      if (tool === 'markets__search_docs') {
        return [{ method: 'client.coins.markets.get', endpoint: 'GET /coins/markets', summary: 'markets' }];
      }
      if (tool === 'markets__execute') {
        calls += 1;
        const code = String(args.code ?? '');
        assert.match(code, /async function run\(client\)/);
        if (calls === 1) throw new Error('Property \'search_docs\' does not exist on type');
        return [{ name: 'Bitcoin', price: 91000, volume: 2e9 }];
      }
      return [];
    },
    async () => '{"reads":[{"tool":"markets__search_docs","args":{"query":"markets"}}],"why":"docs"}',
    async (mission) => {
      missions.push(mission);
      assert.match(mission, /async function run\(client\)/);
      assert.match(mission, /INTERDIT/);
      assert.match(mission, /client\.coins\.markets\.get/);
      if (missions.length === 1) {
        return 'async function run(client) {\n  const x = await client.search_docs.get();\n  return x;\n}';
      }
      assert.match(mission, /Échec précédent|search_docs/);
      return 'async function run(client) {\n  const rows = await client.coins.markets.get({ vs_currency: "usd" });\n  return rows;\n}';
    },
  );
  assert.equal(missions.length, 2);
  assert.equal(calls, 2);
  assert.equal(offer.canBuild, true);
  assert.equal(offer.samples[0]?.rows[0]?.price, 91000);
});
