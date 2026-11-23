import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScriptedCrew } from '../src/agent/scripted.ts';
import { Workspace, SHADCN_COMPONENTS } from '../src/agent/workspace.ts';
import { componentsFromSpec, inferSchema } from '../src/agent/events.ts';
import type { McpClient } from '../src/mcp.ts';
import type { RuntimeTool } from '../src/types.ts';

const tools: RuntimeTool[] = [
  { id: 'demo__get_weather', name: 'get_weather', write: false, server: 'demo', description: 'Météo', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } },
  { id: 'demo__add_note', name: 'add_note', write: true, server: 'demo', description: 'Ajoute une note' },
];
const mcp: McpClient = {
  listTools: async () => tools,
  call: async (_t, args) => ({ data: { ville: (args as { city: string }).city, temperature_c: 12, condition: 'Nuageux', previsions: [{ jour: 1, max_c: 14, min_c: 6 }] } }),
};

test('utilitaires : schéma inféré et composants de la spec', () => {
  const s = inferSchema({ a: 1, b: [{ c: 'x' }] });
  assert.deepEqual(s.map((f) => f.champ), ['a', 'b', 'b[]', 'b[].c']);
  assert.deepEqual(componentsFromSpec('## Composants shadcn\ncard, button, foo, tabs\n## Contrat', SHADCN_COMPONENTS), ['card', 'button', 'tabs']);
});

test('workspace : chemins confinés et commandes en liste blanche', { skip: !Workspace.templateReady() }, async () => {
  const ws = await Workspace.create();
  await assert.rejects(ws.write('../evil.ts', 'x'), /refusé/);
  await assert.rejects(ws.write('src/../../evil.ts', 'x'), /refusé/);
  await assert.rejects(ws.write('package.json', '{}'), /refusée/);
  await assert.rejects(ws.read('node_modules/react/package.json'), /refusé/);
  const r = await ws.shadcnAdd(['card; rm -rf /']);
  assert.equal(r.ok, false);
  assert.match(r.output, /refusés/);
});

test('équipe scriptée : Data Engineer → PO → Dev (CLI shadcn + build) → revue', { skip: !Workspace.templateReady(), timeout: 180_000 }, async () => {
  const events: any[] = [];
  const r = await runScriptedCrew({ prompt: 'Une app météo pour Lyon [revue]' }, { mcp, emit: (e) => events.push(e) });
  const a = events.filter((e) => e.type === 'agent');
  const roles = a.filter((e) => e.kind === 'role').map((e) => e.role);
  assert.deepEqual(roles.slice(0, 3), ['data', 'po', 'dev']);
  const brief = a.find((e) => e.kind === 'brief');
  assert.ok(brief.relevant && /demo__get_weather/.test(brief.text) && /\| ville \| string \| "Lyon" \|/.test(brief.text), 'brief données construit depuis un vrai échantillon');
  assert.ok(a.some((e) => e.kind === 'cli' && /^npx shadcn@latest add .*card/.test(e.command) && e.ok), 'CLI shadcn exécutée');
  assert.ok(a.some((e) => e.kind === 'build' && e.ok), 'vite build réussi');
  const reviews = a.filter((e) => e.kind === 'review');
  assert.equal(reviews[0].verdict, 'a_corriger', 'le PO renvoie la 1re version');
  assert.equal(reviews.at(-1).verdict, 'ok');
  assert.equal(r.iterations, 2);
  assert.match(r.code, /^<!doctype html>/i);
  assert.ok(!/<script[^>]+src=/.test(r.code), 'build mono-fichier');
  assert.match(r.files['src/App.tsx'], /mcp\.call\('demo__get_weather'/);
});

test('démo « Console ventes » : AppShell dashboard + chat contremaître, backend MCP cohérent, build vert', { skip: !Workspace.templateReady(), timeout: 240_000 }, async () => {
  const { fakeMetrics } = await import('../../../packages/mcp-demo-server/src/metrics.ts');
  const mtools: RuntimeTool[] = [
    { id: 'demo__get_metrics', name: 'get_metrics', write: false, server: 'demo', description: 'Métriques', inputSchema: { type: 'object', properties: {} } },
    { id: 'demo__send_alert', name: 'send_alert', write: true, server: 'demo', description: 'Alerte' },
  ];
  const mmcp: McpClient = { listTools: async () => mtools, call: async () => ({ data: fakeMetrics('ventes', 30) }) };
  const events: any[] = [];
  const r = await runScriptedCrew({ prompt: 'Tableau de bord de suivi de mes ventes avec simulation de hausse de prix et action d’alerte' }, { mcp: mmcp, emit: (e) => events.push(e) });
  const a = events.filter((e) => e.type === 'agent');
  assert.ok(a.find((e) => e.kind === 'brief')?.text.includes('demo__get_metrics'));
  const reviews = a.filter((e) => e.kind === 'review');
  assert.equal(reviews.at(-1).verdict, 'ok', JSON.stringify(reviews.at(-1).remarks));
  for (const id of ['COH-backend', 'COH-front', 'COH-agent', 'LIVE-actualisation', 'SIM-instantanée', 'LIB-métier', 'DASH-chat', 'COH-chart']) assert.ok(reviews.at(-1).criteria.find((c: any) => c.id === id)?.ok, id);
  assert.match(r.files['src/App.tsx'], /@\/components\/es\/app-shell/);
  assert.ok(!/<form|<input/i.test(r.files['src/App.tsx']), 'aucune saisie dans le dashboard');
  assert.ok((r.app?.contract.dashboard?.panels.length ?? 0) >= 6 && (r.app?.contract.chat?.commands.length ?? 0) >= 4);
  assert.match(r.app!.agent.instructions, /CONTREMAÎTRE/);
});

test('contremaître scripté : « tunnel comme une machine » → scène Pixi sur mesure + actions, ⚡ événements, voix', async () => {
  const { runScriptedAgent } = await import('../src/app-agents/runner.ts');
  const { funnel } = await import('../../../packages/mcp-demo-server/src/metrics.ts');
  const H = (server: string, name: string, write = false) => ({ id: `${server}__${name}`, server, name, write, safe: false, description: name, inputSchema: { type: 'object', properties: {} } }) as any;
  const tools = [
    ...['set_dashboard', 'render_action', 'update_action', 'remove_action', 'render_scene', 'update_scene', 'remove_scene'].map((n) => H('ui', n)),
    H('retrieval', 'mcp_list_tools'), H('retrieval', 'mcp_call'), H('foreman', 'plan_tasks'), H('foreman', 'update_task'),
    H('voice', 'speak'),
  ];
  const go = async (message: string, voice = false) => {
    const ev: any[] = [];
    await runScriptedAgent({
      def: { name: 'co-dj', instructions: '', tools: [] } as any, tools, message, voice, emit: (e) => ev.push(e),
      askConfirm: async () => true,
      callTool: async (t, args: any) => {
        if (t.name === 'mcp_list_tools') return { outils: [{ id: 'demo__get_funnel', description: 'tunnel' }] };
        if (t.name === 'mcp_call') return { source: 'demo › get_funnel', data: funnel('2026-11-19') };
        return { ok: true, args };
      },
    });
    return ev;
  };
  const ev = await go('visualise mon tunnel de conversion comme une machine', true);
  const calls = ev.filter((e) => e.type === 'tool_call');
  const scene = calls.find((c) => c.tool === 'render_scene');
  assert.equal(scene?.args.scene, 'conversion-machine');
  assert.equal(scene?.args.kind, 'pixi');
  assert.ok(scene?.args.data.stages.length >= 4, 'scène liée aux données MCP');
  assert.deepEqual(calls.filter((c) => c.tool === 'render_action').map((c) => c.args.component), ['Slider', 'Slider']);
  assert.ok(calls.some((c) => c.tool === 'speak'), 'répond à la voix quand l’utilisateur parle');
  assert.match(ev.at(-1).text, /Goulot/);
  const ev2 = await go('⚡ Trafic d’entrée · change : 40');
  assert.deepEqual(ev2.find((e) => e.type === 'tool_call' && e.tool === 'update_scene')?.args, { id: 'machine', params: { traffic_pct: 40 } });
  assert.ok(!ev2.some((e) => e.tool === 'speak'), 'pas de voix sans demande vocale');
});
