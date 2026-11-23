import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestEmptyCollections, repoInText } from '../src/app-agents/ingest.ts';

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
