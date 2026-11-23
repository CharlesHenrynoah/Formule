/**
 * Sources n8n d'une app : exécution manuelle → attente → ingestion dans le backend de l'app.
 *
 * Pourquoi : `execute_workflow` (MCP n8n) rend la main tout de suite avec un id d'exécution ;
 * l'agent devait ensuite sonder `get_workflow_execution` à la main (et épuisait son budget d'étapes),
 * et rien ne versait le résultat dans la base de l'app (get_kpis restait vide).
 * Ici : une seule « étape » pour l'agent ou le pad « Rafraîchir » :
 *   startExecution → waitExecution (backoff, ~60 s max) → fetchOutput (JSON du dernier nœud) → toPoints → ingestion.
 * Rien n'active, ne publie ni ne modifie le workflow : exécution manuelle uniquement (avec confirmation).
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { inferSchema } from '../agent/events.ts';
import { join } from 'node:path';

export type HubCall = (toolId: string, args: Record<string, unknown>) => Promise<unknown>;
export type SourceCfg = { server: string; workflowId?: string; triggerNodeName?: string; webhookData?: Record<string, unknown>; node?: string };
export type ExecInfo = { id: string; status: string; startedAt?: string; stoppedAt?: string; lastNode?: string; mode?: string };
export type Point = { date: string; segment: string; nb_clients: number; nb_feedbacks: number; sentiment: number; version?: string; [k: string]: unknown };

export const TERMINAL = new Set(['success', 'error', 'crashed', 'canceled', 'cancelled']);
export const WAIT_TIMEOUT_MS = Number(process.env.N8N_WAIT_TIMEOUT_MS ?? 60_000);
/** Backoff des sondages : 1 s, 1,5 s, 2,5 s, 4 s, puis 5 s. */
export const BACKOFF_MS = [1000, 1500, 2500, 4000, 5000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parse = (x: unknown): any => { if (typeof x === 'string') { try { return JSON.parse(x); } catch { return x; } } return x; };

/** Serveurs n8n de la liste blanche (ceux qui exposent get_workflow_execution). */
export function n8nServers(whitelist: string[] = [], hubToolIds: string[] = []) {
  const servers = [...new Set(whitelist.map((t) => t.split('__')[0]).filter(Boolean))];
  return servers.filter((s) => whitelist.includes(`${s}__get_workflow_execution`) || hubToolIds.includes(`${s}__get_workflow_execution`));
}

/** Infos d'exécution, quelle que soit la forme de réponse (MCP n8n : { execution: {...}, data: {...} }). */
export function execInfo(r0: unknown): ExecInfo | null {
  const r = parse(r0);
  if (!r || typeof r !== 'object') return null;
  const e = (r.execution ?? r.data?.execution ?? r) as Record<string, any>;
  const id = e.id ?? e.executionId ?? r.executionId;
  const status = String(e.status ?? r.status ?? (e.finished === true ? 'success' : ''));
  if (id === undefined && !status) return null;
  return { id: String(id ?? ''), status, startedAt: e.startedAt, stoppedAt: e.stoppedAt ?? undefined, mode: e.mode, lastNode: r.data?.resultData?.lastNodeExecuted ?? r.resultData?.lastNodeExecuted };
}

/** Id d'exécution renvoyé par execute_workflow (formes tolérées : {executionId}, {execution:{id}}, {id}, texte « … 882 … »). */
export function executionIdOf(r0: unknown): string | null {
  const r = parse(r0);
  if (r && typeof r === 'object') {
    const v = r.executionId ?? r.execution?.id ?? r.data?.executionId ?? r.id;
    if (v !== undefined && v !== null && String(v)) return String(v);
  }
  const m = typeof r === 'string' ? /execution(?:\s*id)?\D{0,12}(\d+)/i.exec(r) : null;
  return m ? m[1] : null;
}

/** Lance une exécution MANUELLE (jamais d'activation ni de publication). */
export async function startExecution(call: HubCall, cfg: SourceCfg & { workflowId: string }) {
  const args: Record<string, unknown> = { workflowId: cfg.workflowId, executionMode: 'manual' };
  if (cfg.triggerNodeName) args.triggerNodeName = cfg.triggerNodeName;
  if (cfg.webhookData) args.inputs = { webhookData: cfg.webhookData };
  const r = await call(`${cfg.server}__execute_workflow`, args);
  const id = executionIdOf(r);
  if (!id) throw new Error(`exécution lancée mais id introuvable dans la réponse n8n : ${JSON.stringify(parse(r)).slice(0, 200)}`);
  return { executionId: id, args };
}

/** Suit une exécution jusqu'à success / error / délai (~60 s), avec backoff. Une seule étape pour l'agent. */
export async function waitExecution(call: HubCall, server: string, workflowId: string, executionId: string,
  opts: { timeoutMs?: number; backoff?: number[]; onTick?: (e: ExecInfo, waitedMs: number) => void; signal?: AbortSignal } = {}) {
  const timeoutMs = Math.min(opts.timeoutMs ?? WAIT_TIMEOUT_MS, 120_000);
  const backoff = opts.backoff ?? BACKOFF_MS;
  const t0 = Date.now();
  let polls = 0; let last: ExecInfo | null = null;
  for (;;) {
    if (opts.signal?.aborted) break;
    last = execInfo(await call(`${server}__get_workflow_execution`, { workflowId, executionId, includeData: false }));
    polls++;
    if (last) opts.onTick?.(last, Date.now() - t0);
    if (last && TERMINAL.has(last.status)) return { status: last.status, execution: last, polls, waitedMs: Date.now() - t0, timedOut: false };
    const waited = Date.now() - t0;
    if (waited >= timeoutMs) break;
    await sleep(Math.min(backoff[Math.min(polls - 1, backoff.length - 1)], Math.max(0, timeoutMs - waited)));
  }
  return { status: last?.status || 'unknown', execution: last, polls, waitedMs: Date.now() - t0, timedOut: true };
}

/** JSON des items de sortie d'un nœud (par défaut le dernier exécuté). */
export async function fetchOutput(call: HubCall, server: string, workflowId: string, executionId: string, node?: string) {
  let name = node;
  if (!name) {
    const meta = parse(await call(`${server}__get_workflow_execution`, { workflowId, executionId, includeData: true, truncateData: 1 }));
    name = meta?.data?.resultData?.lastNodeExecuted;
    if (!name) throw new Error("dernier nœud exécuté introuvable dans l'exécution");
  }
  const r = parse(await call(`${server}__get_workflow_execution`, { workflowId, executionId, includeData: true, nodeNames: [name], truncateData: 500 }));
  const runs = r?.data?.resultData?.runData?.[name as string];
  if (!Array.isArray(runs) || !runs.length) throw new Error(`pas de données pour le nœud « ${name} » dans l'exécution ${executionId}`);
  const main = runs[runs.length - 1]?.data?.main ?? [];
  const items = (main.flat?.() ?? []).map((it: { json?: unknown }) => it?.json).filter((x: unknown) => x && typeof x === 'object');
  return { node: name as string, items: items as Record<string, any>[] };
}

const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Score de sentiment 0..1 depuis une distribution [{value,count}] (Positif=1, Neutre=0,5, Négatif=0). */
export function sentimentScore(dist: Array<{ value?: unknown; count?: unknown }> = []) {
  let tot = 0; let acc = 0; let neg = 0;
  for (const d of dist) {
    const c = Number(d?.count) || 0; const v = norm(d?.value);
    const s = /posit/.test(v) ? 1 : /neutr|mitig/.test(v) ? 0.5 : /negat/.test(v) ? 0 : NaN;
    if (Number.isNaN(s)) continue;
    tot += c; acc += s * c; if (s === 0) neg += c;
  }
  return tot ? { score: round2(acc / tot), n: tot, negatifs: neg } : null;
}

/**
 * Adapte la sortie du workflow aux points de l'app.
 *  - forme « Dynamic Persona Builder » : { meta, segments:[{ group, crm:{n_clients, satisfaction_1_5}, new_feedback:{n_interactions, sentiment[]} }], latest_personas }
 *  - forme plate : items { segment, nb_clients, sentiment, … } passés tels quels
 */
export function toPoints(items: Record<string, any>[], now = new Date()): { points: Point[]; shape: string; notes: string[] } {
  const notes: string[] = [];
  const root = items.find((x) => Array.isArray(x?.segments)) ?? (items.length === 1 && Array.isArray(items[0]?.json?.segments) ? items[0].json : null);
  if (root) {
    const date = String(root.meta?.generated_at ?? now.toISOString()).slice(0, 10);
    const personas = Array.isArray(root.latest_personas) ? root.latest_personas : [];
    const points: Point[] = [];
    let fromSatisfaction = 0;
    for (const s of root.segments as any[]) {
      const segment = String(s.group ?? s.segment ?? s.name ?? 'inconnu');
      const fb = s.new_feedback ?? {};
      const sent = sentimentScore(fb.sentiment);
      const sat = Number(s.crm?.satisfaction_1_5?.mean);
      let sentiment = sent?.score;
      let source = 'feedbacks';
      if (sentiment === undefined) { sentiment = Number.isFinite(sat) ? round2((sat - 1) / 4) : 0.5; source = Number.isFinite(sat) ? 'satisfaction CRM (1-5)' : 'défaut'; fromSatisfaction++; }
      const mine = personas.filter((p: any) => norm(p.segment) === norm(segment) || /tous/.test(norm(p.segment)));
      const v = mine.reduce((m: number, p: any) => Math.max(m, Number(p.version) || 0), 0);
      points.push({
        date, segment, nb_clients: Number(s.crm?.n_clients ?? s.n_clients ?? 0) || 0, nb_feedbacks: Number(fb.n_interactions ?? 0) || 0, sentiment,
        ...(v ? { version: `v${v}` } : {}), sentiment_source: source, ...(sent ? { negatifs: sent.negatifs } : {}), ...(Number.isFinite(sat) ? { satisfaction: sat } : {}),
      });
    }
    if (fromSatisfaction) notes.push(`${fromSatisfaction} segment(s) sans feedback sur la période (since=${root.meta?.since ?? '?'}) : sentiment estimé depuis la satisfaction CRM`);
    return { points, shape: 'segments', notes };
  }
  const flat = items.filter((x) => x && ('segment' in x || 'persona' in x) && Number.isFinite(Number(x.nb_clients ?? x.clients)));
  if (flat.length) {
    const today = now.toISOString().slice(0, 10);
    return { shape: 'flat', notes, points: flat.map((x) => ({ ...x, date: String(x.date ?? today).slice(0, 10), segment: String(x.segment ?? x.persona), nb_clients: Number(x.nb_clients ?? x.clients) || 0, nb_feedbacks: Number(x.nb_feedbacks ?? x.feedbacks ?? 0) || 0, sentiment: Number(x.sentiment ?? 0.5) })) };
  }
  return { points: [], shape: 'inconnue', notes: ['sortie du workflow non reconnue : aucun point à ingérer'] };
}

/** Résumé court pour l'agent et le chat (pas de données brutes volumineuses). */
export function summarize(items: Record<string, any>[]) {
  const root = items.find((x) => Array.isArray(x?.segments));
  if (!root) return { items: items.length };
  return {
    meta: root.meta,
    segments: root.segments.map((s: any) => ({ segment: s.group, clients: s.crm?.n_clients, satisfaction: s.crm?.satisfaction_1_5?.mean, feedbacks: s.new_feedback?.n_interactions ?? 0 })),
    personas: (root.latest_personas ?? []).map((p: any) => ({ id: p.persona_id, version: p.version, nom: p.nom_persona, segment: p.segment, date: p.date })),
  };
}

/**
 * Source décrite en langage naturel dans la demande (prompt) : « workflow dJ6mOIPdIzw7zhc8, déclencheur « Webhook GET /persona/data »,
 * nœud de sortie « Répondre données » ». Sans ça, une app générée sans deck n8n n'avait AUCUNE source → jamais d'ingestion (tout à 0).
 */
export function sourceFromText(text: string): Partial<SourceCfg> {
  const t = String(text ?? '');
  const q = `[«"“']\\s*([^»"”']{2,80}?)\\s*[»"”']`;
  const wf = /workflow\s+(?:n8n\s+)?(?:id\s*[:=]?\s*)?[«"“']?([A-Za-z0-9]{16})\b/i.exec(t) ?? /\b(?=[A-Za-z0-9]{16}\b)(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])([A-Za-z0-9]{16})\b/.exec(t);
  const trig = new RegExp(`(?:d[ée]clencheur|trigger)\\s*(?:n8n\\s*)?:?\\s*${q}`, 'i').exec(t);
  const node = new RegExp(`(?:n[œo]e?ud|node)\\s*(?:de\\s+sortie\\s*|final\\s*|output\\s*)?:?\\s*${q}`, 'i').exec(t);
  const out: Partial<SourceCfg> = {};
  if (wf) out.workflowId = wf[1];
  if (trig) out.triggerNodeName = trig[1].trim();
  if (node) out.node = node[1].trim();
  const method = /webhook\s+(GET|POST|PUT|PATCH|DELETE)\b/i.exec(out.triggerNodeName ?? '')?.[1]?.toUpperCase();
  if (method) out.webhookData = { method, query: {} };
  return out;
}

/** Prompts des demandes de l'app (mémoire personnelle : data/apps/<id>/memory.json → requests[].prompt). */
async function requestTexts(appsDir: string, appId: string): Promise<string[]> {
  try { const m = JSON.parse(await readFile(join(appsDir, appId, 'memory.json'), 'utf8')); return (m.requests ?? []).map((r: { prompt?: string }) => String(r.prompt ?? '')).filter(Boolean); } catch { return []; }
}

/**
 * Config de source : data/apps/<id>/source.json, sinon déduite du contrat (deck/pad n8n), sinon de la demande (prompt).
 * Une source déduite de la demande est enregistrée dans source.json (une fois) pour rester stable.
 */
export async function sourceConfig(appsDir: string, appId: string, contract: any, whitelist: string[], texts?: string[]): Promise<SourceCfg | null> {
  const f = join(appsDir, appId, 'source.json');
  let file: Partial<SourceCfg> = {};
  if (existsSync(f)) { try { file = JSON.parse(await readFile(f, 'utf8')); } catch { /* ignore */ } }
  const servers = n8nServers(whitelist);
  const server = file.server ?? servers[0];
  if (!server) return null;
  const decks = [...(contract?.console?.decks ?? []), ...(contract?.console?.pads ?? [])] as Array<{ args?: Record<string, unknown> }>;
  const fromContract = decks.map((d) => d.args?.workflowId ?? d.args?.workflow_id).find(Boolean);
  let fromText: Partial<SourceCfg> = {};
  if (!file.workflowId) {
    for (const tx of [...(texts ?? await requestTexts(appsDir, appId))].reverse()) { const x = sourceFromText(tx); if (x.workflowId) { fromText = x; break; } }
  }
  const cfg: SourceCfg = {
    server,
    workflowId: file.workflowId ?? (fromContract ? String(fromContract) : fromText.workflowId),
    triggerNodeName: file.triggerNodeName ?? fromText.triggerNodeName,
    webhookData: file.webhookData ?? fromText.webhookData,
    node: file.node ?? fromText.node,
  };
  if (!existsSync(f) && fromText.workflowId && cfg.workflowId === fromText.workflowId) {
    try { await writeFile(f, JSON.stringify({ ...cfg, inferredFrom: 'prompt' }, null, 2)); } catch { /* lecture seule */ }
  }
  return cfg;
}

/**
 * Outil d'ingestion de l'app : ingest_* en écriture.
 *  - argument tableau (ex. points) → on verse les points normalisés (toPoints) ;
 *  - argument objet (ex. payload) → on verse le JSON BRUT renvoyé par le nœud (l'app fait son propre mapping).
 */
export function ingestToolOf(tools: Array<{ name: string; write: boolean; inputSchema?: any; server: string; id: string }>) {
  const t = tools.find((x) => x.server.startsWith('app-') && x.write && /^ingest_/.test(x.name));
  if (!t) return null;
  const props = t.inputSchema?.properties ?? {};
  const arr = Object.keys(props).find((k) => props[k]?.type === 'array');
  const obj = Object.keys(props).find((k) => props[k]?.type === 'object');
  if (!arr && obj) return { tool: t, arg: obj, raw: true as const };
  return { tool: t, arg: arr ?? 'points', raw: false as const };
}

/** Objet racine de la sortie du workflow (forme « segments » si présente, sinon item unique, sinon { items }). */
export const rawPayload = (items: Record<string, any>[]) => items.find((x) => Array.isArray(x?.segments)) ?? (items.length === 1 ? items[0] : { items });

export type PipelineDeps = {
  call: HubCall;
  /** Verse les données dans le backend de l'app (outil ingest_*) : points normalisés + JSON brut ; null si pas d'outil d'ingestion. */
  ingest: ((points: Point[], raw: Record<string, any>) => Promise<unknown>) | null;
  /** L'outil d'ingestion attend le JSON brut (argument objet) : on ingère même si toPoints ne reconnaît pas la forme. */
  ingestRaw?: boolean;
  /** Mémorise la source (workflow + exécution) dans la base de l'app (lu par get_kpis via db.getMeta('source')). */
  setSource: (src: Record<string, unknown>) => Promise<unknown>;
  onProgress?: (msg: string) => void;
  signal?: AbortSignal;
};

/** Exécuter (optionnel) → attendre → ingérer. Ne lève pas pour un échec n8n : renvoie un état exploitable. */
export async function runPipeline(deps: PipelineDeps, cfg: SourceCfg & { workflowId: string },
  opts: { executionId?: string; execute?: boolean; timeoutMs?: number; backoff?: number[]; ingest?: boolean } = {}) {
  const out: Record<string, unknown> = { serveur: cfg.server, workflowId: cfg.workflowId };
  let executionId = opts.executionId;
  if (opts.execute) {
    const s = await startExecution(deps.call, cfg);
    executionId = s.executionId;
    deps.onProgress?.(`exécution ${executionId} lancée (manuelle)`);
  }
  if (!executionId) throw new Error('executionId requis (ou execute: true)');
  out.executionId = executionId;
  const w = await waitExecution(deps.call, cfg.server, cfg.workflowId, executionId, {
    timeoutMs: opts.timeoutMs, backoff: opts.backoff, signal: deps.signal,
    onTick: (e, ms) => deps.onProgress?.(`exécution ${executionId} : ${e.status || '?'} (${Math.round(ms / 1000)} s)`),
  });
  Object.assign(out, { statut: w.status, attente_ms: w.waitedMs, sondages: w.polls, debut: w.execution?.startedAt, fin: w.execution?.stoppedAt });
  if (w.timedOut) return { ...out, termine: false, note: `toujours « ${w.status} » après ${Math.round(w.waitedMs / 1000)} s : rappelle wait_execution avec executionId ${executionId} (rien n'a été ingéré).` };
  if (w.status !== 'success') return { ...out, termine: true, ingere: 0, note: `l'exécution s'est terminée en « ${w.status} » : rien n'a été ingéré. Ouvre l'exécution ${executionId} dans n8n pour voir le nœud en erreur.` };
  const o = await fetchOutput(deps.call, cfg.server, cfg.workflowId, executionId, cfg.node);
  const tp = toPoints(o.items);
  Object.assign(out, { termine: true, noeud: o.node, forme: tp.shape, apercu: summarize(o.items), notes: tp.notes });
  try { Object.defineProperty(out, 'schema', { value: inferSchema(rawPayload(o.items)).slice(0, 80), enumerable: false }); } catch { /* schéma indicatif */ }
  if (opts.ingest === false || !deps.ingest) return { ...out, ingere: 0, ...(deps.ingest ? {} : { note: "l'app n'a pas d'outil d'ingestion (ingest_*) : données lues mais non historisées" }) };
  if (!tp.points.length && !(deps.ingestRaw && o.items.length)) return { ...out, ingere: 0 };
  const res = await deps.ingest(tp.points, rawPayload(o.items));
  const n = tp.points.length || o.items.length;
  const source = { serveur: cfg.server, workflowId: cfg.workflowId, executionId, noeud: o.node, mode: 'manual', fin: w.execution?.stoppedAt ?? null, ingere_le: new Date().toISOString(), points: n, ...(deps.ingestRaw ? { format: 'brut' } : {}) };
  await deps.setSource(source);
  deps.onProgress?.(`${n} ${deps.ingestRaw ? 'objet(s) brut(s)' : 'point(s)'} ingéré(s) depuis l'exécution ${executionId}`);
  return { ...out, ingere: n, source, ...(deps.ingestRaw ? { resultat_ingestion: res } : {}) };
}

/**
 * Identité de la source de CETTE app, injectée au contremaître : il ne doit pas attribuer des données vides de l'app
 * à l'erreur d'un AUTRE workflow (ex. « personas = 0 » expliqué par l'échec d'un scraper TikTok sans lien).
 */
export function sourceIdentity(cfg: SourceCfg | null): string {
  if (!cfg?.workflowId) return `\n- Aucune source n8n n'est configurée pour cette app (pas de workflowId) : si les données sont vides, dis-le clairement (cause : aucune ingestion) et propose de préciser le workflow source ; n'attribue PAS le vide à l'erreur d'un autre workflow.`;
  return `\n- SOURCE DE DONNÉES DE CETTE APP : workflow ${cfg.workflowId}${cfg.triggerNodeName ? `, déclencheur « ${cfg.triggerNodeName} »` : ''}${cfg.node ? `, nœud de sortie « ${cfg.node} »` : ''} (serveur ${cfg.server}).
- Données vides / KPI à 0 : diagnostique CE workflow (dernière ingestion via get_kpis, ses exécutions, puis refresh_data). Une erreur d'un AUTRE workflow n'explique les données de l'app que si ce workflow alimente explicitement la source ci-dessus : sinon, sépare les deux sujets et dis que ce n'est pas la cause.`;
}

