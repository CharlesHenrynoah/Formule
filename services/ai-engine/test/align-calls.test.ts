import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignCalls, alignObserved, interfaceChecklist, poseObservedPage, unknownFieldReads } from '../src/agent/engine/align-calls.ts';

const tools = `export const tools = {
  get_docs_count: { run: (_a, db) => db.list('coingecko__search_docs') },
};`;

test('un outil absent du backend devient data_list', () => {
  const page = `window.app.call('get_docs_by_endpoint').then((r) => r.items);\nwindow.app.call('get_docs_count').then((r) => r.total);`;
  const aligned = alignCalls(page, tools);
  assert.equal(aligned.changed, true);
  assert.match(aligned.code, /call\('data_list', \{ collection: 'coingecko__search_docs' \}\)/);
  assert.match(aligned.code, /get_docs_count/);
  assert.doesNotMatch(aligned.code, /get_docs_by_endpoint/);
});

test('la liste de forme reprend les champs observés et le tableau d\'exemple', () => {
  const text = interfaceChecklist(['method', 'endpoint', 'summary']);
  assert.match(text, /board\.tsx/);
  assert.match(text, /MetricGrid/);
  assert.match(text, /label et count/);
  assert.match(text, /method, endpoint, summary/);
  assert.match(text, /Interdit d'afficher/);
});

test('price et volume absents de la lecture sont détectés', () => {
  const page = `const btc = rows.find((d) => d.method);\nsetBtcPrice(btc.price ?? 0);\nsetBtcVolume(btc.volume ?? 0);`;
  assert.deepEqual(unknownFieldReads(page, ['method', 'endpoint', 'summary']).sort(), ['price', 'volume']);
});

test('une page docs inventée est remplacée seulement si la demande veut un catalogue', () => {
  const page = `export default function App() {
  return (<AppShell><MetricCard label="Prix BTC" value={btc.price} /><BoardSplit></BoardSplit></AppShell>);
}`;
  const samples = [{ tool: 'coingecko__search_docs', rows: [{ method: 'client.coins.markets.get', endpoint: 'GET /coins/markets', summary: 'Marchés' }] }];
  const docsAsk = alignObserved(page, tools, 'Montre la documentation seule : catalogue des méthodes et endpoints API', samples);
  assert.equal(docsAsk.changed, true);
  assert.match(docsAsk.code, /row\.method/);
  assert.doesNotMatch(docsAsk.code, /\.price/);

  const liveAsk = alignObserved(page, tools, 'Dashboard Solana en direct avec prix, volume et courbe 30 jours', samples);
  assert.equal(liveAsk.changed, false);
  assert.equal(liveAsk.code, page);
});

test('une demande qui nomme ses vues ne devient pas une répartition', () => {
  const prompt = 'Crée un dashboard "Solana en direct". Mets 4 cartes : prix, volume. Au milieu, une courbe sur 30 jours. En bas, le tableau du top 10 avec la ligne Solana mise en évidence.';
  const code = poseObservedPage(prompt, 'mesures', ['date', 'price', 'volume', 'name']);
  assert.match(code, /Solana en direct/);
  assert.match(code, /row\.price/);
  assert.match(code, /LineChart/);
  assert.doesNotMatch(code, /Répartition/);
  assert.doesNotMatch(code, /valeurs distinctes/);
});

test('l\'écran observé compose le tableau d\'exemple', () => {
  const code = poseObservedPage('Docs CoinGecko', 'coingecko__search_docs', ['method', 'endpoint', 'summary']);
  assert.match(code, /BoardHeader/);
  assert.match(code, /MetricGrid/);
  assert.match(code, /h-\[260px\]/);
  assert.match(code, /dataKey="label"/);
  assert.match(code, /dataKey="count"/);
  assert.match(code, /row\.summary/);
});
