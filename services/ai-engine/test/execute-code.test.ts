import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyShapeError,
  dualCallExamples,
  ensureRunClient,
  executeCodePrompt,
  findCodeTool,
  hybridCallExample,
  inferCallShape,
  mcpMetaNames,
  objectCallExample,
  paramsList,
  rewriteCallsFromDiagnostics,
  sdkHintsFromDocs,
  shapeFromExample,
  stripCodeFence,
} from '../src/agent/engine/execute-code.ts';
import type { SourceTool } from '../src/app-agents/ingest.ts';

const docs: SourceTool = {
  id: 'markets__search_docs', name: 'search_docs', serverName: 'Markets API', write: false,
  inputSchema: { required: ['query'], properties: { query: { type: 'string' } } },
};
const exec: SourceTool = {
  id: 'markets__execute', name: 'execute', serverName: 'Markets API', write: false,
  description: 'Run SDK code',
  inputSchema: { required: ['code'], properties: { code: { type: 'string' } } },
};
const other: SourceTool = {
  id: 'demo__get_weather', name: 'get_weather', serverName: 'Demo', write: false,
  inputSchema: { required: [], properties: {} },
};

test('mcpMetaNames liste les outils du serveur, pas les autres', () => {
  assert.deepEqual(mcpMetaNames([docs, exec, other], 'markets').sort(), ['execute', 'search_docs']);
});

test('le chemin vient de l’endpoint, pas d’une marque', () => {
  assert.equal(inferCallShape(['id: string;', 'flag?: boolean;']), 'hybrid');
  assert.equal(inferCallShape(['query: string;', 'limit?: number;']), 'object');
  const params = ['owner: string;', 'repo: string;', 'state?: string;'];
  const endpoint = 'GET /repos/{owner}/{repo}/issues';
  assert.equal(inferCallShape(params, endpoint), 'hybrid');
  assert.match(hybridCallExample('client.repos.issues.list', params, endpoint), /list\('…', '…', \{ state:/);
});

test('l’exemple SDK impose la forme, pour n’importe quelle méthode', () => {
  const example = "const page = await client.records.history.get('id', {\n  window: 'window',\n});";
  assert.equal(shapeFromExample(example), 'hybrid');
  assert.equal(shapeFromExample('await client.records.list({ filter: \'filter\' });'), 'object');
  const hints = sdkHintsFromDocs([{
    method: 'client.records.history.get',
    endpoint: 'GET /records/{id}/history',
    params: ['id: string;', 'window: string;'],
    example,
    summary: 'history',
  }]);
  assert.match(hints[0]?.example ?? '', /exemple SDK/);
  assert.match(hints[0]?.example ?? '', /history\.get\('…', \{/);
  assert.doesNotMatch(hints[0]?.example ?? '', /préféré → await client\.records\.history\.get\(\{ id:/);
});

test('dual examples montrent hybride et objet (dyad)', () => {
  const list = paramsList(['id: string;', 'market_data?: boolean;']);
  assert.equal(inferCallShape(list), 'hybrid');
  assert.match(hybridCallExample('client.coins.getID', list), /getID\('…', \{/);
  assert.match(objectCallExample('client.coins.getID', list), /getID\(\{ id:/);
  assert.match(dualCallExamples('client.coins.getID', list), /préféré/);
});

test('rewrite : un objet de trop sort les paramètres de chemin, méthode quelconque', () => {
  const one = `async function run(client) {
  return await client.records.history.get({ id: 'alpha', window: '30' });
}`;
  const fixedOne = rewriteCallsFromDiagnostics(one, 'Expected 2-3 arguments, but got 1.');
  assert.match(fixedOne!, /history\.get\('alpha', \{ window: '30' \}\)/);
  const two = `async function run(client) {
  return await client.repos.issues.list({ owner: 'acme', repo: 'web', state: 'open' });
}`;
  const fixedTwo = rewriteCallsFromDiagnostics(two, 'Expected 3-4 arguments, but got 1.');
  assert.match(fixedTwo!, /issues\.list\('acme', 'web', \{ state: 'open' \}\)/);
});

test('rewrite : objet → string first (getID)', () => {
  const code = `async function run(client) {
  const d = await client.coins.getID({ id: 'solana', market_data: true, sparkline: false });
  return [d];
}`;
  const err = "Argument of type '{ id: string; market_data: boolean }' is not assignable to parameter of type 'string'.";
  assert.equal(classifyShapeError(err), 'want_string_first');
  const fixed = rewriteCallsFromDiagnostics(code, err);
  assert.ok(fixed);
  assert.match(fixed!, /getID\('solana', \{/);
  assert.doesNotMatch(fixed!, /getID\(\{\s*id:/);
});

test('rewrite : Did you mean property', () => {
  const code = 'const x = coin.price_change_percentage_7d;';
  const err = "Property 'price_change_percentage_7d' does not exist on type 'X'. Did you mean 'price_change_percentage_24h'?";
  const fixed = rewriteCallsFromDiagnostics(code, err);
  assert.match(fixed!, /price_change_percentage_24h/);
});

test('executeCodePrompt accepte hybride + objet', () => {
  const mission = executeCodePrompt({
    prompt: 'top 10 et prix',
    tool: exec,
    docs: [{
      method: 'client.coins.getID',
      params: 'id: string; | market_data?: boolean;',
      example: dualCallExamples('client.coins.getID', ['id: string;', 'market_data?: boolean;']),
    }],
    metaNames: ['search_docs', 'execute'],
    lastError: "Argument of type '{ id: string }' is not assignable to parameter of type 'string'.",
  });
  assert.match(mission, /deux conventions, pour n’importe quel SDK/);
  assert.match(mission, /paramètre de chemin/);
  assert.match(mission, /client\.ressource\.action/);
});

test('ensureRunClient et stripCodeFence', () => {
  assert.match(ensureRunClient('return [];'), /async function run\(client\)/);
  assert.equal(stripCodeFence('```js\nasync function run(client) {}\n```'), 'async function run(client) {}');
});

test('findCodeTool respecte preferred et skip', () => {
  assert.equal(findCodeTool([docs, exec, other], ['markets'], [])?.id, 'markets__execute');
  assert.equal(findCodeTool([docs, exec], [], ['markets']), undefined);
});

test('sdkHintsFromDocs dual example', () => {
  const hints = sdkHintsFromDocs([{
    method: 'client.coins.getID',
    params: ['id: string;', 'market_data?: boolean;'],
    summary: 'coin',
  }]);
  assert.match(hints[0]?.example ?? '', /préféré/);
});
