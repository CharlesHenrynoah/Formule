/**
 * Source n8n : faux serveur MCP n8n (exécution « running » puis « success »), attente avec backoff,
 * ingestion dans un vrai backend d'app (bac à sable app-mcp) et provenance lue par get_kpis.
 * Budget d'étapes pondéré + compte rendu intermédiaire « Continuer ».
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { compileTools, loadBackend } from '../../../packages/app-mcp/src/core.mjs';
import { executionIdOf, ingestToolOf, n8nServers, rawPayload, runPipeline, sentimentScore, sourceConfig, sourceFromText, sourceIdentity, toPoints, waitExecution, type HubCall } from '../src/app-agents/n8n.ts';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { partialReport, stepWeight, PAUSE_MARK } from '../src/app-agents/runner.ts';
import type { HubTool } from '../src/app-agents/store.ts';

const WF = 'dJ6mOIPdIzw7zhc8';
/** Sortie du nœud « Répondre données » (forme réelle de l'exécution 882, + une distribution de sentiment). */
const OUTPUT = {
  meta: { generated_at: '2026-11-20T11:01:01.692+01:00', since: '2000-01-01', group_by: 'Segment_budget', totals: { crm_clients: 200, feedback_total: 601, feedback_new: 601 } },
  segments: [
    { group: 'Intermédiaire', crm: { n_clients: 87, satisfaction_1_5: { n: 52, mean: 3.65 } }, new_feedback: { n_interactions: 260, sentiment: [{ value: 'Positif', count: 130 }, { value: 'Neutre', count: 80 }, { value: 'Négatif', count: 50 }] } },
    { group: 'Économique', crm: { n_clients: 61, satisfaction_1_5: { n: 35, mean: 3.69 } }, new_feedback: { n_interactions: 0, sentiment: [] } },
    { group: 'Premium', crm: { n_clients: 52, satisfaction_1_5: { n: 30, mean: 3.43 } }, new_feedback: { n_interactions: 160, sentiment: [{ value: 'Positif', count: 40 }, { value: 'Négatif', count: 120 }] } },
  ],
  latest_personas: [{ persona_id: 'PER-01', version: 1, nom_persona: 'Acheteur milieu de gamme polyvalent', segment: 'tous segments', date: '2026-11-16 15:02' }],
};

/** Faux MCP n8n : execute_workflow rend la main tout de suite ; get_workflow_execution « running » ×2 puis « success ». */
async function fakeN8n(opts: { runningPolls?: number; finalStatus?: string } = {}) {
  const calls: Array<{ name: string; args: any }> = [];
  let polls = 0;
  const server = new Server({ name: 'fake-n8n', version: '1.0.0' }, { capabilities: { tools: {} } });
  const tool = (name: string) => ({ name, inputSchema: { type: 'object' as const, properties: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['execute_workflow', 'get_workflow_execution', 'search_workflow_executions', 'publish_workflow'].map(tool) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as any;
    calls.push({ name: req.params.name, args });
    const text = (x: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(x) }] });
    if (req.params.name === 'execute_workflow') return text({ executionId: '901', status: 'started' });
    if (req.params.name === 'get_workflow_execution') {
      const execution = { id: args.executionId, workflowId: WF, mode: 'manual', startedAt: '2026-11-20T10:00:52.908Z' };
      if (!args.includeData) {
        polls++;
        const status = polls <= (opts.runningPolls ?? 2) ? 'running' : (opts.finalStatus ?? 'success');
        return text({ execution: { ...execution, status, stoppedAt: status === 'running' ? null : '2026-11-20T10:01:01.708Z' } });
      }
      const runData = { 'Répondre données': [{ executionStatus: 'success', data: { main: [[{ json: OUTPUT, pairedItem: { item: 0 } }]] } }] };
      return text({ execution: { ...execution, status: 'success' }, data: { resultData: { runData: args.nodeNames ? runData : { 'Lire CRM_Customers': [{ data: { main: [[{ json: { id: 1 } }]] } }], ...runData }, lastNodeExecuted: 'Répondre données' } } });
    }
    return { isError: true, content: [{ type: 'text' as const, text: `interdit dans ce test : ${req.params.name}` }] };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(b);
  // Équivalent de callHub : « n8n__outil » → outil du serveur, texte JSON → objet.
  const call: HubCall = async (id, args) => {
    const r = await client.callTool({ name: id.replace(/^n8n__/, ''), arguments: args });
    const t = (r.content as Array<{ text: string }>)[0].text;
    if (r.isError) throw new Error(t);
    return JSON.parse(t);
  };
  return { call, calls, polls: () => polls };
}

/** Backend d'app type « console personas » (comme celui généré sur le Mac). */
const BACKEND = `
export const tools = {
  ingest_persona_metrics: { kind: 'store', write: true, safe: true, input: { points: { type: 'array' } },
    run: (a, db) => { for (const p of a.points) { const id = p.date + '|' + p.segment; const row = { id, date: p.date, segment: p.segment, nb_clients: p.nb_clients, nb_feedbacks: p.nb_feedbacks, sentiment: p.sentiment, version: p.version };
      if (db.get('metrics', id)) db.update('metrics', id, row); else db.insert('metrics', row); } return { total: db.count('metrics') }; } },
  get_kpis: { kind: 'read', input: {}, run: (_a, db) => ({ source: db.getMeta('source') ?? null, segments: db.list('metrics').map((m) => ({ segment: m.segment, clients: m.nb_clients, feedbacks: m.nb_feedbacks, sentiment: m.sentiment, version: m.version })) }) },
};`;

test('sentiment : distribution Positif/Neutre/Négatif → score 0..1', () => {
  assert.deepEqual(sentimentScore([{ value: 'Positif', count: 2 }, { value: 'Neutre', count: 2 }, { value: 'Négatif', count: 0 }]), { score: 0.75, n: 4, negatifs: 0 });
  assert.equal(sentimentScore([]), null);
  assert.equal(executionIdOf({ executionId: 882 }), '882');
  assert.equal(executionIdOf({ execution: { id: '7' } }), '7');
  assert.equal(executionIdOf('Workflow execution started. Execution ID: 1234'), '1234');
  assert.deepEqual(n8nServers(['n8n__get_workflow_execution', 'n8n__execute_workflow', 'demo__send_alert']), ['n8n']);
});

test('adaptation : sortie réelle /persona/data → points par segment (repli satisfaction si pas de feedback)', () => {
  const { points, shape, notes } = toPoints([OUTPUT]);
  assert.equal(shape, 'segments');
  assert.deepEqual(points.map((p) => [p.segment, p.nb_clients, p.nb_feedbacks, p.sentiment, p.version]), [
    ['Intermédiaire', 87, 260, 0.65, 'v1'], ['Économique', 61, 0, 0.67, 'v1'], ['Premium', 52, 160, 0.25, 'v1'],
  ]);
  assert.equal(points[0].date, '2026-11-20');
  assert.equal(points[1].sentiment_source, 'satisfaction CRM (1-5)');
  assert.match(notes[0], /1 segment\(s\) sans feedback/);
});

test('attente : faux MCP n8n « running » puis « success », en une seule étape avec backoff', async () => {
  const n8n = await fakeN8n({ runningPolls: 2 });
  const ticks: string[] = [];
  const w = await waitExecution(n8n.call, 'n8n', WF, '901', { backoff: [5, 5, 5], onTick: (e) => ticks.push(e.status) });
  assert.equal(w.status, 'success'); assert.equal(w.timedOut, false); assert.equal(w.polls, 3);
  assert.deepEqual(ticks, ['running', 'running', 'success']);
  // Délai : toujours « running » → état exploitable, pas d'exception.
  const slow = await fakeN8n({ runningPolls: 1000 });
  const t = await waitExecution(slow.call, 'n8n', WF, '902', { timeoutMs: 40, backoff: [10] });
  assert.equal(t.timedOut, true); assert.equal(t.status, 'running');
});

test('pipeline : exécuter → attendre → ingérer → get_kpis rempli avec la source (workflow + exécution)', async () => {
  const n8n = await fakeN8n({ runningPolls: 2 });
  const backend = loadBackend(await compileTools(BACKEND), {});
  assert.ok(backend.tools.some((t: any) => t.name === 'es_set_source'), 'outil de plateforme es_set_source présent');
  assert.deepEqual(backend.call('get_kpis', {}), { source: null, segments: [] });
  const progress: string[] = [];
  const r: any = await runPipeline({
    call: n8n.call,
    ingest: async (points) => backend.call('ingest_persona_metrics', { points }),
    setSource: async (source) => backend.call('es_set_source', { source }),
    onProgress: (m) => progress.push(m),
  }, { server: 'n8n', workflowId: WF, triggerNodeName: 'Webhook GET /persona/data', webhookData: { method: 'GET', query: { since: '2000-01-01' } } }, { execute: true, backoff: [5, 5, 5] });
  assert.equal(r.executionId, '901'); assert.equal(r.statut, 'success'); assert.equal(r.ingere, 3); assert.equal(r.noeud, 'Répondre données');
  // Exécution MANUELLE avec le déclencheur et la requête du webhook ; jamais de publication/activation.
  const exec = n8n.calls.find((c) => c.name === 'execute_workflow')!;
  assert.deepEqual(exec.args, { workflowId: WF, executionMode: 'manual', triggerNodeName: 'Webhook GET /persona/data', inputs: { webhookData: { method: 'GET', query: { since: '2000-01-01' } } } });
  assert.ok(!n8n.calls.some((c) => /publish|activate/.test(c.name)));
  const k = backend.call('get_kpis', {});
  assert.equal(k.segments.length, 3);
  assert.deepEqual(k.segments.find((s: any) => s.segment === 'Premium'), { segment: 'Premium', clients: 52, feedbacks: 160, sentiment: 0.25, version: 'v1' });
  assert.equal(k.source.workflowId, WF); assert.equal(k.source.executionId, '901'); assert.equal(k.source.noeud, 'Répondre données');
  assert.ok(progress.some((p) => /exécution 901 : running/.test(p)) && progress.some((p) => /3 point\(s\) ingéré/.test(p)));
  // Exécution déjà lancée : wait_execution (sans exécuter) ingère aussi.
  const again: any = await runPipeline({ call: n8n.call, ingest: async (points) => backend.call('ingest_persona_metrics', { points }), setSource: async (s) => backend.call('es_set_source', { source: s }) },
    { server: 'n8n', workflowId: WF }, { executionId: '882', backoff: [5] });
  assert.equal(again.ingere, 3); assert.equal(backend.call('get_kpis', {}).source.executionId, '882');
});

test('pipeline : exécution en erreur → rien ingéré, message exploitable', async () => {
  const n8n = await fakeN8n({ runningPolls: 1, finalStatus: 'error' });
  let ingested = 0;
  const r: any = await runPipeline({ call: n8n.call, ingest: async () => { ingested++; }, setSource: async () => null }, { server: 'n8n', workflowId: WF }, { execute: true, backoff: [5] });
  assert.equal(r.statut, 'error'); assert.equal(r.ingere, 0); assert.equal(ingested, 0); assert.match(r.note, /Ouvre l'exécution 901/);
});

test('budget : lectures/attentes = demi-étape, écritures = 1, compte rendu intermédiaire avec « Continuer »', () => {
  const T = (server: string, name: string, write = false, safe = true): HubTool => ({ id: `${server}__${name}`, name, server, write, safe, allowed: true });
  assert.equal(stepWeight(T('foreman', 'plan_tasks')), 0.25);
  assert.equal(stepWeight(T('retrieval', 'mcp_call'), { tool: 'n8n__get_workflow_execution' }), 0.5);
  assert.equal(stepWeight(T('retrieval', 'mcp_call'), { tool: 'n8n__execute_workflow' }), 1);
  assert.equal(stepWeight(T('source', 'wait_execution')), 0.5);
  assert.equal(stepWeight(T('source', 'refresh_data', true, false)), 1);
  assert.equal(stepWeight(T('n8n', 'publish_workflow', true, false)), 1);
  // L'ordre réel (découverte, plan, exécution, 5 sondages…) tient désormais dans le budget de 20.
  const order = [T('retrieval', 'mcp_list_tools'), T('foreman', 'plan_tasks'), T('app-x', 'get_kpis'), T('retrieval', 'mcp_call'), T('retrieval', 'mcp_call'), ...Array(5).fill(T('retrieval', 'mcp_call')), T('foreman', 'update_task')];
  const used = order.reduce((s, t, i) => s + stepWeight(t, { tool: i === 4 ? 'n8n__execute_workflow' : 'n8n__get_workflow_execution' }), 0);
  assert.ok(used <= 20, `poids ${used}`);
  const txt = partialReport({ calls: 3, changed: false, used: 20, paused: true, trail: [{ tool: 'get_kpis', ok: true, note: '{"segments":[…]}' }, { tool: 'plan_tasks', ok: true, note: '' }] }, 20);
  assert.match(txt, /Données déjà obtenues :\n- get_kpis/); assert.ok(txt.includes(PAUSE_MARK)); assert.match(txt, /Continuer/);
});

test('contremaître (scripté) : « rafraîchis les données » → confirmation, exécution+attente+ingestion en 1 étape, KPIs lus', async () => {
  const { runScriptedAgent } = await import('../src/app-agents/runner.ts');
  const n8n = await fakeN8n({ runningPolls: 2 });
  const backend = loadBackend(await compileTools(BACKEND), {});
  const T = (server: string, name: string, write = false, safe = true): HubTool => ({ id: `${server}__${name}`, name, server, write, safe, allowed: true });
  const tools = [T('app-x', 'get_kpis'), T('app-x', 'ingest_persona_metrics', true, true), T('foreman', 'plan_tasks'), T('foreman', 'update_task'), T('ui', 'set_dashboard'), T('source', 'refresh_data', true, false), T('source', 'wait_execution')];
  const events: any[] = []; const confirms: string[] = [];
  const run = (maxSteps: number) => runScriptedAgent({
    def: { name: 'Co-DJ', instructions: '', tools: [] } as any, tools, message: 'Rafraîchis les données n8n', emit: (e) => events.push(e), maxSteps,
    askConfirm: async (t) => { confirms.push(t.name); return true; },
    callTool: async (t, args) => {
      if (t.server === 'source') return runPipeline({ call: n8n.call, ingest: async (points) => backend.call('ingest_persona_metrics', { points }), setSource: async (s) => backend.call('es_set_source', { source: s }) },
        { server: 'n8n', workflowId: WF }, { execute: true, backoff: [5, 5, 5] });
      if (t.server.startsWith('app-')) return backend.call(t.name, args as any);
      return { ok: true };
    },
  });
  const text = await run(20);
  assert.deepEqual(confirms, ['refresh_data']);
  assert.match(text, /exécution 901, success/); assert.match(text, /Premium : 52 clients, sentiment 0.25/); assert.match(text, /workflow dJ6mOIPdIzw7zhc8 · exécution 901/);
  assert.equal(events.at(-1).type, 'done'); assert.equal(events.at(-1).continuable, undefined);
  // Budget minuscule : pause propre + « Continuer » au lieu de « ⛔ Limite… ».
  events.length = 0;
  const paused = await run(1);
  assert.ok(paused.includes(PAUSE_MARK)); assert.equal(events.at(-1).continuable, true);
});


// ---- Régression « Radar Personas » : source décrite dans le prompt, ingestion du JSON brut, diagnostic du bon workflow ----
const RADAR_PROMPT = `Crée une app « Radar Personas n8n » connectée à mon serveur MCP n8n chnoahdev.
Source de données : le workflow dJ6mOIPdIzw7zhc8, déclencheur « Webhook GET /persona/data », nœud de sortie « Répondre données ».`;

test('source déduite du prompt : workflow, déclencheur, nœud de sortie (sinon aucune ingestion → KPI à 0)', async () => {
  assert.deepEqual(sourceFromText(RADAR_PROMPT), { workflowId: WF, triggerNodeName: 'Webhook GET /persona/data', node: 'Répondre données', webhookData: { method: 'GET', query: {} } });
  assert.deepEqual(sourceFromText('Une calculatrice avec historique'), {});
  const dir = mkdtempSync(join(tmpdir(), 'es-src-'));
  mkdirSync(join(dir, 'app1'));
  writeFileSync(join(dir, 'app1', 'memory.json'), JSON.stringify({ requests: [{ at: '2026-11-20', version: 1, prompt: RADAR_PROMPT }] }));
  const contract = { console: { decks: [{ tool: 'get_personas', args: {} }] } }; // aucun workflowId dans le contrat
  const cfg = await sourceConfig(dir, 'app1', contract, ['n8n__get_workflow_execution', 'n8n__execute_workflow']);
  assert.equal(cfg?.workflowId, WF); assert.equal(cfg?.node, 'Répondre données'); assert.equal(cfg?.triggerNodeName, 'Webhook GET /persona/data');
  assert.ok(existsSync(join(dir, 'app1', 'source.json')), 'source enregistrée pour rester stable');
  assert.equal(JSON.parse(readFileSync(join(dir, 'app1', 'source.json'), 'utf8')).inferredFrom, 'prompt');
  // Une source configurée à la main reste prioritaire.
  writeFileSync(join(dir, 'app1', 'source.json'), JSON.stringify({ server: 'n8n', workflowId: 'AAAAAAAAAAAAAAA1', node: 'X' }));
  assert.equal((await sourceConfig(dir, 'app1', contract, ['n8n__get_workflow_execution']))?.workflowId, 'AAAAAAAAAAAAAAA1');
});

const RAW_BACKEND = `
export const tools = {
  ingest_persona_data: { kind: 'store', description: 'JSON brut', input: { payload: { type: 'object' } }, write: true, safe: true,
    run: (a: { payload?: any }, db: any) => { for (const s of a.payload?.segments ?? []) db.insert('segments', { id: s.group, group: s.group, n_clients: s.crm?.n_clients ?? 0 }); return { segments: (a.payload?.segments ?? []).length }; } },
  get_kpis: { kind: 'read', description: 'kpis', input: {}, write: false,
    run: (_a: unknown, db: any) => ({ personas: db.list('segments').length, clients: db.list('segments').reduce((s: number, x: any) => s + x.n_clients, 0) }) },
};`;

test('ingestion brute : outil ingest_* à argument objet (payload) → JSON du nœud versé tel quel', async () => {
  const backend = loadBackend(await compileTools(RAW_BACKEND), {});
  const tools = backend.tools.map((t: any) => ({ ...t, server: 'app-x', id: `app-x__${t.name}` }));
  const ing = ingestToolOf(tools)!;
  assert.equal(ing.tool.name, 'ingest_persona_data'); assert.equal(ing.arg, 'payload'); assert.equal(ing.raw, true);
  assert.deepEqual(rawPayload([OUTPUT]), OUTPUT);
  const n8n = await fakeN8n({ runningPolls: 1 });
  const r: any = await runPipeline({
    call: n8n.call, ingestRaw: true,
    ingest: async (points, raw) => backend.call(ing.tool.name, { [ing.arg]: ing.raw ? raw : points }),
    setSource: async () => null,
  }, { server: 'n8n', workflowId: WF, node: 'Répondre données' }, { execute: true, backoff: [5] });
  assert.equal(r.statut, 'success'); assert.ok(r.ingere > 0); assert.deepEqual(r.resultat_ingestion, { segments: 3 });
  assert.deepEqual(backend.call('get_kpis', {}), { personas: 3, clients: 200 });
});

test('contremaître : la source de l’app est nommée, une erreur d’un autre workflow n’explique pas des KPI à 0', () => {
  const t = sourceIdentity({ server: 'n8n', workflowId: WF, triggerNodeName: 'Webhook GET /persona/data', node: 'Répondre données' });
  assert.match(t, /workflow dJ6mOIPdIzw7zhc8/); assert.match(t, /AUTRE workflow/); assert.match(t, /refresh_data/);
  assert.match(sourceIdentity(null), /Aucune source n8n/);
});
