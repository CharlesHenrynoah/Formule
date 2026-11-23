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
});
