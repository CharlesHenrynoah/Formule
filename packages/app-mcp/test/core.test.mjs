import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileTools, loadBackend, testBackend, parseContract, buildAgentDef, coherence } from '../src/core.mjs';

const SRC = readFileSync(new URL('../../../services/ai-engine/src/mock/smart/monitoring.tools.ts', import.meta.url), 'utf8');
const day = (i) => new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10);
const POINTS = Array.from({ length: 28 }, (_, i) => ({ date: day(i), commandes: i === 24 ? 40 : 120 + (i % 7) * 3, prix_moyen: 42, ca_eur: (i === 24 ? 40 : 120 + (i % 7) * 3) * 42, visiteurs: i === 24 ? 900 : 2300, conversion_pct: 5.2 }));

test('backend monitoring : ingestion, KPIs, anomalies, simulation instantanée, presets, co-DJ', async () => {
  const b = loadBackend(await compileTools(SRC), {});
  const by = Object.fromEntries(b.tools.map((t) => [t.name, t]));
  assert.ok(['ingest_metrics', 'get_kpis', 'detect_anomalies', 'forecast', 'simulate_scenario', 'save_preset', 'suggest_next_move', 'log_action'].every((n) => by[n]));
  assert.equal(by.simulate_scenario.write, false, 'la simulation ne doit pas écrire (recalcul à chaque knob)');
  assert.equal(by.simulate_scenario.kind, 'simulate');
  assert.equal(b.call('ingest_metrics', { points: POINTS }).total, 28);
  b.call('ingest_metrics', { points: POINTS.slice(-2) });
  assert.equal(b.data().metrics.length, 28, 'upsert par date, pas de doublon');
  assert.equal(b.call('get_kpis', {}).statut, 'ok');
  const an = b.call('detect_anomalies', {}).anomalies;
  assert.equal(an.length, 1); assert.equal(an[0].date, day(24)); assert.equal(an[0].cause_probable, 'baisse du trafic');
  const sim = b.call('simulate_scenario', { price_change_pct: 10 });
  assert.ok(sim.ecart_ca_pct < 0 && sim.serie.length === 14);
  assert.equal(b.data().scenarios, undefined);
  b.call('save_preset', { name: 'Hausse douce', params: { price_change_pct: 3 } });
  b.call('save_preset', { name: 'Hausse douce', params: { price_change_pct: 4 } });
  assert.equal(b.call('list_presets', {}).presets.length, 1);
  const moves = b.call('suggest_next_move', { price_change_pct: 10 }).moves;
  assert.ok(moves.some((m) => m.type === 'knob' && m.param === 'price_change_pct'));
  assert.ok(moves.some((m) => m.type === 'pad'));
  assert.throws(() => b.call('simulate_scenario', {}), /requis : price_change_pct/);
});

test('bac à sable : pas de process/require/eval, boucle infinie coupée, rollback', async () => {
  await assert.rejects(async () => loadBackend(await compileTools("import fs from 'fs'; export const tools = { a: { input: {}, run: () => fs } };")), /interdits/);
  const b = loadBackend(await compileTools(`export const tools = {
    esc: { description: 'x', input: {}, run: (_a: any, db: any) => { try { return db.list.constructor('return process')(); } catch (e: any) { return 'bloqué'; } } },
    loop: { description: 'x', input: {}, write: true, run: (_a: any, db: any) => { db.insert('x', { a: 1 }); while (true) {} } },
    ok: { description: 'x', input: {}, run: (_a: any, db: any) => db.count('x') },
  };`));
  assert.equal(b.call('esc', {}), 'bloqué');
  assert.throws(() => b.call('loop', {}), /délai dépassé/);
  assert.equal(b.call('ok', {}), 0, 'écriture annulée après échec');
});

test('contrat : parsing, test du backend, cohérence et définition d’agent', async () => {
  const spec = '# Ventes\n## User stories\n- Je veux…\n## Contrat\n```json\n{"tools":[{"name":"get_kpis","kind":"read","description":"KPIs","input":{}},{"name":"simulate_scenario","kind":"simulate","description":"What-if","input":{"price_change_pct":{"type":"number"}}},{"name":"push_alert","kind":"action","safe":true,"description":"Alerte","input":{}}],"agent":{"name":"Co-DJ","capabilities":["expliquer"]},"charts":["area"],"console":{"knobs":[{"param":"price_change_pct","min":-20,"max":20}],"pads":[{"key":"1","tool":"demo__send_alert","label":"Alerte"}],"refreshSec":2}}\n```\n';
  const c = parseContract(spec);
  assert.equal(c.tools.length, 3); assert.deepEqual(c.agent.tools, ['get_kpis', 'simulate_scenario', 'push_alert']);
  const action = c.tools.find((x) => x.name === 'push_alert');
  assert.ok(action.write && !action.safe, 'une action exige toujours la confirmation');
  assert.equal(c.console.knobs[0].max, 20); assert.equal(c.console.pads[0].key, '1'); assert.equal(c.console.refreshSec, 5);
  c.tools = c.tools.filter((x) => x.name !== 'push_alert'); c.agent.tools = ['get_kpis', 'simulate_scenario'];
  const t = await testBackend(SRC, c);
  assert.ok(t.ok, t.problems.join('; '));
  const bad = await testBackend(SRC, { tools: [{ name: 'archive_task', write: true, input: {} }] });
  assert.ok(!bad.ok && /archive_task/.test(bad.problems[0]));
  const coh = coherence({ contract: c, appCode: "await window.app.call('get_kpis', {}); setInterval(load, 15000); window.addEventListener('keydown', f); import { Slider } from '@/components/ui/slider'; window.agent.ask('x'); import { ChartContainer } from '@/components/ui/chart'", backendTools: t.tools });
  assert.ok(coh.front.ok && coh.backend.ok && coh.agent.ok && coh.usesAgent && coh.usesChart && coh.live && coh.knobs && coh.pads);
  assert.ok(!coherence({ contract: c, appCode: "window.app.call('nope')", backendTools: [] }).front.ok);
  const def = buildAgentDef(c, { title: 'Ventes', spec });
  assert.match(def.instructions, /simulate_scenario \(simulation\)/); assert.match(def.instructions, /CONTREMAÎTRE/); assert.match(def.instructions, /evolve_app/); assert.equal(def.name, 'Co-DJ');
});

test('filtres de lecture (sort, state, perPage) : omissibles, sauf required explicite', async () => {
  const src = `export const tools = {
    get_recent_pull_requests: { kind: 'read', input: { state: { type: 'string' }, sort: { type: 'string' }, perPage: { type: 'number' } }, run: (a: any) => ({ sort: a.sort ?? 'created', state: a.state ?? 'all' }) },
    set_state: { input: { state: { type: 'string', required: true } }, run: (a: any) => a.state },
  };`;
  const b = loadBackend(await compileTools(src), {});
  assert.deepEqual(b.tools.find((t) => t.name === 'get_recent_pull_requests').inputSchema.required, []);
  assert.deepEqual(b.call('get_recent_pull_requests', {}), { sort: 'created', state: 'all' });
  assert.throws(() => b.call('set_state', {}), /requis : state/);
  assert.equal(b.call('set_state', { state: 'all' }), 'all', 'un state exigé reste transmis, même s’il vaut all');
});

test('perPage écrit int accepte le nombre 100 envoyé par l’écran', async () => {
  const src = `export const tools = {
    get_all_pull_requests: { input: { perPage: { type: 'int', optional: true }, page: { type: 'int', optional: true }, sort: { type: 'string', optional: true } },
      run: (a: any) => ({ perPage: a.perPage, page: a.page, kind: typeof a.perPage }) },
    get_page_text: { input: { perPage: { type: 'string', optional: true } },
      run: (a: any) => ({ perPage: a.perPage, kind: typeof a.perPage }) },
  };`;
  const b = loadBackend(await compileTools(src), {});
  assert.equal(b.tools.find((t) => t.name === 'get_all_pull_requests').inputSchema.properties.perPage.type, 'integer');
  assert.deepEqual(b.call('get_all_pull_requests', { perPage: 100, page: '1', sort: 'created' }), { perPage: 100, page: 1, kind: 'number' });
  assert.deepEqual(b.call('get_page_text', { perPage: 100 }), { perPage: 100, kind: 'number' });
});

test('une liste nommée est recopiée sous chaque nom que l’écran peut lire', async () => {
  const src = `export const tools = {
    get_open_issues: { input: {}, run: () => ({ issues: [{ number: 285, state: 'open', created_at: '2013-08-21T21:41:26Z', user: { login: 'sophiebits' } }], totalCount: 1 }) },
    get_commits: { input: {}, run: () => ({ commits: [{ sha: 'abc', author: { login: 'acdlite' } }], contributors: ['acdlite'] }) },
    get_open_pull_requests: { input: {}, run: () => ({ pullRequests: [], issues: [{ number: 1 }] }) },
    get_items: { input: {}, run: () => ({ items: [{ createdAt: '2026-11-21T00:00:00Z' }] }) },
  };`;
  const b = loadBackend(await compileTools(src), {});
  const issues = b.call('get_open_issues', {});
  assert.equal(issues.items.length, 1);
  assert.equal(issues.pullRequests[0].number, 285);
  assert.equal(issues.commits[0].createdAt, '2013-08-21T21:41:26Z');
  assert.equal(issues.items[0].created_at, '2013-08-21T21:41:26Z');
  assert.equal(issues.items[0].author.login, 'sophiebits');
  const commits = b.call('get_commits', {});
  assert.equal(commits.items[0].sha, 'abc');
  assert.equal(commits.issues[0].user.login, 'acdlite');
  assert.deepEqual(commits.contributors, ['acdlite']);
  const openPr = b.call('get_open_pull_requests', {});
  assert.equal(openPr.pullRequests.length, 0, 'une liste vide déjà nommée reste vide');
  assert.equal(openPr.items[0].number, 1);
  const dated = b.call('get_items', {});
  assert.equal(dated.issues[0].created_at, '2026-11-21T00:00:00Z');
});

test('un objet profil et un total sous un autre nom restent lisibles par l’écran', async () => {
  const src = `export const tools = {
    get_profil: { input: {}, run: () => ({ login: 'ada', 'details.name': 'Ada', 'details.public_repos': 4 }) },
    agreger: { input: {}, run: () => ({ items: [{ week: '2026-11-16', count: 3, language: 'TypeScript' }], totalCount: 3 }) },
    somme: { input: {}, run: () => ({ total: 12 }) },
  };`;
  const b = loadBackend(await compileTools(src), {});
  const profil = b.call('get_profil', {});
  assert.equal(profil.items[0].login, 'ada');
  assert.equal(profil.items[0].details.name, 'Ada');
  assert.equal(profil.items[0].details.public_repos, 4);
  const agg = b.call('agreger', {});
  assert.equal(agg.total, 3);
  assert.equal(agg.items[0].semaine, '2026-11-16');
  assert.equal(agg.items[0].nombre, 3);
  assert.equal(agg.items[0].lang, 'TypeScript');
  assert.equal(b.call('somme', {}).totalCount, 12);
});

test('state all est l’absence de filtre, pas un état nommé all', async () => {
  const src = `export const tools = {
    list_issues: { input: { state: { type: 'string', optional: true }, page: { type: 'integer', optional: true } },
      run: (a: any, db: any) => db.list('issues').filter((r: any) => !a.state || String(r.state).toLowerCase() === String(a.state).toLowerCase()) },
  };`;
  const b = loadBackend(await compileTools(src), { issues: [{ id: '1', state: 'open' }, { id: '2', state: 'closed' }] });
  assert.equal(b.call('list_issues', { state: 'all', page: '1' }).items.length, 2);
  assert.equal(b.call('list_issues', { state: 'OPEN' }).items.length, 1);
});

test('outils de plateforme : es_set_source / es_get_source (provenance lue par db.getMeta)', async () => {
  const { compileTools, loadBackend, testBackend } = await import('../src/core.mjs');
  const src = `export const tools = { get_kpis: { input: {}, run: (_a, db) => ({ source: db.getMeta('source') ?? null }) } };`;
  const b = loadBackend(await compileTools(src), {});
  assert.deepEqual(b.tools.map((t) => t.name), ['get_kpis', 'es_set_source', 'es_get_source']);
  assert.equal(b.tools.find((t) => t.name === 'es_set_source').safe, true);
  b.call('es_set_source', { source: { workflowId: 'wf', executionId: '882' } });
  assert.deepEqual(b.call('get_kpis', {}), { source: { workflowId: 'wf', executionId: '882' } });
  assert.deepEqual(b.call('es_get_source', {}), { workflowId: 'wf', executionId: '882' });
  assert.deepEqual(b.data().__meta.source.executionId, '882');
  const t = await testBackend(src, { tools: [{ name: 'get_kpis', write: false }] });
  assert.deepEqual(t.tools, ['get_kpis']);
});
