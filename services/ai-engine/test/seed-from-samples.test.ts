import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedFromSamples } from '../src/agent/seed-from-samples.ts';

const tools = `
export const tools = {
  get_open_issues: { run: (_a, db) => db.list('issues').filter((r) => r.state === 'open' && r.repo === 'react') },
  get_open_pull_requests: { run: (_a, db) => db.list('pullRequests').filter((r) => r.state === 'open') },
};
`;

test('les issues GitHub remplissent la collection lue par le backend', () => {
  const seed = seedFromSamples(tools, [
    { tool: 'github__list_issues', args: { owner: 'facebook', repo: 'react' }, result: { issues: [{ number: 38335, title: 'Bug', state: 'OPEN', created_at: '2026-11-21T04:14:50Z', user: { login: 'ada' } }, { _plus: 10 }] } },
    { tool: 'github__list_pull_requests', args: { owner: 'facebook', repo: 'react' }, result: [{ number: 12, title: 'PR', state: 'OPEN' }] },
  ]);
  assert.equal(seed.issues.length, 1);
  assert.equal(seed.issues[0].state, 'open');
  assert.equal(seed.issues[0].id, '38335');
  assert.equal(seed.issues[0].repo, 'react');
  assert.equal(seed.issues[0].repository, 'facebook/react');
  assert.equal(seed.issues[0].author, 'ada');
  assert.equal(seed.issues[0].createdAt, '2026-11-21T04:14:50Z');
  assert.equal(seed.pullRequests[0].state, 'open');
  assert.equal(seed.pullRequests[0].repo, 'react');
});

test('un profil seul et des dépôts nommés items arrivent dans les collections lues', () => {
  const tools = `
export const tools = {
  get_profil: { run: (_a, db) => { const p = db.get('profil', 'login') || {}; const details = p.details || {}; return { login: p.login, 'details.name': details.name }; } },
  lister_depots: { run: (_a, db) => ({ items: db.list('depots') }) },
  lister_issues_depot: { run: (_a, db) => db.list('issues') },
};
`;
  const seed = seedFromSamples(tools, [
    { tool: 'github__get_me', result: { login: 'CharlesHenrynoah', id: 10146, name: 'Charles', public_repos: 40, bio: 'code' } },
    { tool: 'github__search_repositories', result: { total_count: 2, items: [{ id: 1, name: 'formule', full_name: 'CharlesHenrynoah/formule', language: 'TypeScript', stargazers_count: 3 }] } },
    { tool: 'github__list_issues', args: { owner: 'CharlesHenrynoah', repo: 'formule' }, result: [{ number: 7, title: 'Bug', state: 'OPEN' }] },
  ]);
  assert.equal(seed.profil[0].id, 'login');
  assert.equal(seed.profil[0].login, 'CharlesHenrynoah');
  assert.equal((seed.profil[0].details as { name?: string }).name, 'Charles');
  assert.equal(seed.depots[0].full_name, 'CharlesHenrynoah/formule');
  assert.equal(seed.issues[0].state, 'open');
  assert.equal(seed.issues[0].repo, 'formule');
});

test('pull_requests et pullRequests reçoivent les mêmes lignes', () => {
  const src = `export const tools = { a: { run: (_a, db) => db.list('pull_requests') }, b: { run: (_a, db) => __rows(db, "pullRequests", {}, {}) } };`;
  const seed = seedFromSamples(src, [
    { tool: 'github__list_pull_requests', args: { owner: 'facebook', repo: 'react' }, result: { pull_requests: [{ number: 9, title: 'PR', state: 'closed', merged_at: '2026-11-01T00:00:00Z', user: { login: 'ada' } }] } },
  ]);
  assert.equal(seed.pull_requests[0].repository, 'facebook/react');
  assert.equal(seed.pullRequests[0].state, 'merged');
  assert.equal(seed.pullRequests[0].author, 'ada');
});

test('un commit garde la date et le message nichés dans commit', () => {
  const seed = seedFromSamples(`export const tools = { a: { run: (_a, db) => db.list('commits') } };`, [
    { tool: 'github__list_commits', args: { owner: 'facebook', repo: 'react' }, result: [{ sha: 'abc', author: { login: 'ada' }, commit: { message: 'Fix le graphique', author: { name: 'Ada', date: '2026-11-23T14:31:37Z' } } }] },
  ]);
  assert.equal(seed.commits[0].author, 'ada');
  assert.equal(seed.commits[0].message, 'Fix le graphique');
  assert.equal(seed.commits[0].date, '2026-11-23T14:31:37Z');
  assert.equal(seed.commits[0].createdAt, '2026-11-23T14:31:37Z');
});

test('les issues arrivent dans data_list même si le backend ne nomme pas la collection', () => {
  const seed = seedFromSamples(`export const tools = { total: { run: () => ({ total: 1, totalCount: 1 }) } };`, [
    { tool: 'github__list_issues', result: { issues: [{ number: 4, title: 'Bug', state: 'OPEN' }] } },
  ]);
  assert.equal(seed.issues.length, 1);
  assert.equal(seed.issues[0].id, '4');
  assert.equal(seed.issues[0].state, 'open');
});
