/**
 * app-agents (:4005) — exécute à la demande le sous-agent de chaque app générée et sert de façade
 * vers son backend MCP (lancé et enregistré dans mcp-hub).
 *   POST /apps/:id/ensure      { version? }                       → backend lancé, outils, définition d'agent
 *   GET  /apps/:id/tools       ?version=
 *   POST /apps/:id/call        { tool, args, version?, source, confirmed? }  (UI de l'app / test manuel du studio)
 *   POST /apps/:id/ask         { message, history?, version? }    → SSE (delta, tool_call, tool_result, confirm, done)
 *   POST /apps/:id/confirm     { callId, ok }                     → réponse humaine à une demande d'approbation
 *   POST /apps/:id/refresh     { confirmed, executionId?, workflowId?, triggerNodeName?, webhookData? }
 *                              → source n8n : exécution manuelle → attente → ingestion dans le backend de l'app
 *   GET  /apps/:id/log         journal des appels d'outils
 *   DELETE /apps/:id           arrête le backend (et supprime ses données si ?data=1)
 */
import { BIND_HOST } from '../env.ts';
import Fastify, { type FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildMemory, loadMemory, memoryMarkdown, retroMemory, saveMemory } from '../agent/app-memory.ts';
import { createProvider, INCEPTION_BASE_URL, INCEPTION_DEFAULT_MODEL } from '../providers/index.ts';
import { APPS_DIR, callHub, ensureApp, externalTools, forgetFact, log, memoryContext, readLog, readMemory, remember, stopApp, type HubTool } from './store.ts';
import { runLlmAgent, runScriptedAgent, type AgentCfg, type AskEvent } from './runner.ts';
import { ACTION_COMPONENTS, SCENE_CATALOG, ASK_TIMEOUT_MS, MAX_STEPS, callVoice, voiceSession, voiceTools, discover, foremanTools, hubJson, retrievalTools, runAppCli, sourceLabel, allowedServers, type Task } from './foreman.ts';

import { n8nServers, sourceConfig, sourceIdentity, ingestToolOf, runPipeline, type SourceCfg } from './n8n.ts';
import { compactSample, prepareCallArgs, slimArgs } from '../agent/mcp-sample.ts';
import { relabelText } from '../agent/ui-labels';
/** Libellés métier dans les réponses du contremaître (l'analogie DJ reste un principe interne). */
const LABEL_RULES = "\n\nVOCABULAIRE : réponds avec des termes métier clairs (Assistant, Recommandations, Indicateurs clés, Simulation, Comparer réel / scénario, Actions rapides, Sources de données, Actualisation, Vues enregistrées, Journal des actions) ; n'emploie jamais de vocabulaire DJ (co-DJ, knobs, crossfader, pads, decks, VU-mètres, waveform, scènes, prochain mouvement).";
const AVAIL_RULES = `\n\nDISPONIBILITÉ DES DONNÉES (obligatoire avant toute recommandation ou panneau) :
- Avant de proposer un KPI, un graphique ou un tableau, lis l'outil de lecture correspondant et note la période couverte (dates min/max) et le nombre de lignes.
- Si le compte est 0 sur la période demandée : ne propose PAS cette vue, n'injecte pas de panneau vide. Dis ce que tu as regardé (« sur 30 j : 0 PR fusionnée ») et recommande uniquement une vue qui a des lignes (autre période, autre état, autre source).
- Tes recommandations et tes ui_render_* ne portent que sur des données présentes. Une interface ne projette jamais une série vide.`;

const PORT = Number(process.env.APP_AGENTS_PORT ?? 4005);
const choice = createProvider();
function agentCfg(): AgentCfg | null {
  const env = process.env;
  const p = choice.provider.name;
  if (p === 'inception') return { baseUrl: env.LLM_BASE_URL || INCEPTION_BASE_URL, apiKey: (env.INCEPTION_API_KEY || env.LLM_API_KEY)!, model: env.LLM_MODEL?.trim() || INCEPTION_DEFAULT_MODEL, reasoningEffort: env.LLM_REASONING_EFFORT || 'instant' };
  if (p === 'openai') return { baseUrl: env.LLM_BASE_URL || 'https://api.openai.com/v1', apiKey: (env.LLM_API_KEY || env.OPENAI_API_KEY)!, model: env.LLM_MODEL?.trim() || 'gpt-4o-mini' };
  return null;
}
const CFG = agentCfg();
console.log(`[app-agents] sous-agents : ${CFG ? `OpenAI Agents SDK · ${CFG.model}` : 'scriptés (démo)'}`);

const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 5 * 1024 * 1024 });
const fail = (reply: FastifyReply, e: unknown) => reply.code((e as { status?: number }).status ?? 500).send({ error: (e as Error).message, ...((e as { body?: object }).body ?? {}) });
const short = (v: unknown) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s?.length > 600 ? s.slice(0, 600) + '…' : s; };
const appTools = (tools: HubTool[]) => tools.map((t) => ({ ...t, server: t.server ?? t.id.split('__')[0] }));

type Ensured = Awaited<ReturnType<typeof ensureApp>>;
/** Règles injectées à l'exécution (apps existantes comprises) quand l'app a une source n8n. */
const SOURCE_RULES = `

SOURCE n8n (outils refresh_data / wait_execution) :
- Pour (re)charger les données, utilise refresh_data : exécution MANUELLE du workflow, attente de la fin et ingestion dans l'app, en UNE étape (une carte de confirmation s'affiche). Puis lis get_kpis.
- Si une exécution est déjà lancée (id connu), utilise wait_execution (attente jusqu'à succès/erreur, ~60 s, puis ingestion) au lieu de sonder get_workflow_execution en boucle.
- Ne propose JAMAIS d'activer ou de publier le workflow comme solution, et n'appelle pas publish/activate. Si c'est pertinent, mentionne seulement en option que l'utilisateur peut activer lui-même le workflow dans n8n pour utiliser l'URL de production du webhook.
- Après refresh_data / wait_execution, lis get_kpis puis fais le COMPTE RENDU CHIFFRÉ par segment (clients, feedbacks, sentiment) et cite la source : workflow + exécution (id) + date de fin.
- Si l'exécution est encore en cours après l'attente, rappelle wait_execution avec le même executionId (ne relance pas une nouvelle exécution).`;

/** Source n8n de l'app (config + garde-fous de liste blanche). */
async function appSource(a: Ensured, over: Partial<SourceCfg> = {}) {
  const whitelist = a.app.agent?.externalTools ?? (a.app.contract as { externalTools?: string[] })?.externalTools ?? [];
  const base = await sourceConfig(APPS_DIR, a.appId, a.app.contract, whitelist);
  if (!base) return null;
  const cfg: SourceCfg = { ...base, ...Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined && v !== '')) };
  if (!n8nServers(whitelist).includes(cfg.server)) throw Object.assign(new Error(`serveur hors liste blanche de l'app : ${cfg.server}`), { status: 403 });
  return { cfg, whitelist };
}

/** Exécuter (si demandé) → attendre → ingérer, pour l'agent comme pour le pad « Rafraîchir » du studio. */
async function sourcePipeline(a: Ensured, o: { execute: boolean; confirmed: boolean; executionId?: string; over?: Partial<SourceCfg>; timeoutMs?: number; signal?: AbortSignal; onProgress?: (m: string) => void; origin: string }) {
  const src = await appSource(a, o.over);
  if (!src) throw Object.assign(new Error("cette app n'a pas de source n8n autorisée (get_workflow_execution absent de sa liste blanche)"), { status: 409 });
  const { cfg, whitelist } = src;
  if (!cfg.workflowId) throw Object.assign(new Error('workflowId requis (aucun workflow trouvé dans le contrat de l’app)'), { status: 400 });
  if (o.execute) {
    if (!whitelist.includes(`${cfg.server}__execute_workflow`)) throw Object.assign(new Error(`exécution non autorisée pour cette app : ${cfg.server}__execute_workflow`), { status: 403 });
    if (!o.confirmed) throw Object.assign(new Error('confirmation requise'), { status: 428, body: { needsConfirmation: true, tool: `${cfg.server}__execute_workflow` } });
  }
  const tools = appTools(a.tools);
  const ing = ingestToolOf(tools);
  const setSrc = tools.find((t) => t.name === 'es_set_source');
  const t0 = Date.now();
  const r = await runPipeline({
    call: async (id, args) => {
      if (/__(publish|activate|deactivate|update|create|delete)_/.test(id)) throw new Error(`interdit : ${id}`);
      const isExec = id.endsWith('__execute_workflow');
      const res = await callHub(id, args, isExec && o.confirmed);
      if (isExec) void log(a.appId, { source: o.origin as never, tool: id, args, ok: true, ms: res.ms ?? 0, result: short(res.data), confirmed: true });
      return res.data;
    },
    ingest: ing ? async (points, raw) => (await callHub(ing.tool.id, { [ing.arg]: ing.raw ? raw : points }, true)).data : null,
    ingestRaw: !!ing?.raw,
    setSource: async (s) => (setSrc ? (await callHub(setSrc.id, { source: s }, true)).data : null),
    onProgress: o.onProgress, signal: o.signal,
  }, { ...cfg, workflowId: cfg.workflowId }, { execute: o.execute, executionId: o.executionId, timeoutMs: o.timeoutMs });
  // Schéma RÉEL observé (mémoire de la crew : évite qu'un Data Engineer réinvente le format à la prochaine évolution)
  const observed = (r as { schema?: unknown[] }).schema;
  if (Array.isArray(observed) && observed.length) void writeFile(join(APPS_DIR, a.appId, 'source-schema.json'), JSON.stringify({ at: new Date().toISOString(), executionId: (r as { executionId?: string }).executionId, workflowId: cfg.workflowId, schema: observed }, null, 1)).catch(() => {});
  void log(a.appId, { source: o.origin as never, tool: o.execute ? 'source.refresh_data' : 'source.wait_execution', args: { workflowId: cfg.workflowId, executionId: (r as { executionId?: string }).executionId }, ok: true, ms: Date.now() - t0, result: short(r) });
  return r;
}

app.get('/health', async () => ({ service: 'app-agents', status: 'ok', framework: CFG ? 'OpenAI Agents SDK' : 'scripté (démo)', model: CFG?.model ?? 'mock' }));

app.post<{ Params: { id: string }; Body: { version?: number } }>('/apps/:id/ensure', async (req, reply) => {
  try {
    const a = await ensureApp(req.params.id, req.body?.version);
    return { appId: a.appId, version: a.version, connId: a.connId, status: a.status, tools: appTools(a.tools), agent: a.app.agent, contract: a.app.contract, runtime: CFG ? `OpenAI Agents SDK · ${CFG.model}` : 'scripté (démo)' };
  } catch (e) { return fail(reply, e); }
});

/** Résumé de la mémoire de la crew pour le contremaître (évolutions formulées en DELTA). */
function crewMemoryNote(appId: string) {
  try {
    const md = readFileSync(join(APPS_DIR, appId, 'CREW.md'), 'utf8');
    return `\n\nMÉMOIRE DE L'ÉQUIPE DE CONSTRUCTION (ce qui existe déjà dans l'app — ne le redemande pas) :\n${md.slice(0, 3500)}\nPour une évolution (evolve_app), formule un DELTA précis : ce qu'il faut AJOUTER ou CHANGER, les panneaux/fichiers concernés et les critères existants à préserver — jamais une réécriture complète.`;
  } catch { return ''; }
}

// ---- Mémoire persistante de la CREW (ce qui a déjà été construit : source, schéma réel, contrat, fichiers, CA, versions) ----
const STORAGE_URL = process.env.STORAGE_URL ?? 'http://localhost:4003';
const MEM_ID = /^[a-zA-Z0-9-]{8,64}$/;
app.get<{ Params: { id: string }; Querystring: { format?: string } }>('/apps/:id/crew-memory', async (req, reply) => {
  if (!MEM_ID.test(req.params.id)) return reply.code(400).send({ error: 'id invalide' });
  const m = loadMemory(req.params.id, APPS_DIR);
  if (!m) return reply.code(404).send({ error: 'aucune mémoire pour cette app' });
  return req.query.format === 'md' ? reply.type('text/markdown; charset=utf-8').send(memoryMarkdown(m)) : m;
});
app.post<{ Params: { id: string }; Body: any }>('/apps/:id/crew-memory', async (req, reply) => {
  if (!MEM_ID.test(req.params.id)) return reply.code(400).send({ error: 'id invalide' });
  const b: any = req.body ?? {};
  if (!Number.isInteger(b.version) || typeof b.spec !== 'string' || !b.files || typeof b.files !== 'object') return reply.code(400).send({ error: 'version, spec et files requis' });
  try {
    const prev = loadMemory(req.params.id, APPS_DIR);
    const m = buildMemory({ appId: req.params.id, version: b.version, title: b.title, prompt: String(b.prompt ?? ''), kind: b.kind === 'iterate' ? 'iterate' : b.kind === 'edit' ? 'edit' : 'generate', mode: b.mode, spec: b.spec, brief: String(b.brief ?? ''), contract: b.contract ?? null, files: b.files, prevFiles: b.prevFiles, prev, features: Array.isArray(b.features) ? b.features.map(String) : undefined, decisions: Array.isArray(b.decisions) ? b.decisions.map(String) : undefined, dir: APPS_DIR });
    await saveMemory(m, APPS_DIR);
    return { ok: true, version: m.version, files: m.files.length, criteria: m.criteria.length, schema: m.brief.schemaStatus };
  } catch (e) { return fail(reply, e); }
});
/** Mémoire rétroactive pour une app existante (à partir du stockage : dernière version + historique). */
app.post<{ Params: { id: string } }>('/apps/:id/crew-memory/retro', async (req, reply) => {
  if (!MEM_ID.test(req.params.id)) return reply.code(400).send({ error: 'id invalide' });
  try {
    const p = await fetch(`${STORAGE_URL}/projects/${req.params.id}`).then((r) => (r.ok ? r.json() : null)) as any;
    if (!p?.versions?.length) return reply.code(404).send({ error: 'projet introuvable' });
    const latest = p.versions[p.versions.length - 1];
    const m = retroMemory(req.params.id, latest, p.versions.map((v: any) => ({ number: v.number, kind: v.kind, prompt: v.prompt ?? '', created_at: v.created_at })), APPS_DIR);
    if (!m.title) m.title = p.title ?? '';
    const prevMem = loadMemory(req.params.id, APPS_DIR);
    if (prevMem) { // garde l'historique détaillé déjà connu (mode, fichiers modifiés, features)
      const known = new Map(prevMem.history.map((h) => [h.version, h]));
      m.history = m.history.map((h) => known.get(h.version) ?? h);
      m.decisions = prevMem.decisions;
      if (m.brief.schemaStatus !== 'observé' && prevMem.brief.schemaStatus === 'observé') m.brief = { ...m.brief, schema: prevMem.brief.schema, schemaStatus: 'observé' };
    }
    await saveMemory(m, APPS_DIR);
    return { ok: true, version: m.version, files: m.files.length, criteria: m.criteria.length, schema: m.brief.schemaStatus };
  } catch (e) { return fail(reply, e); }
});

app.get<{ Params: { id: string }; Querystring: { version?: string } }>('/apps/:id/tools', async (req, reply) => {
  try { const a = await ensureApp(req.params.id, req.query.version ? Number(req.query.version) : undefined); return appTools(a.tools); }
  catch (e) { return fail(reply, e); }
});

app.post<{ Params: { id: string }; Body: { tool: string; args?: Record<string, unknown>; version?: number; source?: 'ui' | 'studio'; confirmed?: boolean } }>('/apps/:id/call', async (req, reply) => {
  const { tool, args = {}, version, source = 'ui', confirmed = false } = req.body ?? ({} as never);
  if (!/^[a-z][a-z0-9_]{0,47}$/.test(String(tool))) return reply.code(400).send({ error: "nom d'outil invalide" });
  try {
    const a = await ensureApp(req.params.id, version);
    const t = a.tools.find((x) => x.name === tool);
    if (!t) return reply.code(404).send({ error: `outil inconnu pour cette app : ${tool}` });
    // L'UI de l'app agit sur SES propres données : écritures « safe » sans confirmation ; les autres exigent l'accord de l'utilisateur.
    const needs = t.write && !t.safe;
    if (needs && !confirmed) return reply.code(428).send({ error: 'confirmation requise', needsConfirmation: true, tool });
    const t0 = Date.now();
    try {
      const r = await callHub(t.id, args, t.write);
      void log(a.appId, { source, tool, args, ok: true, ms: r.ms ?? Date.now() - t0, result: short(r.data), confirmed: needs || undefined });
      return { tool, data: r.data, ms: r.ms, write: t.write };
    } catch (e) {
      void log(a.appId, { source, tool, args, ok: false, ms: Date.now() - t0, error: (e as Error).message });
      throw e;
    }
  } catch (e) { return fail(reply, e); }
});

// ---- Sous-agent : SSE + approbations humaines ----
const pendingConfirm = new Map<string, { appId: string; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();
const running = new Map<string, number>();

/** Ask = lecture interface/données ; Agent = écriture / actions / évolutions. */
function toolsForChatMode<T extends { write?: boolean; server?: string; name?: string }>(tools: T[], mode: 'ask' | 'agent'): T[] {
  if (mode !== 'ask') return tools;
  return tools.filter((t) => {
    if (t.write) return false;
    if (t.server === 'foreman' && t.name === 'evolve_app') return false;
    if (t.server === 'ui' && /action/.test(String(t.name))) return false;
    if (t.server === 'source' && t.name === 'refresh_data') return false;
    return true;
  });
}

const ASK_MODE_RULES = `

MODE ASK (lecture seule) : tu expliques l'interface et les données. INTERDIT : écrire, déclencher une action externe, évoluer l'app (evolve_app), afficher des composants d'action, rafraîchir une source en écriture. Utilise uniquement les outils de lecture (KPI, listes, MCP read, recall, set_dashboard pour focus/filtres, scènes en visualisation). Si l'utilisateur demande une écriture ou une évolution, réponds clairement qu'il doit basculer en mode Agent.`;

app.post<{ Params: { id: string }; Body: { message: string; history?: Array<{ role: 'user' | 'assistant'; content: string }>; version?: number; context?: string; voice?: boolean; mode?: 'ask' | 'agent' } }>('/apps/:id/ask', async (req, reply) => {
  const message = String(req.body?.message ?? '').trim();
  if (!message) return reply.code(400).send({ error: 'message requis' });
  if (message.length > 4000) return reply.code(413).send({ error: 'message trop long' });
  if ((running.get(req.params.id) ?? 0) >= 2) return reply.code(429).send({ error: "l'agent de cette app est déjà occupé" });
  const chatMode: 'ask' | 'agent' = req.body?.mode === 'ask' ? 'ask' : 'agent';
  let a;
  try { a = await ensureApp(req.params.id, req.body?.version); } catch (e) { return fail(reply, e); }
  const appId = a.appId;
  const A = a;
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), ASK_TIMEOUT_MS);
  const ping = setInterval(() => !reply.raw.writableEnded && reply.raw.write(': ping\n\n'), 10_000);
  reply.raw.on('close', () => { clearInterval(ping); ac.abort(); });
  const emit = (e: AskEvent | { type: 'error'; message: string }) => { if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`); };
  running.set(appId, (running.get(appId) ?? 0) + 1);

  // Outils : backend de l'app (selon la liste de l'agent) + outils externes autorisés par le contrat.
  const def = a.app.agent;
  const own = appTools(a.tools).filter((t) => !def.tools?.length || def.tools.includes(t.name));
  const ext = def.externalTools?.length ? (await externalTools()).filter((t) => def.externalTools.includes(t.id)) : [];
  // Mémoire personnelle (locale, propre à l'app) : outils internes, non exposés au front.
  const memTools: HubTool[] = [
    { id: 'memory__remember', name: 'remember', server: 'memory', write: true, safe: true, allowed: true, description: "Retient durablement une préférence, un objectif ou une habitude de l'utilisateur", inputSchema: { type: 'object', properties: { fact: { type: 'string', description: 'Fait à retenir, formulé à la 3e personne ou en citation' } }, required: ['fact'], additionalProperties: false } },
    { id: 'memory__recall', name: 'recall', server: 'memory', write: false, safe: true, allowed: true, description: 'Relit la mémoire personnelle (demandes passées, préférences, objectifs)', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
  ];
  // Pilotage du dashboard par le chat : l'agent modifie l'état visuel (scénario, filtres, focus d'un panneau).
  const dash = (a.app.contract as { dashboard?: { state?: Record<string, string> } } | undefined)?.dashboard;
  const stateKeys = Object.entries(dash?.state ?? {}).map(([k, v]) => `${k} (${v})`).join(' ; ');
  const U = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): HubTool => ({ id: `ui__${name}`, name, server: 'ui', write: false, safe: true, allowed: true, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
  const uiTools: HubTool[] = [
    U('set_dashboard', `Met à jour l'état du dashboard affiché à l'utilisateur (aucun effet externe).${stateKeys ? ` Clés : ${stateKeys}.` : ''} Ex. { "patch": { "focus": "simulation" } }`, { patch: { type: 'object', description: "Clés de l'état du dashboard à modifier" } }, ['patch']),
    U('render_action', `Affiche (ou remplace) un COMPOSANT D'ACTION que TU contrôles, dans la zone Actions du dashboard ou dans le chat. Composants (shadcn) : ${ACTION_COMPONENTS.join(', ')}. Chaque interaction de l'utilisateur te revient comme un message « ⚡ … » avec ui_event dans le contexte. Props usuelles : label, value, options[], min/max/step/unit (Slider), items[] (Menu), title/description/variant (Alert), content (Markdown/Popover), href (ButtonLink/TextLink), kind 'spinner'|'progress'|'status' (Indicators). Une action à effet réel déclenchée par un composant passe TOUJOURS par l'outil d'écriture + confirmation.`,
      { id: { type: 'string', description: 'Identifiant stable (ex. seuil_alerte)' }, component: { type: 'string', enum: [...ACTION_COMPONENTS] }, props: { type: 'object' }, zone: { type: 'string', enum: ['dashboard', 'chat'] } }, ['id', 'component']),
    U('update_action', "Met à jour les props d'un composant d'action déjà affiché (préremplir, activer/désactiver, changer les options).", { id: { type: 'string' }, props: { type: 'object' } }, ['id', 'props']),
    U('remove_action', "Retire un composant d'action.", { id: { type: 'string' } }, ['id']),
    U('render_scene', `Affiche une VISUALISATION ANIMÉE dans le dashboard. kind 'pixi' (2D WebGL : simulation, flux, particules, agents) ou 'three' (3D : concepts, surfaces). Catalogue : pixi = ${SCENE_CATALOG.pixi.join(', ')} ; three = ${SCENE_CATALOG.three.join(', ')} ; + les scènes sur mesure déjà enregistrées par l'app (liste dans le contexte : scenes_sur_mesure_disponibles — PRÉFÈRE-LES quand elles correspondent à la demande, ex. conversion-machine {stages:[{label,value}]} params {traffic_pct, boost_stage, boost_pct}). Données : particle-flow {flows:[{from,to,value}]}, agent-sim {groups:[{label,count}]}, live-heatmap {values:number[][]}, network-graph/3d-concept-model {nodes:[{id,label}],edges:[{source,target,value}]}, 3d-bars [{label,value}], 3d-surface {values:number[][]}. params = curseurs de simulation (speed, attraction, traffic_pct…). Pour une métaphore qui n'existe pas encore (« mon tunnel comme une machine »), délègue à evolve_app : l'équipe génère une scène sur mesure.`,
      { id: { type: 'string' }, kind: { type: 'string', enum: ['pixi', 'three'] }, scene: { type: 'string' }, title: { type: 'string' }, data: {}, params: { type: 'object' } }, ['id', 'kind', 'scene']),
    U('update_scene', "Met à jour une scène affichée en direct (nouvelles données MCP et/ou paramètres de simulation).", { id: { type: 'string' }, data: {}, params: { type: 'object' }, title: { type: 'string' } }, ['id']),
    U('remove_scene', 'Retire une visualisation animée.', { id: { type: 'string' } }, ['id']),
  ];
  // Contremaître : plan de chantier, délégation des évolutions à l'équipe (itération), CLI confinée, retrieval MCP.
  // Voix : outil disponible seulement si le navigateur de l'utilisateur est connecté au voice-gateway (Google).
  const vs = await voiceSession(appId);
  const voiceOn = !!(vs?.enabled && vs.connected);
  // Source n8n : exécution + attente + ingestion en une étape (au lieu de sonder à la main).
  const hasSource = n8nServers(def.externalTools ?? []).length > 0;
  const srcCfg = hasSource ? ((await appSource(A).catch(() => null))?.cfg ?? null) : null;
  const S = (name: string, description: string, properties: Record<string, unknown>, required: string[], write: boolean): HubTool => ({ id: `source__${name}`, name, server: 'source', write, safe: !write, allowed: true, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
  const sourceTools: HubTool[] = hasSource ? [
    S('refresh_data', "Rafraîchit les données de l'app depuis le workflow n8n : exécution MANUELLE (confirmation), attente de la fin (~60 s max) puis ingestion du résultat dans l'app (get_kpis). Une seule étape. N'active ni ne publie jamais le workflow.",
      { workflowId: { type: 'string', description: 'Optionnel : par défaut le workflow de la source de l’app' }, triggerNodeName: { type: 'string' }, query: { type: 'object', description: 'Paramètres de requête du webhook (ex. { "since": "2026-01-01" })' } }, [], true),
    S('wait_execution', "Attend la fin d'une exécution n8n déjà lancée (succès/erreur, backoff, ~60 s max) puis ingère son résultat dans l'app. Une seule étape : ne sonde pas get_workflow_execution en boucle.",
      { executionId: { type: 'string' }, workflowId: { type: 'string' }, ingest: { type: 'boolean', description: 'false = lire sans ingérer' } }, ['executionId'], false),
  ] : [];
  const toolsAll = [...own, ...ext, ...memTools, ...uiTools, ...foremanTools(), ...retrievalTools(), ...sourceTools, ...(voiceOn ? voiceTools() : [])];
  const tools = toolsForChatMode(toolsAll, chatMode);
  const voiceNote = !voiceOn ? '' : req.body?.voice
    ? "\n\nVOIX : l'utilisateur te parle à l'oral (transcription Google). Après ton travail, appelle voice_speak UNE fois avec un compte rendu oral très court (1-2 phrases, style Jarvis), puis écris le détail dans ta réponse texte. Pour une question de suivi : voice_listen. Ne lis jamais de tableaux ou de JSON."
    : "\n\nVOIX disponible (voice_speak, voice_listen, voice_confirm, voice_stop) : l'utilisateur a écrit ce message ; ne parle que pour une alerte importante.";
  let plan: Task[] = [];
  const whitelist = def.externalTools ?? [];
  const context = typeof req.body?.context === 'string' ? req.body.context.slice(0, 3000) : '';
  const memory = await readMemory(appId);
  const askConfirm = (t: HubTool, args: unknown) => new Promise<boolean>((resolve) => {
    if (chatMode === 'ask') { resolve(false); return; }
    const callId = randomUUID();
    const timer = setTimeout(() => { pendingConfirm.delete(callId); resolve(false); }, 120_000);
    pendingConfirm.set(callId, { appId, resolve: (ok) => { clearTimeout(timer); pendingConfirm.delete(callId); resolve(ok); }, timer });
    ac.signal.addEventListener('abort', () => pendingConfirm.get(callId)?.resolve(false), { once: true });
    emit({ type: 'confirm', callId, tool: t.server.startsWith('app-') ? t.name : t.id, args });
  });
  try {
    const ctx = {
      voice: voiceOn && !!req.body?.voice,
      def: { ...def, name: relabelText(def.name ?? 'Assistant').trim() || 'Assistant', instructions: relabelText(def.instructions) + LABEL_RULES + AVAIL_RULES + (hasSource ? SOURCE_RULES + sourceIdentity(srcCfg) : '') + crewMemoryNote(appId) + memoryContext(memory) + voiceNote + (chatMode === 'ask' ? ASK_MODE_RULES : '') + (context ? `\n\nÉtat actuel du dashboard (JSON) : ${context}` : '') }, tools, message, memory, history: req.body?.history, emit, signal: ac.signal,
      callTool: async (t: HubTool, args: unknown, confirmed: boolean) => {
        const t0 = Date.now();
        if (chatMode === 'ask' && (t.write || (t.server === 'foreman' && t.name === 'evolve_app') || (t.server === 'ui' && /action/.test(t.name)))) {
          throw new Error('Mode Ask : lecture seule. Passe en mode Agent pour écrire ou faire évoluer l’interface.');
        }
        if (t.server === 'foreman') {
          const x = (args ?? {}) as { tasks?: unknown[]; index?: number; status?: Task['status']; note?: string; request?: string; command?: string };
          if (t.name === 'plan_tasks') {
            plan = (Array.isArray(x.tasks) ? x.tasks : []).slice(0, 8).map((title, i) => ({ id: String(i + 1), title: String(title).slice(0, 120), status: 'todo' as const }));
            emit({ type: 'plan', tasks: plan }); return { ok: true, taches: plan.length };
          }
          if (t.name === 'update_task') {
            const k = plan[Number(x.index) - 1]; if (!k) throw new Error('tâche inconnue');
            k.status = x.status ?? 'done'; if (x.note) k.note = String(x.note).slice(0, 200);
            emit({ type: 'plan', tasks: plan }); return { ok: true };
          }
          if (t.name === 'evolve_app') {
            if (chatMode === 'ask') throw new Error('Mode Ask : lecture seule. Passe en mode Agent pour faire évoluer l’interface.');
            const request = String(x.request ?? message).slice(0, 2000);
            emit({ type: 'iterate', request });
            void log(appId, { source: 'agent', tool: 'foreman.evolve_app', args, ok: true, ms: 0 });
            return { delegue: true, equipe: 'Data Engineer → Product Owner → Développeur (CLI shadcn, build)', note: "L'équipe démarre dès la fin de ta réponse ; l'aperçu se rechargera sur la nouvelle version. Termine par un compte rendu court." };
          }
          if (t.name === 'app_cli') {
            const r = await runAppCli(appId, String(x.command ?? ''));
            emit({ type: 'cli', command: r.command, ok: r.ok, output: r.output.slice(0, 2000) });
            void log(appId, { source: 'agent', tool: 'foreman.app_cli', args, ok: r.ok, ms: Date.now() - t0, result: short(r.output) });
            return r;
          }
        }
        if (t.server === 'retrieval') {
          const x = (args ?? {}) as { server?: string; uri?: string; tool?: string; args?: Record<string, unknown> };
          if (t.name === 'mcp_list_tools') {
            const d = await discover(own, whitelist);
            return { backend_app: d.own.map((o) => ({ id: o.name, description: o.description, ecriture: o.write })), serveurs_autorises: d.servers,
              outils: d.ext.map((o) => ({ id: o.id, description: o.description, ecriture: o.write, ecriture_autorisee: o.writable, schema: o.inputSchema })) };
          }
          if (t.name === 'mcp_list_resources') {
            const servers = allowedServers(whitelist);
            return servers.length ? { ressources: await hubJson(`/resources?servers=${encodeURIComponent(servers.join(','))}`) } : { ressources: [], note: 'aucun serveur MCP externe autorisé pour cette app' };
          }
          if (t.name === 'mcp_read_resource') {
            if (!allowedServers(whitelist).includes(String(x.server))) throw new Error(`serveur hors liste blanche de l'app : ${x.server}`);
            const r = await hubJson('/resources/read', { method: 'POST', body: JSON.stringify({ server: x.server, uri: x.uri }) }) as { data: unknown };
            void log(appId, { source: 'agent', tool: `ressource ${x.server} ${x.uri}`, args, ok: true, ms: Date.now() - t0, result: short(r.data) });
            return { source: `${x.server} › ${x.uri}`, data: r.data };
          }
          if (t.name === 'mcp_call') {
            const id = String(x.tool ?? '');
            const target = own.find((o) => o.name === id || o.id === id) ?? (await discover(own, whitelist)).ext.find((o) => o.id === id);
            if (!target) throw new Error(`outil non disponible pour cette app : ${id} (voir mcp_list_tools)`);
            if (chatMode === 'ask' && target.write) throw new Error('Mode Ask : lecture seule. Passe en mode Agent pour écrire.');
            const isOwn = target.server.startsWith('app-');
            // Lectures externes : args allégés (évite les dumps). Backend d'app (ingest) : on laisse passer.
            const prepared = isOwn ? { args: (x.args ?? {}) as Record<string, unknown>, trimmed: false } : prepareCallArgs(x.args, target.inputSchema);
            let confirmed = false;
            if (target.write && !(isOwn && target.safe)) {
              if (!isOwn && !whitelist.includes(target.id)) throw new Error(`écriture non autorisée pour cette app : ${id}`);
              confirmed = await askConfirm(target, prepared.args);
              if (!confirmed) throw new Error("refusé par l'utilisateur");
            }
            let r: Awaited<ReturnType<typeof callHub>>;
            try {
              r = await callHub(target.id, prepared.args, confirmed || (target.write && target.safe && isOwn));
            } catch (e) {
              if (isOwn || !/volumineux|too large|413|argument/i.test((e as Error).message ?? '')) throw e;
              r = await callHub(target.id, slimArgs(prepared.args, 2_000).args, confirmed || (target.write && target.safe && isOwn));
            }
            const data = isOwn ? r.data : compactSample(r.data, 12_000).echantillon;
            void log(appId, { source: 'agent', tool: isOwn ? target.name : target.id, args: prepared.args, ok: true, ms: r.ms ?? Date.now() - t0, result: short(data), confirmed: confirmed || undefined });
            return { source: sourceLabel(target), data, ...(prepared.trimmed ? { note: 'arguments allégés' } : {}) };
          }
        }
        if (t.server === 'source') {
          const x = (args ?? {}) as { workflowId?: string; triggerNodeName?: string; query?: Record<string, unknown>; executionId?: string; ingest?: boolean };
          const progress = (m: string) => emit({ type: 'progress', text: m });
          if (t.name === 'refresh_data') {
            const src = await appSource(A);
            const over: Partial<SourceCfg> = { workflowId: x.workflowId, triggerNodeName: x.triggerNodeName };
            if (x.query && typeof x.query === 'object') over.webhookData = { ...(src?.cfg.webhookData ?? { method: 'GET' }), query: { ...((src?.cfg.webhookData?.query as object) ?? {}), ...x.query } };
            return sourcePipeline(A, { execute: true, confirmed, over, signal: ac.signal, onProgress: progress, origin: 'agent' });
          }
          return sourcePipeline(A, { execute: false, confirmed: false, executionId: String(x.executionId ?? ''), over: { workflowId: x.workflowId }, signal: ac.signal, onProgress: progress, origin: 'agent' });
        }
        if (t.server === 'voice') {
          const r = await callVoice(appId, t.name, (args ?? {}) as Record<string, unknown>);
          emit({ type: 'voice', tool: `voice.${t.name}`, args, result: r });
          void log(appId, { source: 'agent', tool: `voice.${t.name}`, args, ok: r.ok !== false, ms: Date.now() - t0, result: short(r) });
          return r;
        }
        if (t.server === 'ui' && t.name !== 'set_dashboard') {
          const x = (args ?? {}) as Record<string, any>;
          if (JSON.stringify(x).length > 60_000) throw new Error('données trop volumineuses pour l’interface (agréger d’abord)');
          let patch: Record<string, unknown>;
          if (t.name === 'render_action') {
            if (!(ACTION_COMPONENTS as readonly string[]).includes(String(x.component))) throw new Error(`composant non autorisé : ${x.component}`);
            patch = { __action: { op: 'render', spec: { id: String(x.id), component: x.component, props: x.props ?? {}, zone: x.zone === 'chat' ? 'chat' : 'dashboard' } } };
          } else if (t.name === 'update_action') patch = { __action: { op: 'update', id: String(x.id), props: x.props ?? {} } };
          else if (t.name === 'remove_action') patch = { __action: { op: 'remove', id: String(x.id) } };
          else if (t.name === 'render_scene') {
            if (x.kind !== 'pixi' && x.kind !== 'three') throw new Error("kind : 'pixi' ou 'three'");
            patch = { __scene: { op: 'render', spec: { id: String(x.id), kind: x.kind, scene: String(x.scene), title: x.title, data: x.data, params: x.params ?? {} } } };
          } else if (t.name === 'update_scene') patch = { __scene: { op: 'update', id: String(x.id), data: x.data, params: x.params, title: x.title } };
          else patch = { __scene: { op: 'remove', id: String(x.id) } };
          emit({ type: 'ui', patch });
          void log(appId, { source: 'agent', tool: `ui.${t.name}`, args: { ...x, data: x.data ? '…' : undefined }, ok: true, ms: 0 });
          return { ok: true, affiche: t.name.replace('_', ' '), id: x.id };
        }
        if (t.server === 'ui') {
          const patch = (args as { patch?: unknown })?.patch;
          if (!patch || typeof patch !== 'object' || Array.isArray(patch) || JSON.stringify(patch).length > 4000) throw new Error('patch : objet attendu');
          emit({ type: 'ui', patch: patch as Record<string, unknown> });
          void log(appId, { source: 'agent', tool: 'ui.set_dashboard', args, ok: true, ms: 0 });
          return { ok: true, applique: patch };
        }
        if (t.server === 'memory') {
          const data = t.name === 'remember' ? await remember(appId, String((args as { fact?: string })?.fact ?? '')) : await readMemory(appId);
          void log(appId, { source: 'agent', tool: `memory.${t.name}`, args, ok: true, ms: Date.now() - t0, result: short(data) });
          return data;
        }
        try {
          const r = await callHub(t.id, args, confirmed || (t.write && t.safe && t.server.startsWith('app-')));
          void log(appId, { source: 'agent', tool: t.server.startsWith('app-') ? t.name : t.id, args, ok: true, ms: r.ms ?? Date.now() - t0, result: short(r.data), confirmed: confirmed || undefined });
          return r.data;
        } catch (e) {
          void log(appId, { source: 'agent', tool: t.name, args, ok: false, ms: Date.now() - t0, error: (e as Error).message });
          throw e;
        }
      },
      askConfirm,
    };
    if (CFG) await runLlmAgent({ ...ctx, maxSteps: MAX_STEPS }, CFG); else await runScriptedAgent({ ...ctx, maxSteps: MAX_STEPS });
  } catch (e) {
    emit({ type: 'error', message: (e as Error).message });
  } finally {
    running.set(appId, Math.max(0, (running.get(appId) ?? 1) - 1));
    clearInterval(ping); clearTimeout(deadline);
    reply.raw.end();
  }
});

// Pad « Rafraîchir » (studio) : la confirmation a déjà été donnée dans le studio.
app.post<{ Params: { id: string }; Body: { confirmed?: boolean; executionId?: string; workflowId?: string; triggerNodeName?: string; webhookData?: Record<string, unknown>; version?: number } }>('/apps/:id/refresh', async (req, reply) => {
  try {
    const a = await ensureApp(req.params.id, req.body?.version);
    const b: any = req.body ?? {};
    const over: Partial<SourceCfg> = { workflowId: b.workflowId, triggerNodeName: b.triggerNodeName };
    if (b.webhookData && typeof b.webhookData === 'object') {
      const src = await appSource(a);
      const base = src?.cfg.webhookData ?? {};
      over.webhookData = { ...base, ...b.webhookData, query: { ...((base.query as object) ?? {}), ...((b.webhookData.query as object) ?? {}) } };
    }
    return await sourcePipeline(a, { execute: !b.executionId, confirmed: b.confirmed === true, executionId: b.executionId, over, origin: 'ui' });
  } catch (e) { return fail(reply, e); }
});
app.get<{ Params: { id: string } }>('/apps/:id/source', async (req, reply) => {
  try { const a = await ensureApp(req.params.id); const s = await appSource(a); return s ? { ...s.cfg, ingestion: ingestToolOf(appTools(a.tools))?.tool.name ?? null } : { source: null }; }
  catch (e) { return fail(reply, e); }
});

app.post<{ Params: { id: string }; Body: { callId: string; ok: boolean } }>('/apps/:id/confirm', async (req, reply) => {
  const p = pendingConfirm.get(String(req.body?.callId));
  if (!p || p.appId !== req.params.id) return reply.code(404).send({ error: 'demande inconnue ou expirée' });
  p.resolve(req.body.ok === true);
  return { ok: true };
});

app.get<{ Params: { id: string } }>('/apps/:id/log', async (req) => readLog(req.params.id));

// Mémoire personnelle : lecture, ajout manuel depuis le studio, oubli d'un fait.
app.get<{ Params: { id: string } }>('/apps/:id/memory', async (req) => readMemory(req.params.id));
app.post<{ Params: { id: string }; Body: { fact?: string; forget?: number } }>('/apps/:id/memory', async (req, reply) => {
  try {
    if (typeof req.body?.forget === 'number') return await forgetFact(req.params.id, req.body.forget);
    return await remember(req.params.id, String(req.body?.fact ?? ''), 'studio');
  } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
});

app.delete<{ Params: { id: string }; Querystring: { data?: string } }>('/apps/:id', async (req) => {
  await stopApp(req.params.id, req.query.data === '1');
  return { stopped: true };
});

app.listen({ port: PORT, host: BIND_HOST }).then(() => console.log(`[app-agents] prêt sur :${PORT}`));
