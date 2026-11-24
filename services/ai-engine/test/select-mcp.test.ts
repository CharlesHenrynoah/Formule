import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readsFromSelector, selectorPrompt } from '../src/agent/engine/select-mcp.ts';
import type { SourceTool } from '../src/app-agents/ingest.ts';

const wiki: SourceTool = {
  id: 'deepwiki__read_wiki_structure', name: 'read_wiki_structure', serverName: 'DeepWiki', write: false,
  inputSchema: { required: ['repoName'], properties: { repoName: { type: 'string' } } },
};
const github: SourceTool = { id: 'github__list_issues', name: 'list_issues', serverName: 'GitHub', write: false, inputSchema: { required: ['owner', 'repo'], properties: {} } };

test('le sélecteur ne garde qu’un outil qui existe et recopie le dépôt de la demande', () => {
  const answer = '{"reads":[{"tool":"deepwiki__read_wiki_structure","args":{"repoName":"inception-ai/website"}},{"tool":"inconnu__list","args":{}}]}';
  const reads = readsFromSelector(answer, [github, wiki], 'Interface DeepWiki du dépôt vercel/next.js');
  assert.equal(reads.length, 1);
  assert.equal(reads[0]?.tool, 'deepwiki__read_wiki_structure');
  assert.equal(reads[0]?.args.repoName, 'vercel/next.js');
});

test('la mission du sélecteur nomme chaque serveur', () => {
  const mission = selectorPrompt('avec Deep Wiki', [wiki, github]);
  assert.match(mission, /DeepWiki/);
  assert.match(mission, /GitHub/);
  assert.match(mission, /deepwiki__read_wiki_structure/);
  assert.match(mission, /intention|Intention/i);
});

test('la mission du sélecteur guide vers des mesures crypto, pas la démo', () => {
  const demo: SourceTool = {
    id: 'demo__get_weather', name: 'get_weather', serverName: 'Démo locale', write: false,
    inputSchema: { required: [], properties: {} },
  };
  const gecko: SourceTool = {
    id: 'coingecko__execute', name: 'execute', serverName: 'CoinGecko', write: false, description: 'Run CoinGecko SDK code',
    inputSchema: { required: ['code'], properties: { code: { type: 'string' } } },
  };
  const mission = selectorPrompt('affiche le top 10 crypto et le prix BTC', [demo, gecko]);
  assert.match(mission, /moteur interchangeable|véhicule/i);
  assert.match(mission, /démo|demo/i);
  assert.match(mission, /execute/);
  assert.match(mission, /CoinGecko/);
});

test('le sélecteur écarte un nom et une URL qui violent le schéma', () => {
  const verify: SourceTool = {
    id: 'n8n__verify_agent_mcp_server', name: 'verify_agent_mcp_server', serverName: 'n8n', write: false,
    inputSchema: {
      required: ['name', 'url'],
      properties: {
        name: { type: 'string', maxLength: 64, pattern: '^[a-zA-Z0-9_-]+$' },
        url: { anyOf: [{ type: 'string', format: 'uri' }] },
      },
    },
  };
  const answer = '{"reads":[{"tool":"n8n__verify_agent_mcp_server","args":{"name":"Crée une interface n8n qui liste les workflows","url":"pas une url"}}]}';
  assert.equal(readsFromSelector(answer, [verify], 'interface n8n').length, 0);
});
