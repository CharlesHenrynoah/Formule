/** Mémoire persistante de la crew + mode incrémental + thème monochrome. */
import { achromeSource, mirrorPaletteClasses } from '../src/agent/theme-guard.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyContractDiff, buildMemory, changedFiles, extractCriteria, fileMap, integrateBackendTools, isIncremental, loadMemory, memoryMarkdown, mergeCriteria, needsNewSource, nextCriterionId, parseContractDiff, retroMemory, saveMemory } from '../src/agent/app-memory.ts';
import { changedLinesExcerpt } from '../src/agent/crew.ts';
import { Workspace } from '../src/agent/workspace.ts';
import { PRODUCT_OWNER_DELTA, DEVELOPER, PRODUCT_OWNER } from '../src/agent/prompts.ts';

const ID = '40c51ca0-c081-4ab4-b2f2-512a6df660cc';
const contract = { entities: [{ name: 'personas', fields: { id: 'string' } }], tools: [{ name: 'get_kpis', kind: 'read', description: 'KPIs', input: {}, write: false, safe: true }, { name: 'save_preset', kind: 'store', description: 'scène', input: { name: { type: 'string' } }, write: true, safe: true }], agent: { name: 'Co-DJ', persona: '', capabilities: [], guardrails: [], tools: ['get_kpis'] }, charts: ['bar : segments'], console: { decks: [], knobs: [{ param: 'w', label: 'W', min: 0, max: 1, step: 0.1, default: 0.5 }], pads: [], refreshSec: 15 }, externalTools: ['n8n__execute_workflow'] };
const spec = `# Radar Personas\n## Critères d'acceptation\n- **CA1** : KPIs au chargement\n- **CA2** : graphique par segment\n## Contrat\n...`;
const files = { 'src/App.tsx': `import { Panel } from '@/components/es/app-shell';\nexport default function App() { return <Panel title="Personas">x</Panel>; }\n`, 'server/tools.ts': `export const tools = {\n  get_kpis: { kind: 'read' },\n  save_preset: { kind: 'store' },\n};\n`, 'src/scenes/radar.ts': `registerScene('sentiment-radar', 'pixi', f);\nexport const f = 1;`, 'src/components/ui/button.tsx': 'x' };

test('critères : extraction, fusion, numérotation à la suite', () => {
  assert.equal(extractCriteria('- **CA9** (v3) : tuile KPI', 4)[0]?.text, 'tuile KPI');
  const c = extractCriteria(spec, 1);
  assert.deepEqual(c.map((x) => x.id), ['CA1', 'CA2']);
  const merged = mergeCriteria(c, extractCriteria('## Nouveaux critères\n- **CA3** : radar polaire', 2));
  assert.deepEqual(merged.map((x) => `${x.id}@v${x.version}`), ['CA1@v1', 'CA2@v1', 'CA3@v2']);
  assert.equal(nextCriterionId(merged), 'CA4');
});

test('carte des fichiers : rôles, sans fichiers du template', () => {
  const m = fileMap(files);
  assert.equal(m[0].path, 'src/App.tsx');
  assert.match(m[0].role, /panneaux : Personas/);
  assert.match(m.find((f) => f.path === 'server/tools.ts')!.role, /get_kpis, save_preset/);
  assert.match(m.find((f) => f.path === 'src/scenes/radar.ts')!.role, /scène pixi sur mesure « sentiment-radar »/);
  assert.ok(!m.some((f) => f.path.startsWith('src/components/ui/')));
});

test('mémoire : construction, schéma OBSERVÉ prioritaire, persistance + CREW.md', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  mkdirSync(join(dir, ID), { recursive: true });
  writeFileSync(join(dir, ID, 'source.json'), JSON.stringify({ server: 'n8n', workflowId: 'dJ6mOIPdIzw7zhc8', node: 'Répondre données' }));
  writeFileSync(join(dir, ID, 'source-schema.json'), JSON.stringify({ executionId: '907', schema: [{ champ: 'segments[].group', type: 'string', exemple: 'Premium' }] }));
  const m1 = buildMemory({ appId: ID, version: 1, prompt: 'Crée un radar', kind: 'generate', spec, brief: 'brief inventé', contract, files, dir });
  assert.equal(m1.brief.schemaStatus, 'observé');
  assert.equal(m1.brief.source?.workflowId, 'dJ6mOIPdIzw7zhc8');
  await saveMemory(m1, dir);
  assert.ok(existsSync(join(dir, ID, 'CREW.md')));
  const md = readFileSync(join(dir, ID, 'CREW.md'), 'utf8');
  assert.match(md, /workflow dJ6mOIPdIzw7zhc8/);
  assert.match(md, /segments\[\]\.group : string/);
  // v2 (évolution) : CA ajoutés, historique, fichiers modifiés
  const files2 = { ...files, 'src/App.tsx': files['src/App.tsx'].replace('x</Panel>', 'y</Panel>') };
  const m2 = buildMemory({ appId: ID, version: 2, prompt: 'Ajoute un radar', kind: 'iterate', mode: 'incrémental', spec: spec + '\n- **CA3** : radar polaire', brief: '', contract, files: files2, prevFiles: files, prev: loadMemory(ID, dir), dir });
  assert.deepEqual(m2.criteria.map((c) => c.id), ['CA1', 'CA2', 'CA3']);
  assert.equal(m2.history.length, 2);
  assert.deepEqual(m2.history[1].filesChanged, ['src/App.tsx']);
  assert.equal(m2.history[1].mode, 'incrémental');
  assert.match(m2.history[1].features[0], /CA3 radar polaire/);
  assert.equal(m2.brief.text, 'brief inventé'); // brief conservé
});

test('mémoire rétroactive à partir du stockage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-'));
  const m = retroMemory(ID, { number: 3, prompt: 'p', plan: spec, files, app: { contract, title: 'Radar' } }, [{ number: 1, kind: 'generate', prompt: 'Crée' }, { number: 3, kind: 'iterate', prompt: 'Ajoute' }], dir);
  assert.equal(m.version, 3);
  assert.equal(m.history.length, 2);
  assert.equal(m.brief.schemaStatus, 'non échantillonné');
  assert.match(memoryMarkdown(m), /ne pas inventer de champs/);
});

test('mode incrémental et besoin de nouvelle source', () => {
  const m = retroMemory(ID, { number: 1, plan: spec, files, app: { contract } }, [], mkdtempSync(join(tmpdir(), 'm-')));
  m.brief.source = { workflowId: 'dJ6mOIPdIzw7zhc8' };
  assert.equal(isIncremental('Ajoute un radar sentiment vs budget', true, m), true);
  assert.equal(isIncremental('Refais toute l\'app from scratch', true, m), false);
  assert.equal(isIncremental('Ajoute un radar', false, m), false);
  assert.equal(needsNewSource('Ajoute un radar', m), false);
  assert.equal(needsNewSource('Connecte aussi le workflow iDWZDxsE0SUTJ59o', m), true);
  assert.equal(needsNewSource('Utilise le workflow dJ6mOIPdIzw7zhc8', m), false);
});

test('contrat par diff + intégration auto des outils du backend appelés par le front', () => {
  const delta = '# Delta — Radar\n## Contrat (diff)\n```json\n{"add_tools":[{"name":"get_segment_radar","kind":"read","description":"radar","input":{"window_days":{"type":"integer"}},"write":false}],"add_charts":["radar : sentiment vs budget"],"agent_tools_add":["get_segment_radar"],"console":{"knobs":[{"param":"window_days","label":"Fenêtre","min":7,"max":90,"step":1,"default":30}]}}\n```\n';
  const diff = parseContractDiff(delta);
  assert.ok(diff);
  const c = applyContractDiff(contract, diff);
  assert.deepEqual(c.tools.map((t: any) => t.name), ['get_kpis', 'save_preset', 'get_segment_radar']);
  assert.equal(c.console.knobs.length, 2);
  assert.ok(c.agent.tools.includes('get_segment_radar'));
  assert.equal(contract.tools.length, 2); // pas de mutation du contrat de base
  const trimmed = applyContractDiff(contract, { remove_charts: ['bar : segments'], add_charts: ['line : revenu'] });
  assert.deepEqual(trimmed.charts, ['line : revenu']);
  const added = integrateBackendTools(c, [{ name: 'get_presets', write: false, safe: true, description: 'liste', input: {} }, { name: 'internal_x', write: false }], ['get_presets']);
  assert.deepEqual(added, ['get_presets']);
  assert.ok(c.tools.some((t: any) => t.name === 'get_presets' && t.kind === 'read'));
});

test('diff de fichiers et extrait des lignes modifiées', () => {
  assert.deepEqual(changedFiles({ 'a.ts': '1', 'b.ts': '2' }, { 'a.ts': '1', 'b.ts': '3', 'c.ts': 'n' }), ['b.ts', 'c.ts']);
  assert.equal(changedLinesExcerpt('a\nb\n', 'a\nb\nc\n'), '3+ c');
});

test('workspace : patch ciblé (find/replace, insertion, ancrage ambigu ou absent), lecture par plage, recherche', async () => {
  const ws = await Workspace.create({ files: { 'src/App.tsx': 'const a = 1;\nconst b = 2;\nexport default function App() { return null; }\n' } });
  const r = await ws.edit('src/App.tsx', [{ find: 'const b = 2;', replace: 'const b = 3;' }, { after: 'const a = 1;', insert: '\nconst c = 4;' }]);
  assert.equal(r.edits, 2);
  const t = await ws.read('src/App.tsx');
  assert.match(t, /const a = 1;\nconst c = 4;\nconst b = 3;/);
  await assert.rejects(() => ws.edit('src/App.tsx', [{ find: 'const', replace: 'let' }]), /ambigu/);
  await assert.rejects(() => ws.edit('src/App.tsx', [{ find: 'const zz = 9;', replace: '' }]), /introuvable/);
  const rr = await ws.readRange('src/App.tsx', 2, 3);
  assert.equal(rr.text, 'const c = 4;\nconst b = 3;');
  assert.equal(rr.from, 2);
  assert.equal(rr.to, 3);
  const hits = await ws.search('CONST C');
  assert.deepEqual(hits, ['src/App.tsx:2: const c = 4;']);
});

test('prompts : spec delta, consignes monochrome', () => {
  assert.match(PRODUCT_OWNER_DELTA, /Contrat \(diff\)/);
  assert.ok(PRODUCT_OWNER_DELTA.includes('${NEXT_CA}'));
  assert.match(DEVELOPER, /COULEURS INVERSÉES/);
  assert.match(DEVELOPER, /@\/components\/es\/theme/);
  assert.match(PRODUCT_OWNER, /fond blanc/);
});

test('thème des apps : noir dominant, séries bleu menthe sable', () => {
  const css = readFileSync(new URL('../agent-template/src/index.css', import.meta.url), 'utf8');
  const room = css.slice(css.indexOf('.control-room {'));
  assert.match(room, /--background: oklch\(0\.13 0 0\)/);
  assert.match(room, /--foreground: oklch\(0\.96 0 0\)/);
  assert.match(room, /--chart-1: oklch\(0\.72 0\.09 240\)/);
  assert.match(room, /--chart-2: oklch\(0\.74 0\.08 165\)/);
  assert.match(room, /--chart-3: oklch\(0\.80 0\.08 85\)/);
  assert.match(room, /--chart-8:/);
  assert.doesNotMatch(room, /--color-white/); // pas d'inversion pour les nouvelles apps
  assert.doesNotMatch(css, /data-es-legacy/); // pas d'inversion globale : elle casserait les composants plateforme clairs
  // apps anciennes : miroir des classes de palette dans le code de l'app uniquement
  const mir = mirrorPaletteClasses(`<div className="bg-black/40 text-white border-zinc-800 hover:text-emerald-300 bg-cyan-500 text-whitesmoke">`);
  assert.equal(mir.code, `<div className="bg-white/40 text-black border-zinc-200 hover:text-emerald-700 bg-cyan-500 text-whitesmoke">`);
  const html = readFileSync(new URL('../agent-template/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /class="dark"/);
  const shell = readFileSync(new URL('../agent-template/src/components/es/app-shell.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(shell, /(cyan|violet|fuchsia|sky)-\d{2,3}|text-(zinc|slate)-[1-3]00|border-white|'dark control-room/);
});

test('le fond coloré devient gris, le trait de série garde sa couleur', () => {
  const r = achromeSource(`<Area stroke="#6eacd7" className="text-blue-400 bg-[#38bdf8]" />`);
  assert.equal(r.changed > 0, true);
  assert.match(r.code, /stroke="#6eacd7"/);
  assert.match(r.code, /text-neutral-400/);
  assert.doesNotMatch(r.code, /#38bdf8|text-blue/);
});

test('garde-fou monochrome : classes arbitraires d\'interface en gris, données intactes', async () => {
  const { monochromeClasses } = await import('../src/agent/theme-guard.ts');
  const src = `<Card className="mb-4 bg-[oklch(0.2_0.04_255)]/60 border-[#22d3ee] shadow-[0_0_8px_rgba(34,211,238,0.6)]" /><Area stroke="#22d3ee" /><div className="bg-[oklch(0.2_0_0)]" />`;
  const r = monochromeClasses(src);
  assert.equal(r.changed, 3);
  assert.match(r.code, /bg-\[oklch\(0\.2_0_0\)\]\/60/);
  assert.doesNotMatch(r.code, /border-\[#22d3ee\]/);
  assert.match(r.code, /rgba\(\d+,\d+,\d+,0\.6\)/);
  assert.match(r.code, /stroke="#22d3ee"/);
  const inv = monochromeClasses(`<div className="bg-[oklch(0.2_0.04_255)] text-[#f5f5f5]" />`, { invert: true });
  assert.match(inv.code, /bg-\[oklch\(0\.920_0_0\)\]/);
  assert.match(inv.code, /text-\[oklch\(0\.1\d\d_0_0\)\]/);
});
