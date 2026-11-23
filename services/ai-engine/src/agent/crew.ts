/**
 * Équipe agentique « réelle » : OpenAI Agents SDK (@openai/agents) branché sur une API compatible OpenAI
 * (Mercury 3 d'Inception par défaut). Chaîne : Data Engineer → Product Owner → Lead dev (atomes → page) → revue PO (≤ 2 reprises).
 */
import OpenAI from 'openai';
import { Agent, Runner, tool, setTracingDisabled, OpenAIChatCompletionsModel, MaxTurnsExceededError, type Tool } from '@openai/agents';
import { retryPolicies } from '@openai/agents-core';
import { z } from 'zod';
import type { McpClient } from '../mcp.ts';
import { Toolbox } from './toolbox.ts';
import { DATA_ENGINEER, DEVELOPER, DEV_FIX, DEV_INCREMENTAL, LAYER_ATOMES, LAYER_DONNEES, LAYER_MOLECULES, LAYER_ORGANISMES, LEAD_DEV, MCP_LIAISON, PO_REVIEW, PO_REVIEW_INCREMENTAL, PRODUCT_OWNER, PRODUCT_OWNER_DELTA } from './prompts.ts';
import { seedFromSamples } from './seed-from-samples.ts';
import { applyContractDiff, buildMemory, changedFiles, extractCriteria, integrateBackendTools, isIncremental, loadMemory, memoryMarkdown, needsNewSource, nextCriterionId, parseContractDiff, retroMemory, saveMemory, type CrewMemory } from './app-memory.ts';
import { ROLE_LABEL, componentsFromSpec, importsOf, profileDatasets, type AgentEvent, type AgentRole, type Dataset } from './events.ts';
import { addCards, finish, fluxLine, openBoard, pull, requeue, reopen, view } from './kanban.ts';
import { SHADCN_COMPONENTS, Workspace } from './workspace.ts';
import { buildAgentDef, coherence, normalizeContract, parseContract, type AgentDef, type Contract } from '../../../../packages/app-mcp/src/core.mjs';
import { findDjLabels } from './ui-labels';
import { say } from './speech.ts';
import { ensureAppShell } from './imports-check.ts';
setTracingDisabled(true);

/** Passes de correction automatique quand le build / les imports / le smoke render échouent. */
export const BUILD_FIX_PASSES = Number(process.env.ES_BUILD_FIX_PASSES ?? 2);

export type CrewConfig = { baseUrl: string; apiKey: string; model: string; reasoningEffort?: string; maxRework?: number };
export type CrewInput = {
  prompt: string; useTools?: boolean;
  /** Données personnelles importées dans le studio (CSV/JSON), amorcées dans la base de l'app. */
  datasets?: Dataset[];
  previous?: { files?: Record<string, string>; components?: string[]; spec?: string; brief?: string; contract?: Contract | null };
  /** App existante (mémoire persistante de la crew : data/apps/<appId>/crew-memory.json). */
  appId?: string; previousVersion?: number;
  /** Forcer le mode complet (ignorer la mémoire). */
  fullRebuild?: boolean;
};

/** Lignes ajoutées/modifiées d'un fichier (diff ligne à ligne grossier, pour la revue incrémentale). */
export function changedLinesExcerpt(before: string, after: string, max = 6000) {
  const old = new Set(before.split('\n').map((l) => l.trim()));
  const out: string[] = [];
  after.split('\n').forEach((l, i) => { if (l.trim() && !old.has(l.trim())) out.push(`${i + 1}+ ${l}`); });
  const s = out.join('\n');
  return s.length > max ? s.slice(0, max) + '\n…(tronqué)' : s;
}
export type AppBundle = { contract: Contract; agent: AgentDef; backend: 'server/tools.ts'; backendOk: boolean; title: string; seed?: Record<string, Array<Record<string, unknown>>> };

export const specTitle = (spec: string, fallback: string) => ((/^#\s+(.+)$/m.exec(spec)?.[1]) ?? fallback).replace(/^\s*(mini[- ]?spec|sp[ée]cification|spec)\s*[—:–-]\s*/i, '').replace(/[*_`]/g, '').trim().slice(0, 80);

/** Rappel injecté aux messages PO / Dev : UI dérivée du prompt + schéma MCP, pas d'un template. */
export const ALIGN_NOTE = `ALIGNEMENT OBLIGATOIRE : chaque KPI, graphique, colonne et curseur cite un champ du brief ou une intention du prompt. Interdit de copier un modèle générique (metrics / date / valeur / price_change_pct / « vs moyenne ») s'il est absent du brief. Intention non couverte → empty state, jamais de faux chiffre.`;

/** Détecte un front encore calqué sur le template générique alors que le contrat est métier. */
export function alignmentSmell(contract: Contract, appCode: string, brief = '') {
  const code = appCode.toLowerCase();
  const briefL = brief.toLowerCase();
  const entityFields = (contract.entities ?? []).flatMap((e: any) => Object.keys(e?.fields ?? {})).map((f) => f.toLowerCase());
  const domain = entityFields.filter((f) => !['date', 'valeur', 'id', 'name', 'params', 'action', 'statut', 'createdat'].includes(f));
  const smells: string[] = [];
  if (domain.length && /\bprice_change_pct\b/.test(code) && !domain.includes('price_change_pct') && !/price_change_pct/.test(briefL)) {
    smells.push('curseur price_change_pct hors brief/contrat métier');
  }
  if (domain.length >= 2 && /\b(get_kpis|ingest_metrics)\b/.test(code) && !contract.tools.some((t) => /^(get_kpis|ingest_metrics)$/.test(t.name))) {
    smells.push('handlers génériques metrics/kpis alors que le contrat est métier');
  }
  const genericUi = (/\bvs moyenne\b/i.test(appCode) || /dataKey=["']valeur["']/.test(appCode)) && domain.length >= 2 && !entityFields.includes('valeur');
  if (genericUi) smells.push('UI générique date/valeur ou « vs moyenne » sans champ valeur au contrat');
  return smells;
}

/** Critères de cohérence front / backend MCP / agent (ajoutés à la revue du PO). */
export function coherenceCriteria(contract: Contract, appCode: string, backend: { ok: boolean; tools: string[]; problems: string[] } | null, brief = '') {
  const c = coherence({ contract, appCode, backendTools: backend?.tools ?? [] });
  const smells = alignmentSmell(contract, appCode, brief);
  return [
    { id: 'COH-backend', ok: !!backend?.ok && c.backend.ok, note: backend?.ok ? `backend MCP conforme (${backend.tools.join(', ')})` : `backend : ${(backend?.problems ?? ['non testé']).slice(0, 3).join(' ; ')}` },
    { id: 'COH-front', ok: c.front.ok, note: c.front.ok ? `front → outils ${c.front.used.join(', ')}` : c.front.unknown.length ? `outils hors contrat appelés : ${c.front.unknown.join(', ')}` : "le front n'appelle aucun outil via window.app.call" },
    { id: 'COH-agent', ok: c.agent.ok && (c.usesAgent || c.shell), note: !(c.usesAgent || c.shell) ? "aucune zone agent (window.agent.ask / AppShell) dans le front" : c.agent.ok ? `agent : ${contract.agent.tools.join(', ')}` : `outils d'agent hors contrat : ${c.agent.unknown.join(', ')}` },
    // Principes de conception (analogie interne, jamais visible) : actualisation live, simulation instantanée, libellés métier.
    ...(contract.console?.decks?.length ? [{ id: 'LIVE-actualisation', ok: c.live, note: c.live ? 'sources de données actualisées en continu (setInterval)' : 'aucune actualisation automatique des sources (setInterval)' }] : []),
    ...(contract.console?.knobs?.length ? [{ id: 'SIM-instantanée', ok: c.knobs, note: c.knobs ? 'curseurs de simulation (Slider) à effet instantané' : 'curseurs de simulation absents (Slider shadcn)' }] : []),
    (() => { const dj = findDjLabels(appCode); return { id: 'LIB-métier', ok: dj.length === 0, note: dj.length ? `libellés DJ visibles à renommer en termes métier : ${dj.slice(0, 4).join(' ; ')}` : 'libellés visibles en termes métier (aucun vocabulaire DJ)' }; })(),
    // Layout imposé : dashboard + chat agentique (AppShell du template).
    { id: 'DASH-chat', ok: c.shell, note: c.shell ? 'AppShell : dashboard + chat agentique' : "layout dashboard + chat absent (AppShell de '@/components/es/app-shell')" },
    ...(contract.charts.length ? [{ id: 'COH-chart', ok: c.usesChart, note: c.usesChart ? 'graphique shadcn/ui Charts présent' : `graphique prévu (${contract.charts[0]}) mais absent du front` }] : []),
    { id: 'ALIGN-données', ok: smells.length === 0, note: smells.length ? `désalignement prompt/données : ${smells.slice(0, 3).join(' ; ')}` : 'UI alignée sur le contrat / brief (pas de template générique parasite)' },
  ];
}

export const ATOMIC_LAYERS = ['donnees', 'atomes', 'molecules', 'organismes', 'page'] as const;
export type AtomicLayer = typeof ATOMIC_LAYERS[number];
const ATOMIC_MISSION: Record<AtomicLayer, string> = {
  donnees: 'Écris les outils du contrat. Les filtres sont optional: true. Aucun champ inventé.',
  atomes: 'Exporte KpiValue, StatusMark et EmptyNote. Présentation seule.',
  molecules: 'Exporte KpiCard et FilterBar à partir des atomes. Aucun appel de données.',
  organismes: 'Exporte ChartPanel, TablePanel et ActionRow. Les données arrivent en props.',
  page: 'Compose les organismes et branche window.app.call.',
};
const ATOMIC_WORD: Record<AtomicLayer, string> = { donnees: 'données', atomes: 'atomes', molecules: 'molécules', organismes: 'organismes', page: 'page' };

/** Le lead propose les missions. L'ordre atomique et les couches obligatoires sont des murs. */
export function settleLayers(opts: { incremental: boolean; newTools?: string[]; planned?: Array<{ id?: string; mission?: string }>; hasOrganisms?: boolean }): Array<{ id: AtomicLayer; mission: string }> {
  const mission = new Map<AtomicLayer, string>();
  for (const p of opts.planned ?? []) {
    if (!p?.id || !(ATOMIC_LAYERS as readonly string[]).includes(p.id)) continue;
    const text = String(p.mission ?? '').replace(/\s+/g, ' ').trim().slice(0, 280);
    if (text) mission.set(p.id as AtomicLayer, text);
  }
  const one = (id: AtomicLayer) => ({ id, mission: mission.get(id) || ATOMIC_MISSION[id] });
  if (!opts.incremental) return ATOMIC_LAYERS.map(one);
  const ids: AtomicLayer[] = [];
  if ((opts.newTools ?? []).length) ids.push('donnees');
  if (opts.hasOrganisms && mission.has('organismes')) ids.push('organismes');
  ids.push('page');
  return ids.map(one);
}

const json = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
const safeJson = (s: string) => { const m = /\{[\s\S]*\}/.exec(s); try { return m ? JSON.parse(m[0]) : null; } catch { return null; } };

export async function runCrew(input: CrewInput, cfg: CrewConfig, ctx: { mcp?: McpClient; emit: (e: AgentEvent | Record<string, unknown>) => void; signal?: AbortSignal }) {
  const client = new OpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey, timeout: 180_000, maxRetries: 1 });
  const model = new OpenAIChatCompletionsModel(client as never, cfg.model);
  const runner = new Runner({ tracingDisabled: true, model });
  const settings = (maxTokens: number, extra?: { toolChoice?: 'auto' | 'required' | 'none' }) => ({
    maxTokens, toolChoice: extra?.toolChoice, parallelToolCalls: false,
    providerData: cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : undefined,
    retry: { maxRetries: 2, policy: retryPolicies.networkError() },
  });
  let toolCalls = 0;
  const emit = ((e: AgentEvent) => { if ((e as { kind?: string }).kind === 'tool') toolCalls++; ctx.emit(e); }) as (e: AgentEvent) => void;
  const t0 = Date.now();
  const ws = await Workspace.create({ files: input.previous?.files, components: input.previous?.components });
  const tb = new Toolbox(ws, input.useTools === false ? undefined : ctx.mcp, emit);
  const role = (r: AgentRole, iteration?: number) => emit({ type: 'agent', kind: 'role', role: r, label: ROLE_LABEL[r], iteration });
  const wrap = async <T>(fn: () => Promise<T>) => { try { return await fn(); } catch (e) { return `ERREUR : ${(e as Error).message}`; } };

  const mcpTools = (r: AgentRole): Tool[] => [
    tool({ name: 'mcp_list_tools', description: 'Liste les outils MCP autorisés (id, description, schéma, lecture/écriture).', parameters: z.object({}), execute: async () => json(await wrap(() => tb.listMcpTools(r))) }),
    tool({
      name: 'mcp_call', description: 'Appelle un outil MCP en LECTURE seule pour échantillonner des données. Args MINIMAUX (ids + pagination ≤ 5) — jamais de dump.',
      parameters: z.object({ tool: z.string().describe("id de l'outil, ex. demo__get_weather"), args: z.string().describe('arguments JSON COURTS, ex. {"city":"Lyon"} ou {"limit":5} — pas de payload volumineux') }),
      execute: async ({ tool: t, args }) => json(await wrap(() => tb.sampleMcp(r, t, safeJson(args) ?? {}))),
    }),
  ];
  const fileTools = (r: AgentRole): Tool[] => [
    tool({ name: 'read_file', description: 'Lit un fichier du workspace (chemin relatif, ex. src/App.tsx).', parameters: z.object({ path: z.string() }), execute: async ({ path }) => json(await wrap(() => tb.readFile(r, path))) }),
    tool({ name: 'list_files', description: 'Liste les fichiers sous src/.', parameters: z.object({}), execute: async () => json(await wrap(() => tb.listFiles(r))) }),
    tool({ name: 'read_lines', description: 'Lit une PLAGE de lignes numérotées (1-indexées, incluses) — préfère-la à read_file pour les gros fichiers.', parameters: z.object({ path: z.string(), from: z.number(), to: z.number() }), execute: async ({ path, from, to }) => json(await wrap(() => tb.readRange(r, path, from, to))) }),
    tool({ name: 'search_code', description: 'Cherche un texte (insensible à la casse) dans src/ et server/tools.ts ; renvoie fichier:ligne: extrait.', parameters: z.object({ pattern: z.string() }), execute: async ({ pattern }) => json(await wrap(() => tb.searchCode(r, pattern))) }),
  ];
  const devTools: Tool[] = [
    tool({
      name: 'dashboard_add',
      description: 'Installe des blocs shadcndashboard (registre @shadcn-dashboard) : sidebar-01, total-sales-card, revenue-growth-card, sales-trend-chart, area-chart-01, bar-chart-01, line-chart-01, table-01, datatable-01.',
      parameters: z.object({ blocks: z.array(z.string()) }),
      execute: async ({ blocks }) => json(await wrap(() => tb.dashboardAdd(blocks))),
    }),
    tool({ name: 'shadcn_add', description: 'Exécute `npx shadcn@latest add <composants>` (primitives : button, badge, select, chart…).', parameters: z.object({ components: z.array(z.string()) }), execute: async ({ components }) => json(await wrap(() => tb.shadcnAdd(components))) }),
    tool({ name: 'write_file', description: 'Écrit un fichier complet sous src/ (nouveau fichier ou réécriture assumée).', parameters: z.object({ path: z.string(), content: z.string() }), execute: async ({ path, content }) => json(await wrap(() => tb.writeFile(path, content))) }),
    tool({ name: 'edit_file', description: 'Patch ciblé : remplace UNE occurrence exacte et unique de `find` par `replace` dans un fichier existant.', parameters: z.object({ path: z.string(), find: z.string(), replace: z.string() }), execute: async ({ path, find, replace }) => json(await wrap(() => tb.editFile(path, [{ find, replace }]))) }),
    tool({ name: 'insert_code', description: 'Insère du code juste après (position "after") ou avant ("before") un ancrage exact et unique.', parameters: z.object({ path: z.string(), anchor: z.string(), position: z.enum(['after', 'before']), code: z.string() }), execute: async ({ path, anchor, position, code }) => json(await wrap(() => tb.editFile(path, [position === 'before' ? { before: anchor, insert: code } : { after: anchor, insert: code }]))) }),
    ...fileTools('dev'),
    tool({ name: 'build', description: 'Lance `vite build` et renvoie le résultat ou les erreurs.', parameters: z.object({}), execute: async () => json(await wrap(() => tb.build())) }),
  ];

  const dropped = (e: unknown) => {
    const parts: string[] = [];
    let cur: unknown = e;
    for (let i = 0; i < 6 && cur && typeof cur === 'object'; i++) {
      const o = cur as { message?: unknown; code?: unknown; cause?: unknown };
      if (o.message) parts.push(String(o.message));
      if (o.code) parts.push(String(o.code));
      cur = o.cause;
    }
    const m = parts.join(' ').toLowerCase();
    return m.includes('terminated') || m.includes('socket hang up') || m.includes('fetch failed') || m.includes('connection error') || m.includes('econnreset') || m.includes('econnrefused') || m.includes('other side closed') || m.includes('und_err_');
  };
  // La voix entre agents reste binaire à l'écran. Elle n'est pas recollée dans le prompt : ce doublon rallongeait chaque appel.
  const parole = (role: AgentRole, words: string) => {
    const clean = words.replace(/\s+/g, ' ').trim().slice(0, 180);
    if (!clean) return '';
    const bits = say(clean);
    emit({ type: 'agent', kind: 'message', role, text: bits });
    return bits;
  };
  /** Un Runner SDK : tools, tours, arrêt. Le flux n'est ouvert que pour le texte affiché. Une coupure réseau est rejouée une fois. */
  async function exec(agent: Agent<any, any>, r: AgentRole, msg: string, maxTurns: number, onText?: (d: string) => void, done?: () => boolean) {
    const once = async () => {
      if (!onText) {
        const res = await runner.run(agent, msg, { maxTurns, signal: ctx.signal });
        return String(res.finalOutput ?? '').trim();
      }
      const res = await runner.run(agent, msg, { stream: true, maxTurns, signal: ctx.signal });
      // `completed` rejette aussi quand le flux casse. Sans ceci, Node quitte et la passerelle ne voit que « terminated ».
      const finished = res.completed.then(() => undefined, () => undefined);
      try {
        for await (const ev of res) {
          if (ev.type === 'raw_model_stream_event' && (ev.data as { type?: string }).type === 'output_text_delta') onText((ev.data as { delta: string }).delta);
        }
        await res.completed;
      } catch (e) {
        await finished;
        throw e;
      }
      return String(res.finalOutput ?? '').trim();
    };
    try {
      return await once();
    } catch (e) {
      if (e instanceof MaxTurnsExceededError && r === 'dev' && (done?.() || ws.files.has('src/App.tsx'))) return '';
      if (!dropped(e) || ctx.signal?.aborted) throw e;
      try { return await once(); }
      catch (e2) {
        if (e2 instanceof MaxTurnsExceededError && r === 'dev' && (done?.() || ws.files.has('src/App.tsx'))) return '';
        if (dropped(e2) && !ctx.signal?.aborted) throw new Error('La liaison avec le modèle a été coupée. Relance la génération.');
        throw e2;
      }
    }
  }

  // 0) Mémoire persistante de l'app : ce qui a déjà été construit (source, schéma réel, contrat, fichiers, CA livrés)
  const prev = input.previous;
  const hasPrev = !!prev?.files && Object.keys(prev.files).length > 0;
  let mem: CrewMemory | null = input.fullRebuild ? null : loadMemory(input.appId);
  if (hasPrev && !mem && !input.fullRebuild) {
    // Première évolution depuis la mise en place de la mémoire : mémoire rétroactive à partir de la version précédente
    mem = retroMemory(input.appId ?? 'app-sans-identifiant', { number: input.previousVersion ?? 1, prompt: '', plan: prev!.spec ?? '', files: prev!.files, agent: { brief: prev!.brief ?? '' }, app: { contract: prev!.contract } });
    if (input.appId) await saveMemory(mem).catch(() => {});
  }
  const incremental = !input.fullRebuild && isIncremental(input.prompt, hasPrev, mem) && !!(prev?.contract ?? mem?.contract);
  const mode: 'incrémental' | 'complet' = incremental ? 'incrémental' : 'complet';
  const memCompact = mem ? memoryMarkdown(mem, { compact: true }) : '';
  if (incremental && mem) emit({ type: 'agent', kind: 'memory', role: 'data', mode, version: mem.version, text: `Mode incrémental · mémoire de l'app v${mem.version} chargée : ${mem.files.length} fichier(s), ${mem.criteria.length} critère(s) déjà livré(s), schéma ${mem.brief.schemaStatus}${mem.brief.source?.workflowId ? `, source n8n ${mem.brief.source.workflowId}` : ''}.` });

  // Tableau : une carte se termine avant que la suivante s'ouvre. Les agents restent ceux de la crew.
  const board = openBoard([{ id: 'liaison', title: 'Liaison MCP' }, { id: 'profil', title: 'Profil des données' }, { id: 'fiche', title: 'Fiche' }], t0);
  const showBoard = () => emit({ type: 'agent', kind: 'kanban', role: 'dev', ...view(board) });
  const take = (id: string) => {
    const next = board.cards.find((card) => card.column === 'todo');
    if (next?.id !== id) throw new Error(`La carte « ${id} » n'est pas la prochaine.`);
    const got = pull(board);
    if (!got.ok) throw new Error(`La carte « ${id} » ne peut pas s'ouvrir (${got.reason}).`);
    showBoard();
  };
  showBoard();

  // 1) Liaison MCP : les lectures, une à la fois. Le Data Engineer ne parle pas aux serveurs.
  take('liaison');
  role('data');
  const profile = profileDatasets(input.datasets);
  const reuseBrief = incremental && !!mem && !needsNewSource(input.prompt, mem) && !profile && !!(mem.brief.text || mem.brief.schema.length);
  const tools = reuseBrief ? [] : await tb.mcpTools();
  let liaisonSheet = '';
  if (reuseBrief) liaisonSheet = 'Liaison sautée : les échantillons de la version précédente suffisent.';
  else if (!tools.length && !profile) liaisonSheet = 'Aucune source MCP connectée.';
  else if (!tools.length) liaisonSheet = 'Pas d\'outil MCP. Seulement les fichiers importés.';
  else {
    const liaison = new Agent({
      name: 'Liaison MCP',
      handoffDescription: 'Appelle les serveurs MCP un par un et rend la fiche d\'échantillons.',
      instructions: MCP_LIAISON,
      model,
      tools: mcpTools('data'),
      modelSettings: settings(1800, { toolChoice: 'required' }),
      resetToolChoice: false,
      toolUseBehavior: () => tb.mcpSamples.length >= 3
        ? { isFinalOutput: true, isInterrupted: undefined, finalOutput: 'Trois lectures. La fiche s\'arrête ici.' }
        : { isFinalOutput: false, isInterrupted: undefined },
    });
    liaisonSheet = await exec(liaison, 'data', `Demande : « ${input.prompt} ». Liste les outils, puis au plus 3 lectures, une par tour.`, 4);
  }
  const observed = tb.mcpSamples.map((s) => `### ${s.tool}\nargs ${JSON.stringify(s.args)}\néchantillon ${JSON.stringify(s.result).slice(0, 700)}`).join('\n\n');
  if (observed) liaisonSheet = `${liaisonSheet}\n\n## Échantillons observés\n${observed}`.trim();
  parole('data', `Liaison : ${tb.mcpSamples.length} lecture(s), une à la fois. ${liaisonSheet}`);
  finish(board, 'liaison');
  showBoard();

  // 2) Data Engineer : le profil, à partir de la fiche, sans nouvel appel.
  take('profil');
  let brief: string;
  if (reuseBrief && mem) {
    const schemaMd = mem.brief.schema.length ? `\n\n## Schéma RÉEL observé à l'ingestion (prioritaire sur toute hypothèse)\n| champ | type | exemple |\n|---|---|---|\n${mem.brief.schema.slice(0, 60).map((x) => `| ${x.champ} | ${x.type} | ${String(x.exemple ?? '').replace(/\|/g, '/')} |`).join('\n')}` : '';
    brief = `♻️ Brief réutilisé depuis la mémoire de l'app (v${mem.version}) — pas de ré-exploration des serveurs MCP.${mem.brief.source?.workflowId ? `\nSource : n8n ${mem.brief.source.server ?? ''} · workflow ${mem.brief.source.workflowId}${mem.brief.source.node ? ` · nœud « ${mem.brief.source.node} »` : ''}` : ''}${schemaMd}\n\n${mem.brief.text}`.slice(0, 14000);
  }
  else if (!tools.length && !profile) brief = 'Aucune source MCP pertinente : aucun serveur MCP connecté ni données importées.';
  else if (!tools.length) brief = profile;
  else {
    const de = new Agent({ name: 'Data Engineer', handoffDescription: 'Rédige le profil de données à partir de la fiche de la Liaison MCP.', instructions: DATA_ENGINEER, model, modelSettings: settings(3000) });
    brief = await exec(de, 'data', `Demande de l'utilisateur (app personnelle) : « ${input.prompt} »\n\nFICHE DE LA LIAISON MCP (seule source d'échantillons, déjà lue) :\n${liaisonSheet.slice(0, 8000)}${profile ? `\n\nIl a aussi importé SES données (déjà profilées, à prendre en compte en priorité) :\n${profile}` : ''}${incremental && mem ? `\n\nApp EXISTANTE — ce qui est déjà connu :\n${memCompact.slice(0, 4000)}` : ''}`, 2);
    if (!brief) brief = observed ? `Profil établi depuis la liaison.\n${observed}` : 'Aucune source MCP pertinente : la Liaison n\'a rien trouvé d\'utile.';
    if (profile && !brief.includes('Données personnelles importées')) brief = /^aucune source mcp pertinente/i.test(brief.trim()) ? profile : `${brief}\n\n${profile}`;
  }
  const relevant = !/^aucune source mcp pertinente/i.test(brief.trim());
  parole('data', brief);
  emit({ type: 'agent', kind: 'brief', role: 'data', text: brief, relevant });
  finish(board, 'profil');
  showBoard();

  // 2) Product Owner : spec + CONTRAT unique (front / backend MCP / agent)
  take('fiche');
  role('po');
  ctx.emit({ type: 'phase', phase: 'plan', label: 'Product Owner : spécification et contrat' });
  const po = new Agent({ name: 'Product Ops', handoffDescription: 'Décide la fiche d’exploitation et le contrat, sans écrire de code.', instructions: PRODUCT_OWNER, model, modelSettings: settings(4000) });
  const prevCtx = prev?.spec ? `\n\nApp EXISTANTE à faire évoluer (spec précédente) :\n${prev.spec}\n${prev.contract ? `Contrat ACTUEL (garde les outils existants compatibles, ajoute/modifie ce que la demande exige) :\n${JSON.stringify(prev.contract)}\n` : ''}Fichiers existants : ${Object.keys(prev.files ?? {}).join(', ')}` : '';
  let spec = '';
  let delta = '';
  let contract: Contract | null = null;
  const baseContract = (prev?.contract ?? mem?.contract ?? null) as Contract | null;
  if (incremental && mem && baseContract) {
    const nextCa = nextCriterionId(mem.criteria.length ? mem.criteria : extractCriteria(prev?.spec ?? '', 0));
    const poDelta = new Agent({ name: 'Product Ops (delta)', handoffDescription: 'Décide l’ajout ou le retrait d’un composant.', instructions: PRODUCT_OWNER_DELTA.replace('${NEXT_CA}', nextCa), model, modelSettings: settings(2500) });
    delta = await exec(poDelta, 'po', `${ALIGN_NOTE}\n\nDemande d'évolution : « ${input.prompt} »\n\nMÉMOIRE DE L'APP :\n${memCompact}\n\nContrat courant (JSON) :\n${JSON.stringify(baseContract)}${reuseBrief ? '' : `\n\nBrief données (nouvelle exploration) :\n${brief.slice(0, 6000)}`}`, 2, (d) => ctx.emit({ type: 'plan_delta', text: d }));
    const diff = parseContractDiff(delta);
    const full = diff ? null : parseContract(delta);
    contract = normalizeContract(diff ? applyContractDiff(baseContract, diff) : full ?? baseContract);
    if (!diff && !full) parole('po', 'Spec delta sans bloc Contrat : contrat courant conservé.');
    spec = `${(prev?.spec ?? mem.spec ?? '').trim()}\n\n---\n\n${delta.trim()}`;
  } else {
    spec = await exec(po, 'po', `${ALIGN_NOTE}\n\nDemande : « ${input.prompt} »${prevCtx}\n\nBrief données du Data Engineer :\n${brief}`, 3, (d) => ctx.emit({ type: 'plan_delta', text: d }));
    contract = parseContract(spec);
  }
  if (!incremental && (!contract || !contract.tools.length)) {
    emit({ type: 'agent', kind: 'contract', role: 'po', contract: null, ok: false, error: 'bloc JSON du contrat absent ou invalide : reformulation' });
    spec = await exec(po, 'po', `${ALIGN_NOTE}\n\nTa spec précédente n'a pas de section « ## Contrat » avec un bloc \`\`\`json valide (avec "tools"). Réécris la spec COMPLÈTE corrigée, ancrée dans le brief (aucun champ inventé).\n\nSpec précédente :\n${spec}\n\nDemande : « ${input.prompt} »\n\nBrief :\n${brief.slice(0, 6000)}`, 3);
    contract = parseContract(spec);
  }
  if (!contract || !contract.tools.length) { await import('node:fs/promises').then((f) => f.writeFile(ws.dir + '/po-spec-invalide.md', spec)).catch(() => {}); }
  if (!contract || !contract.tools.length) throw new Error("Le Product Owner n'a pas produit de contrat valide (bloc JSON « ## Contrat »)");
  ctx.emit({ type: 'plan_done', plan: spec });
  const specComponents = [...new Set([...componentsFromSpec(incremental ? delta : spec, SHADCN_COMPONENTS), ...(!incremental && contract.charts.length ? ['chart'] : [])])];
  emit({ type: 'agent', kind: 'spec', role: 'po', text: incremental ? delta : spec, components: specComponents });
  emit({ type: 'agent', kind: 'contract', role: 'po', contract, ok: true });
  finish(board, 'fiche');
  showBoard();

  // 3) Lead dev → sous-agents (données, atomes, molécules, organismes, page) → revue PO
  const devTools2: Tool[] = [...devTools, tool({ name: 'test_backend', description: 'Teste server/tools.ts : transpilation, conformité au contrat, exécution de chaque outil.', parameters: z.object({}), execute: async () => json(await wrap(() => tb.testBackend('dev', contract))) })];
  const fileOf = (id: AtomicLayer) => id === 'donnees' ? 'server/tools.ts' : id === 'atomes' ? 'src/components/atoms.tsx' : id === 'molecules' ? 'src/components/molecules.tsx' : id === 'organismes' ? 'src/components/organisms.tsx' : 'src/App.tsx';
  const writeOnly = (file: string) => tool({ name: 'write_file', description: `Écrit uniquement ${file}.`, parameters: z.object({ path: z.string(), content: z.string() }), execute: async ({ path, content }) => path === file ? json(await wrap(() => tb.writeFile(path, content))) : `ERREUR : cette passe n'écrit que ${file}` });
  const dashTool = tool({ name: 'dashboard_add', description: 'Installe des blocs shadcndashboard nommés par la mission.', parameters: z.object({ blocks: z.array(z.string()) }), execute: async ({ blocks }) => json(await wrap(() => tb.dashboardAdd(blocks))) });
  const layerFiles = new Set(['server/tools.ts', 'src/components/atoms.tsx', 'src/components/molecules.tsx', 'src/components/organisms.tsx', 'src/App.tsx']);
  const writeLayers = tool({ name: 'write_file', description: 'Réécrit une couche : server/tools.ts, atoms.tsx, molecules.tsx, organisms.tsx ou src/App.tsx.', parameters: z.object({ path: z.string(), content: z.string() }), execute: async ({ path, content }) => layerFiles.has(path) ? json(await wrap(() => tb.writeFile(path, content))) : `ERREUR : ${path} n'est pas une couche` });
  const editTool = tool({ name: 'edit_file', description: 'Remplace une occurrence exacte et unique.', parameters: z.object({ path: z.string(), find: z.string(), replace: z.string() }), execute: async ({ path, find, replace }) => json(await wrap(() => tb.editFile(path, [{ find, replace }]))) });
  const readLinesTool = tool({ name: 'read_lines', description: 'Lit une plage de lignes.', parameters: z.object({ path: z.string(), from: z.number(), to: z.number() }), execute: async ({ path, from, to }) => json(await wrap(() => tb.readRange('dev', path, from, to))) });
  const searchTool = tool({ name: 'search_code', description: 'Cherche un texte dans src/ et server/tools.ts.', parameters: z.object({ pattern: z.string() }), execute: async ({ pattern }) => json(await wrap(() => tb.searchCode('dev', pattern))) });
  const buildTool = tool({ name: 'build', description: 'Lance vite build.', parameters: z.object({}), execute: async () => json(await wrap(() => tb.build())) });
  const shadcnTool = tool({ name: 'shadcn_add', description: 'Installe des primitives shadcn manquantes (card, skeleton, chart…).', parameters: z.object({ components: z.array(z.string()) }), execute: async ({ components }) => json(await wrap(() => tb.shadcnAdd(components))) });
  let planned: Array<{ id: string; mission: string }> = [];
  let baseline = 0;
  const lead = new Agent({
    name: 'Lead Dev',
    handoffDescription: 'Ordonne les sous-agents du design atomique, sans écrire de code.',
    instructions: LEAD_DEV,
    model,
    tools: [tool({ name: 'plan', description: 'Fixe la mission d’une phrase de chaque sous-agent.', parameters: z.object({ layers: z.array(z.object({ id: z.enum(['donnees', 'atomes', 'molecules', 'organismes', 'page']), mission: z.string() })) }), execute: async ({ layers }) => { planned = layers; return 'plan reçu'; } })],
    modelSettings: settings(900, { toolChoice: 'required' }),
    resetToolChoice: true,
    toolUseBehavior: () => planned.length ? { isFinalOutput: true, isInterrupted: undefined, finalOutput: 'Plan fixé.' } : { isFinalOutput: false, isInterrupted: undefined },
  });
  const corrector = new Agent({
    name: 'Correcteur',
    handoffDescription: 'Corrige le fichier cité, sans réécrire les autres couches.',
    instructions: DEV_FIX,
    model,
    tools: [editTool, writeLayers, readLinesTool, searchTool, shadcnTool, buildTool, devTools2.at(-1)!],
    modelSettings: settings(6000, { toolChoice: 'required' }),
    resetToolChoice: false,
    toolUseBehavior: () => tb.metrics.writes + tb.metrics.edits > baseline && !!tb.lastBuild?.ok
      ? { isFinalOutput: true, isInterrupted: undefined, finalOutput: 'Corrigé.' }
      : { isFinalOutput: false, isInterrupted: undefined },
  });
  // Revue : le PO reçoit la spec, les résultats build/tests/cohérence et un extrait du code — sans outils de lecture
  // (relire App.tsx + app-shell + scenes faisait exploser le contexte → finish_reason=length). Raisonnement bas, sortie large.
  const reviewer = new Agent({ name: 'Product Ops (revue)', instructions: (incremental ? PO_REVIEW_INCREMENTAL : PO_REVIEW) + "\nTu n'as PAS d'outils : juge à partir du résumé, des résultats de build/tests/cohérence et de l'extrait de code fournis. Verdict court.", model, modelSettings: settings(2000) });
  // Une seule reprise. La deuxième revue réécrivait les mêmes critères et relançait un correcteur.
  const maxRework = 1;
  const reviews: Array<{ iteration: number; verdict: string; remarks: string[] }> = [];
  let contractJson = JSON.stringify(contract, null, 1);
  const newTools = incremental && baseContract ? contract.tools.filter((t) => !baseContract.tools.some((b: any) => b.name === t.name)).map((t) => t.name) : [];
  const toolLine = `Outils : ${contract.tools.map((t) => t.name).join(', ')}. Vues : ${contract.charts.join(', ') || 'aucune'}.`;
  let devMsg = incremental && mem ? `${ALIGN_NOTE}\n\nMÉMOIRE DE L'APP (v${mem.version}) :\n${memCompact}\n\nSPEC DELTA du Product Owner :\n${delta}\n\nCONTRAT RÉSULTANT (diff appliqué${newTools.length ? ` — nouveaux outils : ${newTools.join(', ')}` : ''}) :\n${contractJson}\n\nDemande : « ${input.prompt} ». L'interface est déjà enregistrée. Cette commande ajoute ou retire UNIQUEMENT un composant de dashboard : dashboard_add pour un ajout, edit_file pour retirer le panneau nommé. Tu ne réécris pas le reste. Puis build().` : '';
  const layerInstructions = (id: AtomicLayer) => id === 'page'
    ? DEVELOPER.replace('${PREINSTALLED}', [...ws.preinstalled].join(', ') || 'button') + (incremental ? DEV_INCREMENTAL : '')
    : id === 'organismes' ? LAYER_ORGANISMES : id === 'molecules' ? LAYER_MOLECULES : id === 'atomes' ? LAYER_ATOMES
    : LAYER_DONNEES + (incremental ? '\nGarde chaque outil déjà au contrat. Ajoute seulement les outils nouveaux.' : '');
  async function runLayer(id: AtomicLayer, mission: string, again = false) {
    const file = fileOf(id);
    const before = tb.metrics.writes + tb.metrics.edits;
    const patch = incremental && (id === 'page' || id === 'organismes');
    const turns = patch && id === 'page' ? 8 : id === 'page' ? 6 : id === 'organismes' || id === 'donnees' ? 4 : 3;
    const tokens = id === 'page' ? 10000 : id === 'donnees' || id === 'organismes' ? 7000 : 2200;
    const stop = () => {
      const moved = tb.metrics.writes + tb.metrics.edits > before;
      if (patch) return moved && !!tb.lastBuild?.ok;
      if (again || (incremental && id === 'donnees')) return moved;
      return ws.files.has(file);
    };
    const agent = new Agent({
      name: id === 'page' ? 'Page' : id === 'organismes' ? 'Organismes' : id === 'molecules' ? 'Molécules' : id === 'atomes' ? 'Atomes' : 'Données',
      handoffDescription: `Écrit ${file}.`,
      instructions: layerInstructions(id),
      model,
      tools: patch ? devTools2 : id === 'organismes' ? [writeOnly(file), dashTool] : [writeOnly(file)],
      modelSettings: settings(tokens, { toolChoice: 'required' }),
      resetToolChoice: false,
      toolUseBehavior: () => stop() ? { isFinalOutput: true, isInterrupted: undefined, finalOutput: `${file} livré.` } : { isFinalOutput: false, isInterrupted: undefined },
    });
    ctx.emit({ type: 'phase', phase: 'code', label: `Développeur : ${ATOMIC_WORD[id]}` });
    const body = patch && id === 'page'
      ? `PASSE : page. Cette carte est la seule en cours. Tu la termines, tu n'en ouvres pas une autre.\nMission du lead : ${mission}\n\n${devMsg}`
      : `PASSE : ${id}. FICHIER UNIQUE : ${file}. Cette carte est la seule en cours.\nMission du lead : ${mission}\n\n${id === 'donnees' || id === 'page' ? `CONTRAT :\n${contractJson}\n\nBRIEF :\n${brief.slice(0, 3500)}` : toolLine}${id === 'page' && !incremental ? `\n\nSPEC :\n${spec.slice(0, 4000)}` : ''}`;
    await exec(agent, 'dev', body, turns, undefined, stop);
    if (!stop() && !patch) await exec(agent, 'dev', `Le fichier ${file} est absent. write_file maintenant, path exact "${file}".`, 3, undefined, () => ws.files.has(file));
  }
  let iteration = 0;
  for (;;) {
    iteration++;
    role('dev', iteration);
    if (iteration === 1) {
      parole('po', incremental ? delta : spec);
      ctx.emit({ type: 'phase', phase: 'code', label: 'Développeur : orchestration' });
      const leadMsg = incremental
        ? `Demande : « ${input.prompt} ».\nOutils nouveaux : ${newTools.join(', ') || 'aucun'}.\nFichier organismes : ${ws.files.has('src/components/organisms.tsx') ? 'présent' : 'absent'}.\nAppelle plan().`
        : `Demande : « ${input.prompt} ».\n${toolLine}\nAppelle plan() avec les cinq couches, dans l'ordre.`;
      try { await exec(lead, 'dev', leadMsg, 2, undefined, () => planned.length > 0); }
      catch (e) { if (!(e instanceof MaxTurnsExceededError)) throw e; }
      const layers = settleLayers({ incremental, newTools, planned, hasOrganisms: ws.files.has('src/components/organisms.tsx') });
      const titleOf = (id: AtomicLayer) => ATOMIC_WORD[id].replace(/^./, (letter) => letter.toUpperCase());
      addCards(board, layers.map((layer) => ({ id: layer.id, title: titleOf(layer.id) })));
      showBoard();
      for (const layer of layers) {
        take(layer.id);
        await runLayer(layer.id, layer.mission);
        if (layer.id === 'donnees') {
          await tb.testBackend('dev', contract);
          if (!tb.lastBackendTest?.ok) {
            await runLayer('donnees', `Corrige server/tools.ts. Erreurs : ${(tb.lastBackendTest?.problems ?? []).slice(0, 4).join(' ; ')}`, true);
            await tb.testBackend('dev', contract);
          }
          if (!tb.lastBackendTest?.ok || !ws.files.has('server/tools.ts')) {
            showBoard();
            throw new Error('La carte Données reste en cours. Aucune couche suivante n’est ouverte.');
          }
        } else if (layer.id !== 'page' && !ws.files.has(fileOf(layer.id))) {
          showBoard();
          throw new Error(`La carte ${titleOf(layer.id)} reste en cours. Aucune couche suivante n’est ouverte.`);
        }
        if (layer.id !== 'page') { finish(board, layer.id); showBoard(); }
      }
    } else {
      ctx.emit({ type: 'phase', phase: 'code', label: `Développeur : reprise n°${iteration - 1}` });
      baseline = tb.metrics.writes + tb.metrics.edits;
      const out = await exec(corrector, 'dev', devMsg, incremental ? 8 : 10, undefined, () => tb.metrics.writes + tb.metrics.edits > baseline && !!tb.lastBuild?.ok);
      if (out) parole('dev', out);
    }
    if (!ws.files.has('src/App.tsx')) await runLayer('page', ATOMIC_MISSION.page);
    if (!ws.files.has('src/App.tsx')) throw new Error("La page n'a pas été écrite (src/App.tsx)");
    if (!tb.lastBuild?.ok) await tb.build();
    for (let fix = 1; fix <= BUILD_FIX_PASSES && !tb.lastBuild?.ok; fix++) {
      ctx.emit({ type: 'phase', phase: 'code', label: `Développeur : correction automatique ${fix}/${BUILD_FIX_PASSES} (imports · tsc · smoke render)` });
      baseline = tb.metrics.writes + tb.metrics.edits;
      await exec(corrector, 'dev', `Correction automatique ${fix}/${BUILD_FIX_PASSES} : le build, la validation des imports ou le smoke render échoue :\n${(tb.lastBuild?.output ?? '').slice(-3000)}\n\nLis la zone fautive (read_lines), corrige UNIQUEMENT ces erreurs (edit_file de préférence, write_file sinon), puis relance build().`, 8, undefined, () => tb.metrics.writes + tb.metrics.edits > baseline && !!tb.lastBuild?.ok);
      if (!tb.lastBuild?.ok) await tb.build();
    }
    // Outils implémentés par le backend ET appelés par le front mais absents du contrat → intégrés automatiquement
    {
      const unknown = coherence({ contract, appCode: ws.files.get('src/App.tsx') ?? '', backendTools: tb.lastBackendTest?.tools ?? [] }).front.unknown;
      if (unknown.length) {
        if (!tb.lastBackendTest?.defs) await tb.testBackend('po', contract);
        const added = integrateBackendTools(contract, tb.lastBackendTest?.defs ?? [], unknown);
        if (added.length) { contractJson = JSON.stringify(contract, null, 1); emit({ type: 'agent', kind: 'contract', role: 'po', contract, ok: true }); parole('po', `Contrat complété : ${added.join(', ')}.`); }
      }
    }
    await tb.testBackend('po', contract);         // re-test systématique de la version livrée
    {
      const page = ws.files.get('src/App.tsx') ?? '';
      const shelled = ensureAppShell(page);
      if (shelled.changed) {
        await ws.write('src/App.tsx', shelled.code);
        await tb.build();
      }
    }
    if (tb.lastBuild?.ok && board.cards.find((card) => card.id === 'page')?.column === 'doing') { finish(board, 'page'); showBoard(); }
    if (iteration > maxRework) break;
    if (board.cards.find((card) => card.id === 'page')?.column !== 'done') continue;
    if (!board.cards.some((card) => card.id === 'revue')) addCards(board, [{ id: 'revue', title: 'Revue' }]);
    if (board.cards.find((card) => card.id === 'revue')?.column === 'todo') take('revue');
    role('po', iteration);
    ctx.emit({ type: 'phase', phase: 'validate', label: `Product Owner : revue n°${iteration} (front · backend · agent)` });
    const app = ws.files.get('src/App.tsx') ?? '';
    // Le graphique vit dans les organismes : le chercher seulement dans la page le déclarait absent et rouvrait une revue.
    const front = `${app}\n${ws.files.get('src/components/organisms.tsx') ?? ''}`;
    const coh = coherenceCriteria(contract, front, tb.lastBackendTest, brief);
    const changedNow = changedFiles(prev?.files ?? {}, Object.fromEntries(ws.files));
    const reviewInput = (codeMax: number) => incremental ? `SPEC DELTA :\n${delta}\n\nBUILD (imports · tsc · smoke render) : ${tb.lastBuild?.ok ? 'réussi' : 'ÉCHEC\n' + tb.lastBuild?.output}\nTEST BACKEND MCP (tous les outils, non-régression) : ${tb.lastBackendTest?.ok ? 'ok' : 'KO : ' + tb.lastBackendTest?.problems.join(' ; ')}\nCOHÉRENCE : ${coh.map((c) => `${c.id}=${c.ok ? 'ok' : 'KO'} (${c.note})`).join(' | ')}\nFichiers modifiés : ${changedNow.join(', ') || '(aucun)'}\n\nLIGNES AJOUTÉES/MODIFIÉES :\n${changedNow.map((f) => `### ${f}\n${changedLinesExcerpt(prev?.files?.[f] ?? '', ws.files.get(f) ?? '', Math.floor(codeMax / Math.max(1, changedNow.length)))}`).join('\n\n')}` : `SPEC :\n${spec}\n\nBUILD : ${tb.lastBuild?.ok ? 'réussi' : 'ÉCHEC\n' + tb.lastBuild?.output}\nTEST BACKEND MCP : ${tb.lastBackendTest?.ok ? 'ok' : 'KO : ' + tb.lastBackendTest?.problems.join(' ; ')}\nCOHÉRENCE : ${coh.map((c) => `${c.id}=${c.ok ? 'ok' : 'KO'} (${c.note})`).join(' | ')}\nComposants : ${[...ws.components, ...ws.preinstalled].join(', ')}\nFichiers : ${[...ws.files.keys()].join(', ')}\n\nserver/tools.ts :\n${(ws.files.get('server/tools.ts') ?? '(absent)').slice(0, Math.min(8000, codeMax / 2))}\n\nsrc/App.tsx :\n${app.length > codeMax ? app.slice(0, codeMax) + `\n… (${app.split('\n').length} lignes au total, tronqué)` : app}`;
    let raw = '';
    try { raw = await exec(reviewer, 'po', reviewInput(12000), 2); }
    catch (e) {
      if (!/length|max_tokens|context/i.test((e as Error).message)) throw e;
      // 1 nouvel essai avec un contexte réduit, puis repli sur les critères automatiques plutôt qu'un échec global
      parole('po', 'Revue trop longue : nouvel essai avec un contexte réduit.');
      try { raw = await exec(reviewer, 'po', reviewInput(4000), 1); }
      catch (e2) { if (!/length|max_tokens|context/i.test((e2 as Error).message)) throw e2; raw = '{"verdict":"ok","criteres":[],"remarques":["Revue LLM indisponible (limite de longueur) : verdict fondé sur build, tests backend et cohérence."]}'; }
    }
    const j = safeJson(raw) ?? { verdict: 'ok', criteres: [], remarques: [] };
    const criteria = [...(Array.isArray(j.criteres) ? j.criteres.map((c: any) => ({ id: String(c.id ?? ''), ok: !!c.ok, note: c.note ? String(c.note) : undefined })) : []), ...coh];
    const remarks: string[] = Array.isArray(j.remarques) ? j.remarques.map(String) : [];
    for (const c of coh) if (!c.ok) remarks.unshift(`${c.id} : ${c.note}`);
    if (!tb.lastBuild?.ok) remarks.unshift('Le build échoue : corrige les erreurs puis relance build().');
    const verdict = tb.lastBuild?.ok && coh.every((c) => c.ok) ? (j.verdict === 'a_corriger' ? 'a_corriger' : 'ok') : 'a_corriger';
    emit({ type: 'agent', kind: 'review', role: 'po', iteration, verdict, criteria, remarks });
    reviews.push({ iteration, verdict, remarks });
    if (verdict === 'ok') { finish(board, 'revue'); showBoard(); break; }
    requeue(board, 'revue');
    reopen(board, 'page');
    showBoard();
    parole('po', remarks.join(' ') || 'À corriger.');
    devMsg = incremental ? `Revue du Product Owner (évolution) — à corriger, par retouches ciblées (edit_file) :\n${remarks.map((r) => `- ${r}`).join('\n')}\nCritères non respectés : ${criteria.filter((c: any) => !c.ok).map((c: any) => `${c.id} ${c.note ?? ''}`).join(' ; ') || '—'}\nPuis test_backend() et build().` : `Revue du Product Owner (itération ${iteration}) — à corriger :\n${remarks.map((r) => `- ${r}`).join('\n')}\n\nCritères non respectés : ${criteria.filter((c: any) => !c.ok).map((c: any) => `${c.id} ${c.note ?? ''}`).join(' ; ') || '—'}\nRappel du contrat :\n${contractJson}\nLis les fichiers, corrige, test_backend(), puis build().`;
  }
  if (!tb.lastBuild?.ok || !tb.lastBuild.html) throw new Error(`Build final en échec : ${tb.lastBuild?.output.slice(-600) ?? 'aucun build'}`);
  if (!ws.files.has('server/tools.ts')) throw new Error("Le backend n'a pas été écrit (server/tools.ts)");

  const title = specTitle(spec, input.prompt);
  const agentDef = buildAgentDef(contract, { title, spec });
  emit({ type: 'agent', kind: 'app_agent', role: 'po', agent: agentDef });
  const app: AppBundle = { contract, agent: agentDef, backend: 'server/tools.ts', backendOk: !!tb.lastBackendTest?.ok, title };
  const sampled = seedFromSamples(ws.files.get('server/tools.ts') ?? '', tb.mcpSamples.map((sample) => ({ tool: sample.tool, args: sample.args, result: sample.full ?? sample.result })));
  if (Object.keys(sampled).length) app.seed = sampled;
  const files = Object.fromEntries(ws.files);
  const components = [...new Set([...ws.components, ...importsOf(files['src/App.tsx'] ?? '')])];
  const filesChanged = changedFiles(prev?.files ?? {}, files);
  const snap = view(board);
  showBoard();
  parole('dev', fluxLine(snap));
  emit({ type: 'agent', kind: 'summary', framework: 'OpenAI Agents SDK', ms: Date.now() - t0, iterations: iteration, files: Object.keys(files), components, cliCalls: tb.cliCalls, builds: tb.builds, mode, memoryVersion: mem?.version, filesChanged, toolCalls, metrics: { ...tb.metrics, wipMax: snap.maxWip, cycleMs: snap.cycleMs, leadMs: snap.leadMs, throughput: snap.doneCount } });
  const memoryDraft = { mode, features: incremental ? extractCriteria(delta, 0).map((c) => `${c.id} ${c.text}`.slice(0, 160)) : [], filesChanged, ms: Date.now() - t0, toolCalls, metrics: { ...tb.metrics } };
  return { code: tb.lastBuild.html, plan: spec, brief, files, components, workspace: ws.id, iterations: iteration, reviews, toolResults: tb.mcpSamples.map((s) => ({ name: s.tool, result: s.result })), framework: 'OpenAI Agents SDK', app, memory: memoryDraft };
}
