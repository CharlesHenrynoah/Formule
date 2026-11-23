/**
 * Sous-agent d'une app : instancié à la demande avec l'OpenAI Agents SDK (Mercury 3 par défaut)
 * à partir de la définition produite par l'équipe (instructions, outils, garde-fous).
 * Ses outils = le backend MCP de l'app (+ outils MCP externes autorisés par le contrat).
 * Les écritures non déclarées « safe » passent par l'approbation humaine du SDK (needsApproval → interruptions).
 * Sans clé : agent scripté déterministe (mêmes outils réels, mêmes événements).
 */
import OpenAI from 'openai';
import { Agent, run, tool, setTracingDisabled, OpenAIChatCompletionsModel, type Tool } from '@openai/agents';
import type { AgentDef } from '../../../../packages/app-mcp/src/core.mjs';
import type { HubTool } from './store.ts';

setTracingDisabled(true);

export type AgentCfg = { baseUrl: string; apiKey: string; model: string; reasoningEffort?: string };
export type AskEvent =
  | { type: 'start'; agent: string; framework: string; model: string }
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; id: string; tool: string; args: unknown }
  | { type: 'tool_result'; id: string; tool: string; ok: boolean; result?: unknown; error?: string; ms?: number }
  | { type: 'confirm'; callId: string; tool: string; args: unknown }
  | { type: 'ui'; patch: Record<string, unknown> }
  | { type: 'voice'; tool: string; args: unknown; result: unknown }
  | { type: 'plan'; tasks: Array<{ id: string; title: string; status: string; note?: string }> }
  | { type: 'iterate'; request: string }
  | { type: 'cli'; command: string; ok: boolean; output: string }
  | { type: 'progress'; text: string }
  | { type: 'done'; text: string; ms: number; toolCalls: number; changed: boolean; continuable?: boolean; steps?: number };

export type RunCtx = {
  def: AgentDef;
  tools: HubTool[];                // outils de l'app (backend MCP) + externes autorisés
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  emit: (e: AskEvent) => void;
  /** Exécute un outil (déjà autorisé) ; `confirmed` = approbation humaine obtenue. */
  callTool: (t: HubTool, args: unknown, confirmed: boolean) => Promise<unknown>;
  askConfirm: (t: HubTool, args: unknown) => Promise<boolean>;
  signal?: AbortSignal;
  /** L'utilisateur parle (transcription Google) : le contremaître répond aussi à l'oral via voice.speak. */
  voice?: boolean;
  memory?: { requests: Array<{ prompt: string }>; facts: Array<{ text: string }> };
  /** Budget d'étapes pondéré par ordre (voir stepWeight). */
  maxSteps?: number;
};

let seq = 0;
const INTERNAL = new Set(['memory', 'ui', 'foreman', 'retrieval', 'voice', 'source']);
const sdkName = (t: HubTool) => (t.server === 'voice' ? `voice_${t.name}` : t.server.startsWith('app-') || INTERNAL.has(t.server) ? t.name : `ext_${t.server}_${t.name}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
const own = (t: HubTool) => t.server.startsWith('app-') || INTERNAL.has(t.server);
const needsConfirm = (t: HubTool) => t.write && !(own(t) && t.safe);

/** Marqueur de fin d'un ordre interrompu par le budget : le studio affiche alors « Continuer ». */
export const PAUSE_MARK = '⏸️ Chantier en pause';
export const CONTINUE_ORDER = "Continue le chantier en pause là où tu t'es arrêté (ne refais pas les étapes déjà faites).";

/**
 * Poids d'un appel dans le budget : les lectures et attentes ne comptent pas comme des étapes pleines.
 *  - écriture/action (hors stockage local sûr) : 1
 *  - lecture, découverte, attente/ingestion d'exécution : 0,5
 *  - plan, UI, mémoire, voix : 0,25
 */
export function stepWeight(t: HubTool, args?: unknown): number {
  if (t.server === 'foreman' && (t.name === 'plan_tasks' || t.name === 'update_task')) return 0.25;
  if (t.server === 'ui' || t.server === 'memory' || t.server === 'voice') return 0.25;
  if (t.server === 'source') return t.write ? 1 : 0.5;
  if (t.server === 'retrieval') {
    if (t.name !== 'mcp_call') return 0.5;
    const tool = String((args as { tool?: string })?.tool ?? '');
    return /(^|__)(get|list|search|read|find|fetch|describe|query|wait)_/.test(tool) ? 0.5 : 1;
  }
  if (t.write && !(t.server.startsWith('app-') && t.safe)) return 1;
  return t.write ? 0.5 : 0.5;
}

type RunState = { calls: number; changed: boolean; used: number; paused: boolean; trail: Array<{ tool: string; ok: boolean; note: string }> };
const brief = (v: unknown) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return !s ? '' : s.length > 160 ? s.slice(0, 160) + '…' : s; };

/** Compte rendu intermédiaire construit depuis les appels réellement faits (si le modèle n'a pas pu conclure). */
export function partialReport(state: RunState, maxSteps: number) {
  const ok = state.trail.filter((x) => x.ok && !/^(plan_tasks|update_task|set_dashboard)$/.test(x.tool));
  const lines = ok.slice(-5).map((x) => `- ${x.tool} : ${x.note}`);
  return `${lines.length ? `Données déjà obtenues :\n${lines.join('\n')}\n\n` : ''}${PAUSE_MARK} (budget de ${maxSteps} étapes utilisé : ${Math.round(state.used * 100) / 100}). Clique « Continuer » pour reprendre là où je me suis arrêté.`;
}

async function traced(ctx: RunCtx, t: HubTool, args: unknown, confirmed: boolean, state: RunState) {
  const id = `c${++seq}`;
  state.calls++;
  ctx.emit({ type: 'tool_call', id, tool: t.name, args });
  const t0 = Date.now();
  try {
    const result = await ctx.callTool(t, args, confirmed);
    if (t.write) state.changed = true;
    state.trail.push({ tool: t.name, ok: true, note: brief(result) });
    ctx.emit({ type: 'tool_result', id, tool: t.name, ok: true, result, ms: Date.now() - t0 });
    return result;
  } catch (e) {
    state.trail.push({ tool: t.name, ok: false, note: (e as Error).message });
    ctx.emit({ type: 'tool_result', id, tool: t.name, ok: false, error: (e as Error).message, ms: Date.now() - t0 });
    throw e;
  }
}

export async function runLlmAgent(ctx: RunCtx, cfg: AgentCfg) {
  const t0 = Date.now();
  const state: RunState = { calls: 0, changed: false, used: 0, paused: false, trail: [] };
  const maxSteps = ctx.maxSteps ?? 20;
  // Plafond de tours SDK = garde-fou ; le vrai budget est pondéré (stepWeight).
  const maxTurns = Math.ceil(maxSteps * 2) + 2;
  const client = new OpenAI({ baseURL: cfg.baseUrl, apiKey: cfg.apiKey, timeout: 120_000, maxRetries: 1 });
  const model = new OpenAIChatCompletionsModel(client as never, cfg.model);
  const byName = new Map<string, HubTool>();
  const sdkTools: Tool[] = ctx.tools.map((t) => {
    const name = sdkName(t);
    byName.set(name, t);
    return tool({
      name, description: `${t.description ?? t.name}${t.write ? ' [écriture]' : ' [lecture]'}`,
      parameters: (t.inputSchema ?? { type: 'object', properties: {}, required: [], additionalProperties: false }) as never,
      strict: false,
      needsApproval: needsConfirm(t),
      execute: async (args: unknown) => {
        const w = stepWeight(t, args);
        if (state.used + w > maxSteps) {
          state.paused = true;
          return `BUDGET D'ÉTAPES ATTEINT (${maxSteps}) : n'appelle plus aucun outil. Écris maintenant un compte rendu INTERMÉDIAIRE : données déjà obtenues (chiffres), ce qui reste à faire, puis termine par « ${PAUSE_MARK} ».`;
        }
        state.used += w;
        try { return JSON.stringify(await traced(ctx, t, args, needsConfirm(t), state)); }
        catch (e) { return `ERREUR : ${(e as Error).message}`; }
      },
    });
  });
  const agent = new Agent({
    name: ctx.def.name, instructions: ctx.def.instructions, model, tools: sdkTools,
    modelSettings: { maxTokens: 2000, providerData: cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : undefined },
  });
  ctx.emit({ type: 'start', agent: ctx.def.name, framework: 'OpenAI Agents SDK', model: cfg.model });
  const hist = (ctx.history ?? []).slice(-8).map((m) => `${m.role === 'user' ? 'Utilisateur' : 'Agent'} : ${m.content}`).join('\n');
  const input = hist ? `Conversation précédente :\n${hist}\n\nNouveau message de l'utilisateur : ${ctx.message}` : ctx.message;
  let text = '';
  let res: Awaited<ReturnType<typeof run>> | null = null;
  let limit = '';
  try {
    res = await run(agent, input, { stream: true, maxTurns, signal: ctx.signal });
    for (let guard = 0; guard < 6; guard++) {
      for await (const ev of res) {
        if (ev.type === 'raw_model_stream_event' && (ev.data as { type?: string }).type === 'output_text_delta') {
          const d = (ev.data as { delta: string }).delta; text += d; ctx.emit({ type: 'delta', text: d });
        }
      }
      await res.completed;
      const pending = res.interruptions ?? [];
      if (!pending.length) break;
      for (const it of pending) {
        const raw = it.rawItem as { name?: string; arguments?: string };
        const t = byName.get(String(raw.name));
        let args: unknown = {};
        try { args = JSON.parse(raw.arguments ?? '{}'); } catch { /* ignore */ }
        const ok = t ? await ctx.askConfirm(t, args) : false;
        if (ok) res.state.approve(it); else res.state.reject(it);
      }
      res = await run(agent, res.state, { stream: true, maxTurns, signal: ctx.signal });
    }
  } catch (e) {
    // Limite de pas ou délai : compte rendu partiel plutôt qu'une erreur sèche.
    if (!/max turns|MaxTurns|abort/i.test(`${(e as Error).name} ${(e as Error).message}`)) throw e;
    state.paused = true;
    limit = '\n\n' + (ctx.signal?.aborted ? `⏱️ Délai dépassé.\n${partialReport(state, maxSteps)}` : partialReport(state, maxSteps));
    ctx.emit({ type: 'delta', text: limit });
  }
  let final = ((limit ? '' : String(res?.finalOutput ?? '')).trim() || text.trim()) + limit;
  if (state.paused && !final.includes(PAUSE_MARK)) {
    const tail = `\n\n${PAUSE_MARK} (budget de ${maxSteps} étapes utilisé). Clique « Continuer » pour reprendre.`;
    ctx.emit({ type: 'delta', text: tail }); final += tail;
  }
  ctx.emit({ type: 'done', text: final, ms: Date.now() - t0, toolCalls: state.calls, changed: state.changed, continuable: state.paused || undefined, steps: Math.round(state.used * 100) / 100 });
  return final;
}

// ---------------- Agent scripté (démo sans clé) ----------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function say(ctx: RunCtx, s: string) { for (let i = 0; i < s.length; i += 6) { ctx.emit({ type: 'delta', text: s.slice(i, i + 6) }); await sleep(6); } }
const find = (tools: HubTool[], re: RegExp) => tools.find((t) => t.server.startsWith('app-') && re.test(t.name));

const pctIn = (m: string) => { const x = /([+-]?\s*\d+(?:[.,]\d+)?)\s*(?:%|pour ?cent)/i.exec(m); if (!x) return undefined; const v = Number(x[1].replace(/\s/g, '').replace(',', '.')); return /baiss|r[ée]dui|diminu|moins/i.test(m) && v > 0 ? -v : v; };
const fmt = (n: number) => `${n > 0 ? '+' : ''}${n} %`;
const eur = (n: number) => `${Math.round(n).toLocaleString('fr-FR')} €`;

/**
 * Agent scripté « contremaître » (démo sans clé) : route chaque message (opération sur les données vs évolution
 * de l'app), affiche un plan de chantier, délègue aux outils (app, MCP connectés, ressources), contrôle la qualité,
 * fait un compte rendu sourcé et met le dashboard à jour. Mêmes outils réels et mêmes confirmations que l'agent LLM.
 */
export async function runScriptedAgent(ctx: RunCtx) {
  const t0 = Date.now();
  const state: RunState = { calls: 0, changed: false, used: 0, paused: false, trail: [] };
  const m = ctx.message.trim();
  const tools = ctx.tools;
  ctx.emit({ type: 'start', agent: ctx.def.name, framework: 'scripté (démo)', model: 'mock' });
  const maxSteps = ctx.maxSteps ?? 20;
  const call = async (t: HubTool, args: unknown) => {
    const w = stepWeight(t, args);
    if (state.used + w > maxSteps) { state.paused = true; throw new Error(`budget de ${maxSteps} étapes atteint`); }
    state.used += w;
    const confirm = needsConfirm(t);
    if (confirm && !(await ctx.askConfirm(t, args))) throw new Error("refusé par l'utilisateur");
    return traced(ctx, t, args, confirm, state);
  };
  const T = (server: string, name: string) => tools.find((t) => t.server === server && t.name === name);
  const ext = (re: RegExp) => tools.find((t) => !own(t) && re.test(t.name));
  const out: string[] = [];
  const kpis = find(tools, /^get_kpis$|kpi/);
  const anomalies = find(tools, /anomal/);
  const simulate = find(tools, /^simulate|scenario/);
  const series = find(tools, /^get_series$/);
  const thresholds = find(tools, /threshold|seuil/);
  const suggest = find(tools, /suggest|next_move/);
  const log = find(tools, /^log_action|journal/);
  const alert = ext(/alert|notify|notif/);
  const price = ext(/^set_price$/);
  const mem = T('memory', 'remember');
  const ui = T('ui', 'set_dashboard');
  const planT = T('foreman', 'plan_tasks'); const upd = T('foreman', 'update_task');
  const evolve = T('foreman', 'evolve_app'); const cli = T('foreman', 'app_cli');
  const rList = T('retrieval', 'mcp_list_tools'); const rRes = T('retrieval', 'mcp_list_resources');
  const rRead = T('retrieval', 'mcp_read_resource'); const rCall = T('retrieval', 'mcp_call');
  const sources = new Set<string>();
  const plan = async (tasks: string[]) => { if (planT) await call(planT, { tasks }); };
  const step = async (index: number, status: string, note?: string) => { if (upd) await call(upd, { index, status, ...(note ? { note } : {}) }); };
  const dash = async (patch: Record<string, unknown>) => { if (ui) await call(ui, { patch }); };
  const journal = async (action: string, details: string, statut = 'executee') => { if (log) await call(log, { action, details, statut, origine: 'agent' }); };
  const moves = async (p?: number) => {
    if (!suggest) return '';
    const r = await call(suggest, p === undefined ? {} : { price_change_pct: p }) as any;
    return (r?.moves ?? []).slice(0, 2).map((x: any) => `${x.label}${x.value !== undefined ? ` → ${fmt(x.value)}` : ''} (${x.why})`).join(' ; ');
  };
  const report = (done: string, result: string, next?: string) => {
    out.push(`✅ ${done}`, `📊 ${result}`);
    if (sources.size) out.push(`🔗 Sources : ${[...sources].join(' · ')}`);
    if (next) out.push(`👉 ${next}`);
  };
  try {
    const refreshT = T('source', 'refresh_data');
    if (refreshT && /rafra[iî]ch|recharg|actualis|donn[ée]es? (?:n8n|du workflow)|ex[ée]cute.*workflow|continue le chantier/i.test(m)) {
      // Source n8n : exécution manuelle → attente → ingestion (1 étape), puis lecture des KPIs.
      await plan(['Exécuter le workflow (manuel, après confirmation)', 'Attendre la fin et ingérer le résultat', 'Lire les KPIs de l’app']);
      await step(1, 'doing');
      const r = await call(refreshT, {}) as any;
      sources.add(`${r.serveur ?? 'n8n'} › workflow ${r.workflowId} · exécution ${r.executionId}`);
      await step(1, 'done', `exécution ${r.executionId}`);
      await step(2, r.ingere ? 'done' : 'failed', r.termine ? `${r.statut} en ${Math.round((r.attente_ms ?? 0) / 1000)} s · ${r.ingere ?? 0} point(s)` : 'toujours en cours');
      if (!r.termine) { out.push(`⏳ Exécution ${r.executionId} toujours en cours après ${Math.round((r.attente_ms ?? 0) / 1000)} s.`); throw new Error('relance « attends l’exécution » pour terminer'); }
      const kp = (find(tools, /^get_kpis$/) && await call(find(tools, /^get_kpis$/)!, {})) as any;
      const segs = (kp?.segments ?? []) as any[];
      await step(3, segs.length ? 'done' : 'failed', `${segs.length} segment(s)`);
      if (segs.length) await dash({ focus: 'kpis', panel: { type: 'hbar', title: 'Clients par segment (n8n)', data: segs.map((x) => ({ label: x.segment, value: x.clients })) } });
      report(`Données rafraîchies depuis n8n (exécution ${r.executionId}, ${r.statut}).`,
        segs.length ? segs.map((x) => `${x.segment} : ${x.clients} clients, sentiment ${x.sentiment}`).join(' · ') : `aucun point ingéré${r.note ? ` (${r.note})` : ''}`,
        ...(r.notes?.length ? [r.notes.join(' ; ')] : []));
    } else if (cli && /^(ls|cat|grep|npm run build)\b/i.test(m)) {
      const r = await call(cli, { command: m }) as any;
      out.push(`🖥️ \`${r.command}\` → ${r.ok ? 'ok' : 'refusé/échec'}`, '```\n' + String(r.output).slice(0, 1200) + '\n```');
    } else if (ui && /^⚡/.test(m)) {
      // ---- Événement d'un composant d'action ou d'une scène (l'interface est pilotée par le contremaître) ----
      const uiT = (n: string) => T('ui', n)!;
      const raw = m.split(/ : /).slice(1).join(' : ').trim();
      const val = Number(raw.replace(',', '.'));
      if (/trafic/i.test(m) && Number.isFinite(val)) {
        await call(uiT('update_scene'), { id: 'machine', params: { traffic_pct: val } });
        out.push(`🎛️ Machine : trafic d’entrée ${fmt(val)}. Les engrenages accélèrent ou ralentissent, et les pertes suivent les taux réels.`);
      } else if (/boost/i.test(m) && Number.isFinite(val)) {
        await call(uiT('update_scene'), { id: 'machine', params: { boost_stage: 2, boost_pct: val } });
        out.push(`🎛️ Machine : conversion du panier ${fmt(val)}. Regarde le goulot : s’il refroidit, le blocage se déplace vers l’étape suivante.`);
      } else if (/stage_click/.test(m)) {
        let st: any = {}; try { st = JSON.parse(raw); } catch { /* texte libre */ }
        out.push(`🔎 Étape « ${st.label ?? '?'} » : ${st.value ?? '?'} visiteurs, ${st.conversion_pct ?? '?'} % de passage depuis l’étape précédente.`, '👉 Dis « boost panier » ou bouge le curseur pour simuler une amélioration de cette étape.');
      } else if (/alerte/i.test(m) && alert) {
        const r = await call(alert, { message: 'Alerte déclenchée depuis le panneau Actions', niveau: 'warning' }) as any; sources.add(`demo › ${alert.name}`);
        await journal('alerte', 'déclenchée depuis un composant d’action');
        out.push(`📣 Alerte envoyée (${r?.id ? `#${r.id}` : 'ok'}) après ta confirmation.`);
      } else if (/seuil/i.test(m) && Number.isFinite(val) && thresholds) {
        await call(thresholds, { commandes_min: val }); out.push(`🎚️ Seuil d’alerte réglé à ${val} commandes/jour. Je surveille.`);
      } else out.push(`Événement reçu : ${m.slice(2)}. Je n’ai pas d’action associée ; dis-moi ce que tu veux en faire.`);
    } else if (ui && T('ui', 'render_scene') && /machine|tunnel|entonnoir|funnel/i.test(m)) {
      // ---- Visualisation métaphorique : le tunnel de conversion comme une machine (scène PixiJS sur mesure) ----
      await plan(['Lire le tunnel de conversion (MCP)', 'Repérer le goulot d’étranglement', 'Monter la machine (PixiJS)', 'Brancher les curseurs de simulation']);
      await step(1, 'doing');
      const cat = rList ? await call(rList, {}) as any : { outils: [] };
      const fun = (cat.outils ?? []).find((o: any) => /get_funnel$/.test(o.id));
      if (!fun || !rCall) { await step(1, 'failed', 'pas de source tunnel'); throw new Error('aucune source MCP « tunnel de conversion » dans la liste blanche de l’app'); }
      const f = await call(rCall, { tool: fun.id, args: {} }) as any; sources.add(f.source);
      const stages = (f.data?.etapes ?? []) as Array<{ label: string; value: number }>;
      await step(1, 'done', `${stages.length} étapes, ${stages[0]?.value ?? 0} visites`);
      await step(2, 'doing');
      let wi = 1; stages.forEach((x, i) => { if (i && x.value / stages[i - 1].value < stages[wi].value / stages[wi - 1].value) wi = i; });
      const rate = Math.round(stages[wi].value / stages[wi - 1].value * 100);
      await step(2, 'done', `${stages[wi - 1].label} → ${stages[wi].label} : ${rate} %`);
      await step(3, 'doing');
      await call(T('ui', 'render_scene')!, { id: 'machine', kind: 'pixi', scene: 'conversion-machine', title: 'Tunnel de conversion · machine', data: { stages }, params: { speed: 1.2, traffic_pct: 0 } });
      await step(3, 'done', 'particules = visiteurs, pertes = chutes du tapis');
      await step(4, 'doing');
      await call(T('ui', 'render_action')!, { id: 'trafic', component: 'Slider', props: { label: 'Trafic d’entrée', min: -50, max: 100, step: 5, value: 0, unit: ' %' } });
      await call(T('ui', 'render_action')!, { id: 'boost', component: 'Slider', props: { label: 'Boost conversion panier', min: 0, max: 80, step: 5, value: 0, unit: ' %' } });
      await step(4, 'done', '2 curseurs');
      report('Machine montée : tes visiteurs avancent d’étape en étape sur les tapis, ceux qui décrochent tombent.', `Goulot : ${stages[wi - 1].label} → ${stages[wi].label} (${rate} % de passage), l’engrenage rouge qui fume. Clique une étape pour le détail.`, 'Monte le curseur « Boost conversion panier » pour voir le goulot se déplacer.');
    } else if (ui && T('ui', 'render_scene') && /vivant|particule|anim[ée]|flux|en mouvement/i.test(m)) {
      await plan(['Lire les ventes par produit (MCP)', 'Rendre le flux de commandes (PixiJS)']);
      await step(1, 'doing');
      const cat = rList ? await call(rList, {}) as any : { outils: [] };
      const byProd = (cat.outils ?? []).find((o: any) => /get_sales_by_product$/.test(o.id));
      if (!byProd || !rCall) throw new Error('aucune source « ventes par produit »');
      const d = await call(rCall, { tool: byProd.id, args: {} }) as any; sources.add(d.source);
      const flows = (d.data?.lignes ?? []).map((l: any) => ({ from: /CAF|THE|CAP/.test(l.sku) ? 'Épicerie' : 'Accessoires', to: l.nom, value: l.commandes }));
      await step(1, 'done', `${flows.length} produits`);
      await call(T('ui', 'render_scene')!, { id: 'flux', kind: 'pixi', scene: 'particle-flow', title: 'Flux de commandes · aujourd’hui', data: { flows }, params: { speed: 1 } });
      await step(2, 'done');
      report('Flux vivant affiché : chaque particule est une commande qui part de son rayon vers le produit.', `${flows.reduce((a: number, x: any) => a + x.value, 0)} commandes sur ${flows.length} produits.`);
    } else if (ui && T('ui', 'render_action') && /(affiche|montre|donne|mets).{0,30}(contr[ôo]les?|r[ée]glages?|boutons?|curseurs?)/i.test(m)) {
      await call(T('ui', 'render_action')!, { id: 'seuil', component: 'Slider', props: { label: 'Seuil d’alerte commandes/jour', min: 60, max: 160, step: 5, value: 100 } });
      await call(T('ui', 'render_action')!, { id: 'periode', component: 'SegmentedControl', props: { options: ['7 j', '30 j', '90 j'], value: '30 j' } });
      await call(T('ui', 'render_action')!, { id: 'alerte', component: 'Button', props: { label: 'Envoyer l’alerte', variant: 'destructive' } });
      out.push('🎛️ Commandes affichées dans la zone Actions : seuil d’alerte, période, bouton d’alerte. Chaque geste me revient ; l’alerte reste soumise à ta confirmation.');
    } else if (evolve && /\b(ajoute|rajoute|ajouter|connecte|branche|int[eè]gre|change (le|la|les) (layout|th[eè]me|titre|couleur)|mets (un|une)|nouveau panneau|nouvelle (vue|page)|remplace le (graphique|panneau)|transforme)\b/i.test(m) && !/\balerte\b/i.test(m)) {
      await plan(['Qualifier la demande d’évolution', 'Déléguer à l’équipe (Data Engineer → PO → Développeur, CLI shadcn, build)', 'Contrôler la nouvelle version (build, backend, cohérence)']);
      await step(1, 'done', 'évolution de l’app, pas une opération sur les données');
      await call(evolve, { request: m });
      await step(2, 'doing', 'équipe en cours');
      out.push('🛠️ Demande d’évolution : je délègue à l’équipe (Data Engineer → Product Owner → Développeur, CLI shadcn + build).', 'Une nouvelle version sera créée (historique et retour arrière conservés) et l’aperçu se rechargera tout seul. Je te fais le compte rendu ici même.');
    } else if (mem && /\b(retiens|souviens|m[ée]morise|mon objectif|mes objectifs|d[ée]sormais)\b/i.test(m)) {
      const fact = m.replace(/^(retiens|souviens-toi|m[ée]morise)\s*(que|bien)?\s*:?\s*/i, '').replace(/[.!]+$/, '');
      await call(mem, { fact });
      out.push(`🧠 Noté dans ma mémoire : « ${fact} ». J’en tiendrai compte dans mes contrôles et suggestions.`);
    } else if (rCall && /quel(s|le)? produit|par produit|d['’]o[uù] vient|pourquoi|explique|baisse|chute|stock|catalogue/i.test(m)) {
      // ---- Retrieval multi-étapes sur les MCP ----
      await plan(['Découvrir les sources MCP', 'Lire les métriques et repérer la baisse', 'Ventes par produit : jour de baisse vs veille', 'Lire le stock (ressource catalogue)', 'Contrôle qualité', 'Mettre à jour le dashboard']);
      await step(1, 'doing');
      const cat = await call(rList!, {}) as any;
      const metricsTool = (cat.outils ?? []).find((o: any) => /get_metrics$/.test(o.id));
      const byProd = (cat.outils ?? []).find((o: any) => /get_sales_by_product$/.test(o.id));
      const res = rRes ? ((await call(rRes, {}) as any).ressources ?? []) : [];
      const catalogue = res.find((r: any) => /catalogue|produit/i.test(`${r.uri} ${r.name}`));
      await step(1, 'done', `${(cat.outils ?? []).length} outils, ${res.length} ressources`);
      if (!metricsTool || !byProd) { await step(2, 'failed', 'aucune source de ventes'); throw new Error('aucune source MCP de ventes dans la liste blanche de l’app'); }
      await step(2, 'doing');
      const met = await call(rCall, { tool: metricsTool.id, args: { source: 'ventes', days: 30 } }) as any; sources.add(met.source);
      const pts: any[] = met.data?.points ?? [];
      let anomalyDate = '';
      if (anomalies) { const a = (await call(anomalies, {}) as any)?.anomalies?.filter((x: any) => x.sens === 'baisse').at(-1); if (a) { anomalyDate = a.date; sources.add('backend de l’app › detect_anomalies'); } }
      if (!anomalyDate && pts.length) anomalyDate = [...pts].sort((x, y) => x.commandes - y.commandes)[0].date;
      const idx = pts.findIndex((p) => p.date === anomalyDate);
      const prev = pts[idx - 1]?.date ?? pts[idx + 1]?.date;
      await step(2, 'done', `baisse le ${anomalyDate} (${pts[idx]?.commandes ?? '?'} commandes)`);
      await step(3, 'doing');
      const day = await call(rCall, { tool: byProd.id, args: { date: anomalyDate } }) as any; sources.add(day.source);
      const ref = await call(rCall, { tool: byProd.id, args: { date: prev } }) as any;
      const rows = (day.data?.lignes ?? []).map((l: any) => { const r = (ref.data?.lignes ?? []).find((x: any) => x.sku === l.sku); return { sku: l.sku, nom: l.nom, jour: l.commandes, veille: r?.commandes ?? 0, ecart: l.commandes - (r?.commandes ?? 0) }; }).sort((a: any, b: any) => a.ecart - b.ecart);
      await step(3, 'done', `${rows.length} produits comparés au ${prev}`);
      await step(4, 'doing');
      let stock: any[] = [];
      if (catalogue && rRead) { const r = await call(rRead, { server: catalogue.server, uri: catalogue.uri }) as any; stock = r.data?.produits ?? []; sources.add(`${catalogue.server} › ${catalogue.uri}`); }
      await step(4, stock.length ? 'done' : 'skipped', stock.length ? `${stock.length} fiches` : 'pas de catalogue');
      await step(5, 'doing');
      const sum = rows.reduce((a: number, r: any) => a + r.jour, 0);
      const gap = Math.abs(sum - (day.data?.total_commandes ?? sum));
      const qc = gap <= Math.max(3, sum * 0.1) ? `cohérent (Σ produits ${sum} ≈ total ${day.data?.total_commandes})` : `⚠ écart de ${gap} commandes entre produits et total`;
      await step(5, 'done', qc);
      const worst = rows[0];
      const st = stock.find((p) => p.sku === worst?.sku);
      await dash({ focus: 'retrieval', panel: { type: 'hbar', title: `Écart par produit · ${anomalyDate} vs ${prev}`, data: rows.map((r: any) => ({ label: r.nom, value: r.ecart })) } });
      await step(6, 'done', 'panneau temporaire ajouté');
      report(`Baisse du ${anomalyDate} analysée (${pts[idx]?.commandes ?? '?'} commandes vs ${pts.find((p) => p.date === prev)?.commandes ?? '?'} la veille).`,
        `Principal recul : ${worst?.nom} (${worst?.ecart} commandes)${st ? `, stock actuel ${st.stock}${st.stock < 20 ? ' ⚠ bas → rupture probable' : ''}` : ''}. Contrôle : ${qc}.`,
        st && st.stock < 20 ? `réapprovisionner ${st.nom} ; je peux t’envoyer une alerte (« envoie une alerte »).` : 'surveiller ce produit sur 7 jours.');
    } else if (simulate && /simul|sc[ée]nario|what.?if|et si|hausse|augment|r[ée]dui/i.test(m) && pctIn(m) !== undefined && !/applique/i.test(m)) {
      const p = pctIn(m)!;
      const traffic = /trafic\D{0,20}([+-]?\d+)/i.exec(m)?.[1];
      await plan([`Simuler prix ${fmt(p)}${traffic ? ` et trafic ${traffic} %` : ''}`, 'Contrôler le résultat', 'Afficher le scénario dans le dashboard']);
      await step(1, 'doing');
      const r = await call(simulate, { price_change_pct: p, ...(traffic ? { traffic_change_pct: Number(traffic) } : {}) }) as any; sources.add('backend de l’app › simulate_scenario');
      await step(1, 'done', `CA ${fmt(r.ecart_ca_pct)}`);
      const ok = Array.isArray(r.serie) && r.serie.length > 0 && Number.isFinite(r.total_ca_scenario);
      await step(2, ok ? 'done' : 'failed', ok ? `${r.serie.length} jours projetés` : 'historique insuffisant');
      await dash({ scenario: { price_change_pct: p, ...(traffic ? { traffic_change_pct: Number(traffic) } : {}) }, focus: 'simulation' });
      await step(3, 'done');
      report(`Scénario prix ${fmt(p)} simulé sur ${r.serie?.length ?? 14} jours et affiché dans le panneau Simulation.`,
        `Commandes ${fmt(r.variation_commandes_pct)}, CA ${fmt(r.ecart_ca_pct)} (${eur(r.total_ca_scenario)} vs ${eur(r.total_ca_prevu)} prévus).`,
        (await moves(p)) || (r.ecart_ca_pct >= 0 ? 'dis « applique +' + p + ' % » pour l’envoyer (avec ta confirmation).' : 'essaie une hausse plus douce.'));
    } else if (thresholds && /alerte.*\b(si|quand|d[eè]s que)\b.*([<>]|sous|moins|plus|au-dessus|en dessous)/i.test(m)) {
      const n = Number(/(\d+(?:[.,]\d+)?)/.exec(m.replace(/.*?(<|sous|moins de|en dessous de)/i, ''))?.[1]?.replace(',', '.'));
      const key = /conversion/i.test(m) ? 'conversion_min' : 'commandes_min';
      await plan(['Poser la règle de surveillance', 'Afficher le seuil dans le dashboard']);
      await call(thresholds, { [key]: n }); sources.add('backend de l’app › set_thresholds');
      await step(1, 'done', `${key} = ${n}`);
      await dash({ focus: 'kpis', seuil: { [key]: n } }); await step(2, 'done');
      report(`Règle posée : je surveille en continu ${key === 'conversion_min' ? 'la conversion' : 'les commandes'} < ${n}.`, 'Le seuil apparaît en pointillé sur les jauges et la courbe.', 'si le seuil est franchi, je te le signale ici et je te proposerai l’alerte (confirmation requise).');
    } else if (price && /applique|appliquer|change le prix|monte le prix|baisse le prix/i.test(m) && pctIn(m) !== undefined) {
      const p = pctIn(m)!;
      try { const r = await call(price, { percent: p }) as any; await journal(`Prix ${fmt(p)}`, `facteur ${r?.prix_facteur}`); sources.add(`${price.server} › ${price.name}`); report(`Prix ${fmt(p)} appliqué après ta confirmation.`, `facteur prix ${r?.prix_facteur} ; action journalisée.`, 'je surveille l’effet sur les commandes du jour.'); }
      catch (e) { await journal(`Prix ${fmt(p)}`, (e as Error).message, 'refusee').catch(() => {}); throw e; }
    } else if (alert && /alerte|alerter|pr[ée]viens|notifie/i.test(m)) {
      const k = kpis ? await call(kpis, {}) as any : null;
      const a = anomalies ? (await call(anomalies, {}) as any)?.anomalies?.slice(-1)[0] : null;
      const message = /:\s*(.+)$/.exec(m)?.[1] ?? (a ? `Anomalie ventes ${a.date} : ${a.commandes} commandes (${a.cause_probable})` : k?.alertes?.length ? `Seuil franchi : ${k.alertes.join(' ; ')}` : `Point ventes : ${k?.kpis?.commandes?.valeur ?? '?'} commandes (${fmt(k?.kpis?.commandes?.variation_pct ?? 0)} vs 7 j)`);
      try { await call(alert, { message, niveau: a || k?.alertes?.length ? 'attention' : 'info' }); await journal('Alerte', message); sources.add(`${alert.server} › ${alert.name}`); report('Alerte envoyée après ta confirmation et journalisée.', `« ${message} »`); }
      catch (e) { await journal('Alerte', (e as Error).message, 'refusee').catch(() => {}); throw e; }
    } else if (series && /compar/i.test(m)) {
      const pts = ((await call(series, { days: 14 }) as any).points ?? []) as any[]; sources.add('backend de l’app › get_series');
      const a = pts.slice(-7), b = pts.slice(-14, -7);
      const sum = (x: any[], k: string) => x.reduce((s, p) => s + (p[k] ?? 0), 0);
      const data = [{ label: 'Semaine dernière', value: sum(b, 'commandes') }, { label: 'Cette semaine', value: sum(a, 'commandes') }];
      await dash({ focus: 'retrieval', panel: { type: 'bar', title: 'Commandes · semaine vs semaine', data } });
      report('Comparaison des deux dernières semaines affichée.', `${data[1].value} commandes vs ${data[0].value} (${fmt(data[0].value ? Math.round((data[1].value / data[0].value - 1) * 1000) / 10 : 0)}), CA ${eur(sum(a, 'ca_eur'))} vs ${eur(sum(b, 'ca_eur'))}.`);
    } else if (kpis) {
      const k = await call(kpis, {}) as any; sources.add('backend de l’app › get_kpis');
      if (k?.vide) out.push('Aucune donnée encore : le dashboard se remplit au prochain rafraîchissement.');
      else report('Point de situation.', `${k.kpis.commandes.valeur} commandes (${fmt(k.kpis.commandes.variation_pct)}), CA ${eur(k.kpis.ca_eur.valeur)}, conversion ${k.kpis.conversion_pct.valeur} % — statut ${k.statut}.`, (await moves()) || undefined);
    } else out.push('Donne-moi un ordre : « pourquoi les ventes ont baissé ? », « simule +10 % de prix », « alerte si commandes < 100 », « ajoute un panneau de marge ».');
  } catch (e) {
    out.push(state.paused ? partialReport(state, maxSteps) : `⚠️ Chantier interrompu : ${(e as Error).message}.`);
  }
  const text = out.join('\n');
  // Voix = outil : en conversation orale, le contremaître dit l'essentiel (1re phrase du compte rendu), le détail reste écrit.
  const speakT = T('voice', 'speak');
  if (ctx.voice && speakT && text) {
    const first = text.replace(/[*_`#]|\p{Extended_Pictographic}/gu, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    await call(speakT, { text: first.slice(0, 220), style: /alerte|⚠️|refus/i.test(text) ? 'alerte' : 'jarvis' }).catch(() => {});
  }
  await say(ctx, text);
  ctx.emit({ type: 'done', text, ms: Date.now() - t0, toolCalls: state.calls, changed: state.changed, continuable: state.paused || undefined, steps: state.used });
  return text;
}
