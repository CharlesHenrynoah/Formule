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

test('une date nichée sous un autre nom que commit est gardée', () => {
  const seed = seedFromSamples(`export const tools = { a: { run: (_a, db) => db.list('alerts') } };`, [
    { tool: 'demo__list_alerts', result: [{ id: '1', node: { created_at: '2026-04-01T00:00:00Z', title: 'Alerte' } }] },
  ]);
  assert.equal(seed.alerts[0].title, 'Alerte');
  assert.equal(seed.alerts[0].date, '2026-04-01T00:00:00Z');
  assert.equal(seed.alerts[0].createdAt, '2026-04-01T00:00:00Z');
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

test('les lignes d\'un outil quelconque remplissent la collection qui porte son nom', () => {
  const seed = seedFromSamples(`export const tools = { a: { run: (_a, db) => db.list('remote__search_docs') } };`, [
    { tool: 'remote__search_docs', result: [{ method: 'client.markets.get', endpoint: 'GET /markets', summary: 'Marchés' }] },
  ]);
  assert.equal(seed.remote__search_docs[0].method, 'client.markets.get');
  assert.equal(seed.remote__search_docs[0].endpoint, 'GET /markets');
});

test('un texte renvoyé par n\'importe quel outil devient les lignes de la collection lue', () => {
  const seed = seedFromSamples(`export const tools = { a: { run: (_a, db) => db.list('pages') } };`, [
    { tool: 'wiki__read', result: 'Available pages\n- Routing\n- Data fetching' },
  ]);
  assert.equal(seed.pages.length, 3);
  assert.equal(seed.pages[1].label, 'Routing');
});

test('une collection canonique ne reçoit pas des lignes qui n\'en sont pas', () => {
  const seed = seedFromSamples(`export const tools = { a: { run: (_a, db) => db.list('profil') } };`, [
    { tool: 'remote__read', result: [{ price: 1, volume: 2 }] },
  ]);
  assert.equal(seed.profil, undefined);
  assert.equal(seed.read[0].price, 1);
});

test('les lignes d\'un autre serveur ne remplissent pas la collection', () => {
  const src = `export const tools = { a: { run: (_a, db) => db.list('coingecko__search_docs') } };`;
  const seed = seedFromSamples(src, [
    { tool: 'demo__get_weather', result: [{ jour: 1, min_c: -1, max_c: 4, condition: 'Venteux' }] },
    { tool: 'coingecko__search_docs', result: [{ method: 'client.coins.markets.get', endpoint: 'GET /coins/markets', summary: 'Marchés' }] },
  ]);
  assert.equal(seed.coingecko__search_docs.length, 1);
  assert.equal(seed.coingecko__search_docs[0].method, 'client.coins.markets.get');
  assert.equal(seed.coingecko__search_docs[0].condition, undefined);
});
