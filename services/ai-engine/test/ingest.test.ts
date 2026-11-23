import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionsInScreen, ingestEmptyCollections, readsForCollections, repoInText, type SourceTool } from '../src/app-agents/ingest.ts';

const source = `export const tools = {
  lire: { run: (_a, db) => __rows(db, "issues", {}, {}) },
  prs: { run: (_a, db) => __rows(db, "pullRequests", {}, {}) },
};`;

test('un dépôt nommé dans la demande est reconnu', () => {
  assert.deepEqual(repoInText('activité du dépôt facebook/react'), { owner: 'facebook', repo: 'react' });
  assert.equal(repoInText('aucune source'), null);
});

test('une collection vide est remplie depuis GitHub, une collection pleine reste', async () => {
  const db: Record<string, unknown> = { pullRequests: [{ id: 'deja', title: 'locale' }] };
  const filled = await ingestEmptyCollections(source, db, 'facebook/react', async (tool) => {
    if (tool.endsWith('list_issues')) return { issues: [{ number: 4, title: 'Bug', state: 'OPEN', user: { login: 'ada' }, created_at: '2026-11-20T00:00:00Z' }] };
    return { items: [] };
  });
  assert.equal(filled, true);
  const issues = db.issues as Array<Record<string, unknown>>;
  assert.equal(issues.length, 1);
  assert.equal(issues[0].author, 'ada');
  assert.equal(issues[0].repository, 'facebook/react');
  assert.equal((db.pullRequests as unknown[]).length, 1);
  assert.equal((db.pullRequests as Array<{ title: string }>)[0].title, 'locale');
});

const notesSource = `export const tools = { lire: { run: (_a, db) => __rows(db, "notes", {}, {}) } };`;
const notesTool: SourceTool = { id: 'demo__list_notes', name: 'list_notes', write: false, inputSchema: { properties: {} } };
const writeTool: SourceTool = { id: 'demo__insert_notes', name: 'insert_notes', write: true, inputSchema: { properties: {} } };
const cityTool: SourceTool = { id: 'demo__get_weather', name: 'get_weather', write: false, inputSchema: { required: ['city'], properties: { city: {} } } };

test('une collection hors GitHub est remplie par l\'outil en lecture du même nom', async () => {
  const db: Record<string, unknown> = {};
  const called: string[] = [];
  const filled = await ingestEmptyCollections(notesSource, db, 'mes notes de bord', async (tool) => {
    called.push(tool);
    return { notes: [{ id: '1', title: 'Rappel' }] };
  }, { tools: [writeTool, cityTool, notesTool] });
  assert.equal(filled, true);
  assert.deepEqual(called, ['demo__list_notes']);
  assert.equal((db.notes as Array<{ title: string }>)[0].title, 'Rappel');
});

test('l\'écran qui lit data_list nomme la collection même si le backend ne l\'écrit pas', () => {
  const screen = `window.app.call('data_list', { collection: 'alerts' })`;
  assert.deepEqual(collectionsInScreen(screen), ['alerts']);
  const reads = readsForCollections(collectionsInScreen(screen), 'suivi', [
    { id: 'demo__list_alerts', name: 'list_alerts', write: false },
  ]);
  assert.equal(reads.length, 1);
  assert.equal(reads[0].tool, 'demo__list_alerts');
});
