import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionedServers, type SourceTool } from '../src/app-agents/ingest.ts';
import { docsMismatchIntent, reviewSource, thinkAboutDemand } from '../src/agent/engine/product-owner.ts';

const demo: SourceTool = { id: 'demo__get_weather', name: 'get_weather', serverName: 'Démo locale', write: false, inputSchema: {} };
const gecko: SourceTool = {
  id: 'coingecko__search_docs', name: 'search_docs', serverName: 'CoinGecko', write: false,
  inputSchema: { required: ['query', 'language'], properties: { query: { type: 'string' }, language: { type: 'string' } } },
};
const exec: SourceTool = {
  id: 'coingecko__execute', name: 'execute', serverName: 'CoinGecko', write: false,
  inputSchema: { required: ['code'], properties: { code: { type: 'string' } } },
};

const prompt = 'Avec le MCP CoinGecko, utilise search_docs puis execute pour le top 10 et le prix BTC. N\'utilise pas le serveur de démo.';

const solana = `Avec le MCP CoinGecko, utilise d'abord search_docs pour trouver les méthodes "coins markets", "coin by id" et "market chart". Utilise ensuite execute pour récupérer, en EUR, les données de Solana (prix, capitalisation, variation sur 24 h et sur 7 jours, volume, plus haut historique), le prix de Solana sur 30 jours, et le top 10 des cryptos par capitalisation. Crée ensuite un dashboard "Solana en direct". En haut, mets 4 cartes : prix du SOL, variation 24 h, volume 24 h et écart avec le plus haut historique en %. Au milieu, mets une courbe du SOL sur 30 jours. En bas, mets le tableau du top 10 avec la ligne Solana mise en évidence. Affiche l'heure de la dernière mise à jour. N'utilise pas le serveur de démo.`;

test('la demande écarte la démo et retient CoinGecko', () => {
  const { use, skip } = mentionedServers(prompt, [demo, gecko, exec]);
  assert.ok(use.includes('coingecko'));
  assert.ok(skip.includes('demo'));
});

test('chaîne de pensée : dashboard live ≠ catalogue de docs', () => {
  const thought = thinkAboutDemand(solana);
  assert.equal(thought.needsLiveData, true);
  assert.equal(thought.needsDocsCatalog, false);
  assert.equal(thought.needsTimeSeries, true);
  assert.equal(thought.needsRanking, true);
  assert.match(thought.subject, /solana/i);
  assert.match(thought.ui, /cartes|courbe|tableau/i);
  assert.ok(docsMismatchIntent(thought, ['method', 'summary', 'description']));
  assert.equal(docsMismatchIntent(thought, ['price', 'volume', 'change_24h']), false);
});

test('le Product Owner refuse la démo quand CoinGecko est demandé', () => {
  const verdict = reviewSource(prompt, [demo, gecko], [
    { tool: 'demo__get_weather', args: {}, ok: true, rows: [{ jour: 1, min_c: -1, max_c: 4 }] },
  ]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.text, /chaîne de pensée|Product Owner/);
  assert.match(verdict.text, /coingecko|attendu|refus/i);
});

test('le Product Owner refuse une doc quand la demande veut des prix', () => {
  const verdict = reviewSource(prompt, [gecko, exec], [
    { tool: 'coingecko__search_docs', args: { query: 'markets', language: 'en' }, ok: true, rows: [{ method: 'client.coins.markets.get', endpoint: 'GET /coins/markets', summary: 'Marchés' }] },
  ]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.text, /documentation|mesures|intention|execute/i);
  assert.match(verdict.text, /chaîne de pensée/);
});

test('Solana en direct : refuse un écran method/summary', () => {
  const verdict = reviewSource(solana, [gecko, exec], [
    {
      tool: 'coingecko__search_docs', args: {}, ok: true,
      rows: [
        { method: 'client.coins.markets.get', summary: 'markets', description: 'list' },
        { method: 'client.coins.marketChart.get', summary: 'chart', description: 'history' },
      ],
    },
  ]);
  assert.equal(verdict.ok, false);
  assert.match(verdict.text, /écart intention|documentation|Solana|cartes/i);
  assert.match(verdict.text, /Interdit de poser un dashboard/);
});

test('le Product Owner renvoie les acquisitions manquantes au sourcing', () => {
  const verdict = reviewSource('Affiche le prix et le volume.', [exec], [
    { tool: 'coingecko__execute', args: {}, ok: true, rows: [{ name: 'Nord', price: 12 }] },
  ]);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.retryable, true);
  assert.ok(verdict.missing.some((item) => /volume/i.test(item)));
  assert.match(verdict.text, /Acquisitions manquantes/);
  assert.match(verdict.text, /avant un refus définitif/);
});

test('le Product Owner accepte des mesures CoinGecko', () => {
  const verdict = reviewSource(prompt, [gecko, exec], [
    { tool: 'coingecko__execute', args: {}, ok: true, rows: [{ name: 'Bitcoin', price: 90000, change_24h: 1.2, volume: 1e9 }] },
  ]);
  assert.equal(verdict.ok, true);
  assert.match(verdict.text, /acceptées/);
  assert.match(verdict.text, /chaîne de pensée/);
  assert.equal(verdict.samples[0]?.rows[0]?.price, 90000);
});
