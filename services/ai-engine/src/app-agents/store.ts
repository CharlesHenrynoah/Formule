/**
 * Matérialisation des apps : pour une version d'app (storage), écrit son backend transpilé
 * (data/apps/<id>/v<n>/tools.js + contract.json + agent.json), puis le fait lancer et enregistrer par mcp-hub.
 * Les données de l'app (data/apps/<id>/data/db.json) sont partagées entre versions.
 */
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileTools, type AgentDef, type Contract } from '../../../../packages/app-mcp/src/core.mjs';
import { ingestEmptyCollections } from './ingest.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '../../../..');
export const APPS_DIR = resolve(process.env.APPS_DIR ?? join(ROOT, 'data/apps'));
const STORAGE = process.env.STORAGE_URL ?? 'http://localhost:4003';
const HUB = process.env.MCP_HUB_URL ?? 'http://localhost:4004';

export type AppMeta = { contract: Contract; agent: AgentDef; backend: string; title?: string; seed?: Record<string, Array<Record<string, unknown>>> };
export type HubTool = { id: string; name: string; description?: string; inputSchema?: any; write: boolean; safe: boolean; allowed: boolean; server: string };
export type EnsuredApp = { appId: string; version: number; title: string; connId: string; app: AppMeta; tools: HubTool[]; status: string };

const ID = /^[a-zA-Z0-9-]{8,64}$/;
const cache = new Map<string, { at: number; v: EnsuredApp }>();

async function json(url: string, init?: RequestInit & { body?: string }) {
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body: body as any };
}

/** Lance (ou réutilise) le backend MCP de l'app pour la version demandée (dernière par défaut). */
export async function ensureApp(appId: string, version?: number): Promise<EnsuredApp> {
  if (!ID.test(appId)) throw Object.assign(new Error('appId invalide'), { status: 400 });
  const key = `${appId}@${version ?? 'latest'}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 20_000) return hit.v;
  const p = await json(`${STORAGE}/projects/${appId}`);
  if (p.status !== 200) throw Object.assign(new Error('app introuvable'), { status: 404 });
  const versions = (p.body.versions ?? []) as Array<{ number: number; prompt: string; kind: string; created_at: string; app?: AppMeta | null; files?: Record<string, string> | null }>;
  // Version demandée, sinon la plus récente qui a un backend (les éditions manuelles du HTML le conservent).
  const v = version ? versions.find((x) => x.number === version) : [...versions].reverse().find((x) => x.app);
  if (!v) throw Object.assign(new Error('version introuvable'), { status: 404 });
  const app = v.app;
  const src = app ? v.files?.[app.backend ?? 'server/tools.ts'] : undefined;
  if (!app || !src) throw Object.assign(new Error("cette version n'a pas de backend MCP ni d'agent (app générée avant cette fonctionnalité ou en mode direct)"), { status: 409 });
  const vdir = join(APPS_DIR, appId, `v${v.number}`);
  if (!existsSync(join(vdir, 'tools.js'))) {
    await mkdir(vdir, { recursive: true });
    await mkdir(join(APPS_DIR, appId, 'data'), { recursive: true });
    await writeFile(join(vdir, 'tools.js'), await compileTools(src));
    await writeFile(join(vdir, 'contract.json'), JSON.stringify(app.contract, null, 2));
    await writeFile(join(vdir, 'agent.json'), JSON.stringify(app.agent, null, 2));
  }
  // Amorçage : lignes de la liaison, puis GitHub si une collection lue par le backend est encore vide.
  const dbFile = join(APPS_DIR, appId, 'data', 'db.json');
  let refilled = false;
  await mkdir(dirname(dbFile), { recursive: true });
  let current: Record<string, unknown> = {};
  if (existsSync(dbFile)) { try { current = JSON.parse(await readFile(dbFile, 'utf8')); } catch { current = {}; } }
  let seq = Number(current.__seq) || 0;
  if (app.seed && Object.keys(app.seed).length) {
    for (const [col, rows] of Object.entries(app.seed)) {
      const have = current[col];
      if (Array.isArray(have) && have.length) continue;
      current[col] = rows.map((r) => ({ ...r, id: r.id !== undefined ? String(r.id) : String(++seq) }));
      refilled = true;
    }
  }
  const prompt = [p.body.title, ...versions.map((item) => item.prompt)].filter(Boolean).join('\n');
  if (await ingestEmptyCollections(src, current, prompt, async (tool, args) => (await callHub(tool, args, false)).data)) refilled = true;
  if (refilled) {
    const ids = Object.values(current).flatMap((rows) => Array.isArray(rows) ? rows.map((r) => Number((r as { id?: string }).id) || 0) : []);
    current.__seq = Math.max(seq, ...ids, 0);
    await writeFile(dbFile, JSON.stringify(current));
    // Le processus déjà lancé a lu l'ancien fichier au démarrage. On l'arrête pour qu'il relise.
    await json(`${HUB}/apps/${appId}`, { method: 'DELETE' }).catch(() => {});
    forget(appId);
  }
  // Mémoire personnelle : chaque demande (génération / itérations) alimente le contexte de l'agent.
  await syncRequests(appId, versions.filter((x) => x.kind !== 'edit').map((x) => ({ at: x.created_at, version: x.number, prompt: x.prompt })));
  const reg = await json(`${HUB}/apps/${appId}/register`, { method: 'POST', body: JSON.stringify({ version: v.number, name: p.body.title }) });
  if (reg.status !== 200) throw Object.assign(new Error(`backend MCP : ${reg.body?.error ?? reg.status}`), { status: 502 });
  const out: EnsuredApp = { appId, version: v.number, title: p.body.title, connId: reg.body.id, app, tools: reg.body.tools ?? [], status: reg.body.status };
  cache.set(key, { at: Date.now(), v: out });
  if (!version) cache.set(`${appId}@${v.number}`, { at: Date.now(), v: out });
  return out;
}

export function forget(appId: string) { for (const k of [...cache.keys()]) if (k.startsWith(appId + '@')) cache.delete(k); }

export async function callHub(toolId: string, args: unknown, confirmed: boolean) {
  const r = await json(`${HUB}/call`, { method: 'POST', body: JSON.stringify({ tool: toolId, args: args ?? {}, confirmed }) });
  if (r.status !== 200) throw Object.assign(new Error(r.body?.error ?? `mcp-hub ${r.status}`), { status: r.status, body: r.body });
  if (r.body.isError) {
    const d = r.body.data;
    const msg = typeof d === 'string' ? d : (d && typeof d === 'object' && typeof (d as { error?: string }).error === 'string' ? (d as { error: string }).error : `erreur outil ${toolId}`);
    throw Object.assign(new Error(msg.slice(0, 500)), { status: 422 });
  }
  return { data: r.body.data, ms: r.body.ms as number };
}

export async function externalTools(): Promise<HubTool[]> {
  const r = await json(`${HUB}/tools?allowedOnly=1`);
  return r.status === 200 ? r.body : [];
}

export async function stopApp(appId: string, removeData = false) {
  forget(appId);
  await fetch(`${HUB}/apps/${appId}`, { method: 'DELETE' }).catch(() => {});
  if (removeData && ID.test(appId)) await rm(join(APPS_DIR, appId), { recursive: true, force: true });
}

// ---- Journal des appels d'outils (agent, UI de l'app, studio) ----
export type LogEntry = { at: string; source: 'agent' | 'ui' | 'studio'; tool: string; args: unknown; ok: boolean; ms?: number; result?: string; error?: string; confirmed?: boolean };
export async function log(appId: string, e: Omit<LogEntry, 'at'>) {
  if (!ID.test(appId)) return;
  await mkdir(join(APPS_DIR, appId), { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...e, args: JSON.stringify(e.args ?? {}).length > 2000 ? '(volumineux)' : e.args, result: e.result?.slice(0, 600) });
  await appendFile(join(APPS_DIR, appId, 'log.jsonl'), line + '\n');
}
export async function readLog(appId: string, limit = 200): Promise<LogEntry[]> {
  if (!ID.test(appId)) return [];
  try {
    const lines = (await readFile(join(APPS_DIR, appId, 'log.jsonl'), 'utf8')).trim().split('\n');
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch { return []; }
}

// ---- Mémoire personnelle de l'app (data/apps/<id>/memory.json) : demandes + faits retenus par l'agent ----
export type Memory = { requests: Array<{ at: string; version: number; prompt: string }>; facts: Array<{ at: string; text: string; source: 'agent' | 'studio' }> };
const memFile = (appId: string) => join(APPS_DIR, appId, 'memory.json');
export async function readMemory(appId: string): Promise<Memory> {
  if (!ID.test(appId)) return { requests: [], facts: [] };
  try { const m = JSON.parse(await readFile(memFile(appId), 'utf8')); return { requests: m.requests ?? [], facts: m.facts ?? [] }; }
  catch { return { requests: [], facts: [] }; }
}
async function writeMemory(appId: string, m: Memory) {
  if (!ID.test(appId)) throw new Error('appId invalide');
  await mkdir(join(APPS_DIR, appId), { recursive: true });
  await writeFile(memFile(appId), JSON.stringify({ requests: m.requests.slice(-50), facts: m.facts.slice(-100) }, null, 1));
}
async function syncRequests(appId: string, reqs: Memory['requests']) {
  const m = await readMemory(appId);
  const known = new Set(m.requests.map((r) => r.version));
  const add = reqs.filter((r) => !known.has(r.version));
  if (add.length) { m.requests.push(...add); m.requests.sort((a, b) => a.version - b.version); await writeMemory(appId, m); }
}
export async function remember(appId: string, text: string, source: 'agent' | 'studio' = 'agent') {
  const t = String(text ?? '').trim().slice(0, 500);
  if (!t) throw new Error('fait vide');
  const m = await readMemory(appId);
  if (!m.facts.some((f) => f.text.toLowerCase() === t.toLowerCase())) m.facts.push({ at: new Date().toISOString(), text: t, source });
  await writeMemory(appId, m);
  return { retenu: t, total: m.facts.length };
}
export async function forgetFact(appId: string, index: number) {
  const m = await readMemory(appId);
  const [removed] = m.facts.splice(index, 1);
  await writeMemory(appId, m);
  return { oublie: removed?.text ?? null };
}
/** Bloc « contexte personnel » ajouté aux instructions de l'agent à chaque exécution. */
export function memoryContext(m: Memory) {
  const reqs = m.requests.slice(-12).map((r) => `- v${r.version} : ${r.prompt.slice(0, 300)}`).join('\n');
  const facts = m.facts.slice(-30).map((f) => `- ${f.text}`).join('\n');
  return `\n\nCONTEXTE PERSONNEL (mémoire privée de cette app, mono-utilisateur) :
Demandes de l'utilisateur qui ont façonné l'app :
${reqs || '- (aucune)'}
Préférences et objectifs retenus :
${facts || '- (rien encore)'}
Utilise ce contexte pour personnaliser tes réponses. Quand l'utilisateur exprime une préférence, un objectif ou une habitude durable, appelle remember({fact}). recall() relit la mémoire.
Quand c'est pertinent, propose 1 ou 2 améliorations personnalisées de l'app (formulées comme une demande d'itération qu'il pourra copier dans le studio).`;
}
