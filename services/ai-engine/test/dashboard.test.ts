import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider } from '../src/providers/mock.ts';
import { buildDashboard } from '../src/dashboards/build.ts';
import {
  INTERPRETER_TIMEOUT_MS, appendChart, applyChart, argsForPrompt, considerSources, dashMode, faceCharts, fallbackSpec, normalizeSpec, promptDensity, shapeRows, targetChart,
} from '../src/dashboards/spec.ts';

const tool = { id: 'demo__get_time', name: 'get_time', description: 'heure courante', write: false, server: 'demo' };
const mcp = {
  async listTools() { return [tool, { ...tool, id: 'demo__list_notes', name: 'list_notes', description: 'notes', write: false }]; },
  async call() { return { data: { items: [{ label: 'matin', value: 3 }, { label: 'soir', value: 1 }] }, ms: 4 }; },
};

test('l’interprète a deux minutes', () => {
  assert.equal(INTERPRETER_TIMEOUT_MS, 120_000);
});

test('shapeRows lit les listes et les objets', () => {
  const rows = shapeRows({ items: [{ name: 'A', count: 2 }] }, 'name', 'count');
  assert.equal(rows[0].label, 'A');
  assert.equal(rows[0].value, 2);
});

test('un graphique remplacé laisse les autres en place', () => {
  const spec = fallbackSpec('revenu', [tool, { id: 'demo__list_notes', description: 'notes', write: false }]);
  assert.equal(spec.charts.length, 2);
  const next = applyChart(spec, { ...spec.charts[0], id: spec.charts[0].id, title: 'Heure', type: 'bar' });
  assert.equal(next.charts[0].title, 'Heure');
  assert.equal(next.charts[1], spec.charts[1]);
  const added = appendChart(next, { ...next.charts[0], id: next.charts[0].id, title: 'Encore' });
  assert.equal(added.charts.length, 3);
  assert.notEqual(added.charts[2].id, added.charts[0].id);
});

test('une question ouvre un tableau, une retouche n’en vise qu’un', () => {
  const spec = fallbackSpec('heure', [tool]);
  assert.equal(dashMode('Quelle heure est-il ?', null), 'create');
  assert.equal(dashMode('nouveau tableau pour les notes', spec), 'create');
  assert.equal(dashMode('ajoute un graphique des notes', spec), 'add');
  assert.equal(dashMode('ajoute un filtre par période', spec), 'filters');
  const named = { ...spec, charts: [{ ...spec.charts[0], title: 'Heure courante' }] };
  assert.equal(targetChart('change le graphique Heure courante en barres', named)?.id, named.charts[0].id);
  assert.equal(dashMode('change le graphique Heure courante en barres', named), 'chart');
});

test('normalizeSpec ignore les outils hors liste', () => {
  const spec = normalizeSpec({ title: 'T', charts: [{ title: 'A', type: 'kpi', tool: 'demo__get_time', x: 'label', y: 'value' }, { title: 'B', tool: 'secret__dump' }] }, ['demo__get_time']);
  assert.equal(spec?.charts.length, 1);
  assert.equal(spec?.charts[0].tool, 'demo__get_time');
});

test('buildDashboard montre le tableau avant la spec, et ne reconstruit qu’un graphique', async () => {
  const events: Array<{ type?: string }> = [];
  const provider = new MockProvider(0);
  const created = await buildDashboard({ prompt: 'Quelle heure est-il ?' }, { provider, mcp, emit: (e) => events.push(e) });
  const types = events.map((e) => e.type);
  assert.ok(types.indexOf('dashboard_open') < types.indexOf('dashboard_spec'));
  assert.ok(types.indexOf('dashboard_layout') < types.indexOf('dashboard_spec'));
  assert.equal(created.mode, 'create');
  assert.ok(created.spec.charts.length >= 1);

  const widened = { ...created.spec, charts: [...created.spec.charts, { ...created.spec.charts[0], id: 'pipeline', title: 'Pipeline commercial' }] };
  const edited = await buildDashboard(
    { prompt: 'change le graphique Pipeline commercial en barres', dashboardId: created.id, spec: widened },
    { provider, mcp, emit: () => {} },
  );
  assert.equal(edited.mode, 'chart');
  assert.equal(edited.id, created.id);
  assert.equal(edited.spec.charts.length, widened.charts.length);
  assert.deepEqual(edited.spec.charts.filter((c) => c.id !== 'pipeline'), widened.charts.filter((c) => c.id !== 'pipeline'));
  assert.equal(edited.spec.charts.find((c) => c.id === 'pipeline')?.id, 'pipeline');
  assert.ok(created.spec.charts.every((c) => c.tool === 'demo__get_time'));
  const ready = events.filter((e) => e.type === 'chart_ready');
  assert.ok(ready.length >= 1);
  assert.ok(types.indexOf('chart_ready') < types.indexOf('dashboard_spec'));
  const roles = events.filter((e) => e.type === 'agent' && (e as { kind?: string }).kind === 'role').map((e) => (e as { role?: string }).role);
  assert.deepEqual(roles.slice(0, 3), ['data', 'po', 'dev']);
});

const demo = [
  { id: 'demo__get_weather', name: 'get_weather', server: 'demo', description: 'Météo actuelle et prévisions 5 jours pour une ville', write: false, inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
  { id: 'demo__get_time', name: 'get_time', server: 'demo', description: 'Heure et date courantes dans un fuseau', write: false, inputSchema: { type: 'object', properties: { timezone: { type: 'string' } } } },
  { id: 'demo__calculate', name: 'calculate', server: 'demo', description: 'Évalue une expression arithmétique', write: false, inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } },
  { id: 'demo__list_notes', name: 'list_notes', server: 'demo', description: 'Liste les notes enregistrées sur le serveur de démo', write: false, inputSchema: { type: 'object', properties: {} } },
];

test('une liste vide ne devient pas une ligne factice', () => {
  assert.deepEqual(shapeRows({ notes: [] }), []);
});

test('la question écarte la météo sans ville et le calcul sans expression', () => {
  const lyon = considerSources('Météo à Lyon', demo);
  assert.deepEqual(lyon.kept.map((k) => k.tool.id), ['demo__get_weather']);
  assert.equal(lyon.kept[0].args.city, 'Lyon');
  const calc = considerSources('calcule 12 * 4', demo);
  assert.equal(calc.kept[0]?.tool.id, 'demo__calculate');
  assert.equal(calc.kept[0]?.args.expression, '12*4');
  const react = considerSources('Un tableau de bord d’activité du dépôt open source facebook/react', demo);
  assert.equal(react.kept.length, 0);
  assert.ok(react.skipped.some((s) => s.tool.id === 'demo__get_weather' && /city/.test(s.reason)));
  assert.equal(argsForPrompt(demo[0], 'Un tableau de bord d’activité du dépôt facebook/react'), null);
});

test('le dépôt demandé est le seul graphique, les autres outils restent dehors', async () => {
  const gh = { id: 'gh__list_commits', name: 'list_commits', server: 'gh', description: 'Commits récents d’un dépôt', write: false, inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } };
  const seen: Array<{ id: string; args: unknown }> = [];
  const events: Array<{ type?: string; chart?: { tool?: string; args?: Record<string, unknown>; title?: string } }> = [];
  const mcp = {
    async listTools() { return [...demo, gh]; },
    async call(id: string, args: unknown) { seen.push({ id, args }); return { data: { commits: [{ sha: 'a', additions: 3 }] }, ms: 2 }; },
  };
  const prompt = 'Un tableau de bord d’activité du dépôt open source facebook/react, à partir du MCP';
  const built = await buildDashboard({ prompt }, { provider: new MockProvider(0), mcp, emit: (e) => events.push(e) });
  assert.ok(built.spec.charts.length >= 2);
  assert.ok(built.spec.charts.every((c) => c.tool === 'gh__list_commits'));
  assert.equal(built.spec.density, promptDensity(prompt).level);
  assert.equal(built.spec.charts[0].args.owner, 'facebook');
  assert.equal(built.spec.charts[0].args.repo, 'react');
  assert.match(built.spec.charts[0].title, /facebook\/react/);
  assert.ok(seen.every((s) => s.id === 'gh__list_commits'));
  assert.equal((seen[0].args as { owner: string }).owner, 'facebook');
  assert.ok(events.some((e) => e.type === 'chart_ready' && e.chart?.tool === 'gh__list_commits'));
  assert.ok(!events.some((e) => e.type === 'chart_ready' && e.chart?.tool === 'demo__get_weather'));
  const said = events.filter((e) => e.type === 'agent').map((e) => JSON.stringify(e)).join('\n');
  assert.match(said, /Question retenue/);
  assert.match(said, /get_weather écarté/);
  assert.match(said, /visage répond/);
});

test('plus la phrase est dense, plus le visage a d’éléments', () => {
  const tool = { id: 'gh__list_commits', name: 'list_commits', description: 'Commits récents d’un dépôt', write: false };
  const sample = new Map([[tool.id, [{ label: 'lun', value: 1 }, { label: 'mar', value: 3 }, { label: 'mer', value: 2 }, { label: 'jeu', value: 5 }]]]);
  const court = 'Activité du dépôt facebook/react';
  const long = 'Montre les commits de la semaine, les issues ouvertes, les pull requests en revue, les étoiles gagnées, et compare avec le mois dernier. Qui contribue le plus ? Quels fichiers bougent ? Où est la tension sur facebook/react ?';
  assert.equal(promptDensity('Quelle heure est-il ?').level, 'calme');
  assert.equal(promptDensity('Quelle heure est-il ?').slots, 1);
  assert.equal(promptDensity(long).level, 'dense');
  assert.ok(promptDensity(long).slots > promptDensity(court).slots);
  const a = faceCharts(court, considerSources(court, [tool]).kept, sample);
  const b = faceCharts(long, considerSources(long, [tool]).kept, sample);
  assert.ok(b.length > a.length);
  assert.ok(b.every((c) => c.tool === tool.id && c.place));
  assert.ok(new Set(b.map((c) => c.type)).size > 1);
});
