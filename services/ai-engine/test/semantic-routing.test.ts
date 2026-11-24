import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argsForTool, type SourceTool } from '../src/app-agents/ingest.ts';
import { classifySearch, profileTool } from '../src/agent/engine/capabilities.ts';
import { hitsInRows, linkChain } from '../src/agent/engine/chain.ts';
import { findCodeTool } from '../src/agent/engine/execute-code.ts';
import { readsFromSelector } from '../src/agent/engine/select-mcp.ts';
import { collectSource } from '../src/agent/engine/source-offer.ts';

const codeSchema = { required: ['code'], properties: { code: { type: 'string', description: 'Source à transmettre' } } };

const execute: SourceTool = {
  id: 'atlas__execute', name: 'execute', serverName: 'Atlas', write: false,
  description: 'Runs JavaScript code to interact with the API',
  inputSchema: codeSchema,
};
const validate: SourceTool = {
  id: 'atlas__validate_workflow', name: 'validate_workflow', serverName: 'Atlas', write: false,
  description: 'Validate workflow SDK code before creating or updating.',
  inputSchema: codeSchema,
};

test('le même schéma code ne donne pas la même capacité', () => {
  assert.equal(profileTool(execute).capability, 'SDK_EXECUTE');
  assert.equal(profileTool(validate).capability, 'VALIDATE');
  assert.match(profileTool(validate).reasons.join(' '), /preuve insuffisante/);
  assert.equal(findCodeTool([validate, execute], [], [])?.id, 'atlas__execute');
  assert.equal(findCodeTool([validate], [], []), undefined);
  const create: SourceTool = {
    id: 'atlas__create_item', name: 'create_item', serverName: 'Atlas', write: true,
    description: 'Create an item from validated code.',
    inputSchema: codeSchema,
  };
  assert.equal(profileTool(create).capability, 'WRITE');
  assert.equal(readsFromSelector('{"reads":[{"tool":"atlas__validate_workflow","args":{"code":"return []"}}]}', [validate, execute], 'lire les workflows').length, 0);
});

test('un MCP inconnu n’est pas un exécuteur parce qu’il a un paramètre code', () => {
  const unknown: SourceTool = {
    id: 'zodiac__cast', name: 'cast', serverName: 'Zodiac', write: false,
    description: '',
    inputSchema: codeSchema,
  };
  assert.equal(profileTool(unknown).capability, 'READ');
  assert.equal(findCodeTool([unknown], [], []), undefined);
});

test('une entité se prouve par une valeur et son identifiant de ligne', () => {
  const rows = [{ id: 'wf_9', name: 'Publicis', description: 'campagnes', active: true }, { id: 'wf_2', name: 'Archive', description: 'froid' }];
  const hits = hitsInRows(rows, ['Publicis'], 'box__search_items');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.rowId, 'wf_9');
  assert.equal(hits[0]?.field, 'name');
  const held = linkChain('Affiche les workflows Publicis', ['id', 'name', 'description', 'active'], { hits });
  assert.equal(held.links.find((link) => link.text === 'Publicis')?.state, 'tenu');
  assert.match(held.links.find((link) => link.text === 'Publicis')?.field ?? '', /name#wf_9/);
  const open = linkChain('Affiche les workflows Publicis', ['id', 'name', 'description', 'active']);
  assert.equal(open.links.find((link) => link.text === 'Publicis')?.state, 'ouvert');
  assert.equal(open.ok, false);
});

test('un filtre optionnel reçoit l’entité quand sa description le permet', () => {
  const search: SourceTool = {
    id: 'box__search_items', name: 'search_items', serverName: 'Box', write: false,
    inputSchema: { properties: { query: { type: 'string', description: 'Filter by name or description' }, limit: { type: 'number', description: 'Limit' } } },
  };
  const language: SourceTool = {
    id: 'box__search_items', name: 'search_items', serverName: 'Box', write: false,
    inputSchema: { properties: { query: { type: 'string', description: 'Language code' } } },
  };
  assert.equal(argsForTool(search, 'Montre les notes Publicis')?.query, 'Publicis');
  assert.equal(argsForTool(language, 'Montre les notes Publicis')?.query, undefined);
});

test('une recherche vide est une absence, pas une demande de code', () => {
  const empty = classifySearch({ ok: true, rows: [], args: { query: 'Publicis' }, properties: { query: {} }, needle: 'Publicis' });
  assert.equal(empty.gap, 'absence');
  const page = classifySearch({
    ok: true,
    rows: [{ id: '1', name: 'Autre' }],
    args: { query: 'Publicis' },
    properties: { query: {}, cursor: {} },
    needle: 'Publicis',
  });
  assert.equal(page.gap, 'pagination');
  const technical = classifySearch({ ok: false, rows: [], args: { query: 'Publicis' }, needle: 'Publicis' });
  assert.equal(technical.gap, 'erreur');
  const partial = classifySearch({ ok: true, rows: [{ id: '1', name: 'Autre' }], args: {}, properties: { query: {} }, needle: 'Publicis' });
  assert.equal(partial.gap, 'incomplet');
});

test('le scénario workflows ne rappelle pas l’outil de validation', async () => {
  const calls: string[] = [];
  const search: SourceTool = {
    id: 'n8n__search_workflows', name: 'search_workflows', serverName: 'n8n', write: false,
    description: 'Search for workflows with optional filters.',
    inputSchema: { properties: { query: { type: 'string', description: 'Filter by name or description' }, limit: { type: 'number', description: 'Limit the number of results' } } },
  };
  const checker: SourceTool = {
    id: 'n8n__validate_workflow', name: 'validate_workflow', serverName: 'n8n', write: false,
    description: 'Validate workflow SDK code. Required before creating workflows from code.',
    inputSchema: codeSchema,
  };
  const offer = await collectSource(
    'Crée une interface avec les workflows Publicis',
    '',
    async () => [checker, search].map((tool) => ({ id: tool.id, description: tool.description, serverName: tool.serverName, schema: tool.inputSchema })),
    async (tool, args) => {
      calls.push(tool);
      assert.equal(tool, 'n8n__search_workflows');
      assert.equal(args.query, 'Publicis');
      return [{ id: 'wf_9', name: 'Publicis', description: 'campagnes', active: true }, { id: 'wf_2', name: 'Archive', active: false }];
    },
    async () => 'agent sans lecture',
    async () => { throw new Error('aucun code pour une lecture'); },
  );
  assert.deepEqual(calls, ['n8n__search_workflows']);
  assert.equal(offer.canBuild, true);
  assert.match(offer.log, /VALIDATE/);
  assert.match(offer.log, /name#wf_9/);
  assert.equal(offer.samples[0]?.rows[0]?.name, 'Publicis');
  assert.equal(offer.samples[0]?.rows.some((row) => row.name === 'Archive'), false);
});

test('une recherche filtrée sans correspondance ne génère pas de code', async () => {
  const calls: string[] = [];
  let wrote = 0;
  const offer = await collectSource(
    'Crée une interface avec les workflows Publicis',
    '',
    async () => ([
      { id: 'n8n__validate_workflow', description: 'Validate workflow SDK code', serverName: 'n8n', schema: codeSchema },
      { id: 'n8n__search_workflows', description: 'Search for workflows with optional filters.', serverName: 'n8n', schema: { properties: { query: { type: 'string', description: 'Filter by name or description' } } } },
    ]),
    async (tool) => {
      calls.push(tool);
      return [];
    },
    async () => '',
    async () => { wrote += 1; return 'async function run(client) { return []; }'; },
  );
  assert.deepEqual(calls, ['n8n__search_workflows']);
  assert.equal(wrote, 0);
  assert.equal(offer.canBuild, false);
  assert.match(offer.text, /absence confirmée/);
  assert.doesNotMatch(offer.text, /validate_workflow/);
});

test('CoinGecko : la mesure part vers l’exécuteur SDK, pas vers la validation', async () => {
  const calls: string[] = [];
  const offer = await collectSource(
    'Affiche le prix.',
    '',
    async () => ([
      { id: 'coingecko__validate_market', description: 'Validate market payload before submit', serverName: 'CoinGecko', schema: codeSchema },
      { id: 'coingecko__execute', description: 'Runs JavaScript code to interact with the API', serverName: 'CoinGecko', schema: codeSchema },
    ]),
    async (tool, args) => {
      calls.push(tool);
      assert.match(String(args.code ?? ''), /async function run/);
      return [{ price: 80 }];
    },
    async () => '',
    async () => 'async function run(client) { return client.coins.markets.get({ vs_currency: "eur" }); }',
  );
  assert.deepEqual(calls, ['coingecko__execute']);
  assert.equal(offer.canBuild, true);
  assert.equal(offer.samples[0]?.rows[0]?.price, 80);
});

test('GitHub : une entité absente ne bascule pas vers un outil de validation', async () => {
  const calls: string[] = [];
  let wrote = 0;
  const offer = await collectSource(
    'Montre le tableau des issues du dépôt acme/widgets pour Orion.',
    '',
    async () => ([
      { id: 'github__validate_repo', description: 'Validate repository code before a commit', serverName: 'GitHub', schema: codeSchema },
      { id: 'github__list_issues', description: 'List issues in a repository', serverName: 'GitHub', schema: { required: ['owner', 'repo'], properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } } } },
    ]),
    async (tool, args) => {
      calls.push(`${tool}:${args.owner ?? ''}/${args.repo ?? ''}`);
      return [{ title: 'bug', state: 'open' }];
    },
    async () => '',
    async () => { wrote += 1; return 'async function run(client) { return []; }'; },
  );
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((call) => call.startsWith('github__list_issues:acme/widgets')));
  assert.equal(wrote, 0);
  assert.equal(offer.canBuild, false);
  assert.match(offer.log, /VALIDATE/);
  assert.match(offer.text, /recherche incomplète/);
  assert.doesNotMatch(calls.join(' '), /validate/);
});
