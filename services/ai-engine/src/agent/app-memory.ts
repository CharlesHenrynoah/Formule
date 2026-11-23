/**
 * Mémoire persistante de la CREW pour chaque app (data/apps/<id>/crew-memory.json + CREW.md lisible).
 * Ce qui a déjà été fait n'est plus redécouvert à chaque ajout de feature :
 *  - brief données validé (source n8n, schéma RÉEL observé à l'ingestion — jamais inventé),
 *  - contrat courant (outils, entités, graphiques),
 *  - carte des fichiers (chemin, rôle, exports, lignes, hash),
 *  - critères d'acceptation déjà livrés, décisions, historique des versions (feature par version).
 * (À ne pas confondre avec memory.json : mémoire PERSONNELLE de l'utilisateur, tenue par le contremaître.)
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportsOfSource } from './imports-check.ts';
import { inferSchema } from './events.ts';
import { relabelText } from './ui-labels';
export const LABEL_DECISION = 'Libellés visibles en termes métier (Assistant, Indicateurs clés, Simulation, Comparer réel / scénario, Actions rapides, Sources de données, Vues enregistrées) — aucun vocabulaire DJ à l’écran';

const here = dirname(fileURLToPath(import.meta.url));
export const APPS_DIR = resolve(process.env.APPS_DIR ?? join(here, '../../../..', 'data/apps'));
export const ID = /^[a-zA-Z0-9-]{8,64}$/;

export type FileEntry = { path: string; role: string; exports: string[]; lines: number; hash: string };
export type Criterion = { id: string; text: string; version: number };
export type HistoryEntry = { version: number; at: string; kind: 'generate' | 'iterate' | 'edit' | 'retro'; request: string; features: string[]; filesChanged: string[]; mode?: 'complet' | 'incrémental' };
export type SourceInfo = { server?: string; workflowId?: string; triggerNodeName?: string; node?: string; webhookData?: unknown };
export type CrewMemory = {
  appId: string; version: number; updatedAt: string; title: string;
  brief: { text: string; source: SourceInfo | null; schema: Array<{ champ: string; type: string; exemple: string }>; schemaStatus: 'observé' | 'non échantillonné' };
  contract: any;
  spec: string;
  files: FileEntry[];
  criteria: Criterion[];
  decisions: string[];
  history: HistoryEntry[];
};

export const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 10);

/** Rôle d'un fichier en une ligne (heuristique stable, sans LLM). */
export function fileRole(path: string, content: string): string {
  if (path === 'server/tools.ts') {
    const tools = [...content.matchAll(/^\s{2}([a-z][a-z0-9_]*)\s*:\s*\{/gm)].map((m) => m[1]);
    return `backend MCP (bac à sable) — outils : ${tools.join(', ') || '?'}`;
  }
  if (path === 'src/App.tsx') {
    const panels = [...content.matchAll(/<Panel[^>]*title=["{]+([^"}]+)["}]/g)].map((m) => m[1].replace(/^[`'"]|[`'"]$/g, '').trim()).slice(0, 14);
    return `console principale (AppShell)${panels.length ? ` — panneaux : ${panels.join(' · ')}` : ''}`;
  }
  const scene = /registerScene\(\s*['"]([^'"]+)['"]\s*,\s*['"](pixi|three)['"]/.exec(content);
  if (scene) return `scène ${scene[2]} sur mesure « ${scene[1]} »`;
  if (path.startsWith('src/components/ui/')) return 'composant shadcn (généré, ne pas modifier)';
  if (path.startsWith('src/components/es/')) return 'template Everything Software (ne pas modifier)';
  if (/^src\/lib\//.test(path)) return 'utilitaires';
  if (/^src\/_/.test(path)) return 'fichier temporaire (à ignorer)';
  return path.endsWith('.tsx') ? 'composant React' : 'module';
}

/** Carte des fichiers ÉCRITS par l'équipe (les fichiers du template ne sont pas listés). */
export function fileMap(files: Record<string, string>): FileEntry[] {
  return Object.entries(files)
    .filter(([p]) => !p.startsWith('src/components/ui/') && !p.startsWith('src/components/es/') && !/\.(css|json|html)$/.test(p))
    .map(([path, c]) => ({ path, role: fileRole(path, c), exports: [...exportsOfSource(c).names].filter((n) => !/^[a-z]/.test(n) || path === 'server/tools.ts').slice(0, 20), lines: c.split('\n').length, hash: sha(c) }))
    .sort((a, b) => (a.path === 'src/App.tsx' ? -1 : b.path === 'src/App.tsx' ? 1 : a.path.localeCompare(b.path)));
}

/** Critères d'acceptation d'une spec (« - **CA3** : … », « CA3. … »). */
export function extractCriteria(spec: string, version: number): Criterion[] {
  const out: Criterion[] = [];
  for (const m of String(spec ?? '').matchAll(/^\s*[-*]?\s*\**\s*(CA\d+)\s*\**\s*(?:\([^)]*\)\s*)?\**\s*[:.)—–-]+\s*\**\s*(.+)$/gim)) {
    if (!out.some((c) => c.id === m[1].toUpperCase())) out.push({ id: m[1].toUpperCase(), text: m[2].replace(/\*\*/g, '').trim().slice(0, 300), version });
  }
  return out;
}

/** Fusion : les CA d'une spec DELTA s'ajoutent ; un CA réécrit (même id) garde sa version d'origine sauf si son texte change. */
export function mergeCriteria(prev: Criterion[], next: Criterion[]): Criterion[] {
  const m = new Map(prev.map((c) => [c.id, c]));
  for (const c of next) { const old = m.get(c.id); m.set(c.id, old && old.text === c.text ? old : c); }
  return [...m.values()].sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
}

export const nextCriterionId = (cs: Criterion[]) => `CA${cs.reduce((n, c) => Math.max(n, Number(c.id.slice(2)) || 0), 0) + 1}`;

export const changedFiles = (before: Record<string, string> = {}, after: Record<string, string> = {}) =>
  Object.keys(after).filter((p) => !p.startsWith('src/components/') && sha(after[p]) !== (before[p] !== undefined ? sha(before[p]) : '')).sort();

const memPath = (appId: string, dir = APPS_DIR) => join(dir, appId, 'crew-memory.json');

export function loadMemory(appId: string | undefined, dir = APPS_DIR): CrewMemory | null {
  if (!appId || !ID.test(appId)) return null;
  try { return JSON.parse(readFileSync(memPath(appId, dir), 'utf8')) as CrewMemory; } catch { return null; }
}

/** Source et schéma RÉELLEMENT observés (source.json + source-schema.json écrits par le pipeline n8n). */
export function observedSource(appId: string, dir = APPS_DIR) {
  const read = (f: string) => { try { return JSON.parse(readFileSync(join(dir, appId, f), 'utf8')); } catch { return null; } };
  const src = read('source.json');
  const schema = read('source-schema.json');
  return {
    source: src ? { server: src.server, workflowId: src.workflowId, triggerNodeName: src.triggerNodeName, node: src.node, webhookData: src.webhookData } as SourceInfo : null,
    schema: Array.isArray(schema?.schema) ? schema.schema : [],
    executionId: schema?.executionId as string | undefined,
  };
}

export const schemaFromSample = (sample: unknown) => inferSchema(sample);

/** Construit / met à jour la mémoire après une génération ou une évolution réussie. */
export function buildMemory(o: {
  appId: string; version: number; title?: string; prompt: string; kind: HistoryEntry['kind']; mode?: HistoryEntry['mode'];
  spec: string; brief: string; contract: any; files: Record<string, string>; prevFiles?: Record<string, string>;
  prev?: CrewMemory | null; features?: string[]; decisions?: string[]; dir?: string;
}): CrewMemory {
  const prev = o.prev ?? null;
  const obs = observedSource(o.appId, o.dir);
  const newCa = extractCriteria(o.spec, o.version);
  // Libellés métier : l'analogie DJ reste interne — la mémoire (critères, spec) emploie le vocabulaire visible de l'app.
  const criteria = mergeCriteria(prev?.criteria ?? [], newCa).map((c) => ({ ...c, text: relabelText(c.text) }));
  const filesChanged = changedFiles(o.prevFiles ?? {}, o.files);
  const features = o.features?.length ? o.features : newCa.filter((c) => !(prev?.criteria ?? []).some((p) => p.id === c.id && p.text === c.text)).map((c) => `${c.id} ${c.text}`.slice(0, 160));
  const history = [...(prev?.history ?? []).filter((h) => h.version !== o.version), { version: o.version, at: new Date().toISOString(), kind: o.kind, request: o.prompt.slice(0, 600), features: features.slice(0, 12), filesChanged, ...(o.mode ? { mode: o.mode } : {}) }].sort((a, b) => a.version - b.version);
  return {
    appId: o.appId, version: o.version, updatedAt: new Date().toISOString(),
    title: o.title || prev?.title || (/^#\s+(.+)$/m.exec(o.spec)?.[1] ?? '').trim(),
    brief: {
      text: (o.brief || prev?.brief.text || '').slice(0, 12000),
      source: obs.source ?? prev?.brief.source ?? null,
      schema: obs.schema.length ? obs.schema : (prev?.brief.schema ?? []),
      schemaStatus: obs.schema.length || prev?.brief.schemaStatus === 'observé' ? 'observé' : 'non échantillonné',
    },
    contract: o.contract ?? prev?.contract ?? null,
    spec: relabelText(o.spec).slice(0, 20000),
    files: fileMap(o.files),
    criteria,
    decisions: [...new Set([...(prev?.decisions ?? []), ...(o.decisions ?? []), LABEL_DECISION])].slice(-30),
    history,
  };
}

/** Résumé Markdown (CREW.md) — aussi injecté dans les prompts (compact). */
export function memoryMarkdown(m: CrewMemory, opts: { compact?: boolean } = {}): string {
  const c = m.contract ?? {};
  const tools = (c.tools ?? []).map((t: any) => `${t.name}${t.write ? ' ✎' : ''} (${t.kind}${Object.keys(t.input ?? {}).length ? ` · ${Object.keys(t.input).join(', ')}` : ''})`);
  const src = m.brief.source;
  const lines = [
    `# Mémoire de l'app « ${m.title} » — v${m.version}`,
    `## Source de données`,
    src?.workflowId ? `- n8n ${src.server ?? ''} · workflow ${src.workflowId}${src.triggerNodeName ? ` · déclencheur « ${src.triggerNodeName} »` : ''}${src.node ? ` · nœud « ${src.node} »` : ''}` : '- (aucune source n8n enregistrée)',
    `- Schéma ${m.brief.schemaStatus}${m.brief.schema.length ? ' :' : ' — ne pas inventer de champs'}`,
    ...m.brief.schema.slice(0, opts.compact ? 25 : 60).map((s) => `  - ${s.champ} : ${s.type}${s.exemple ? ` (ex. ${s.exemple})` : ''}`),
    `## Contrat courant`,
    `- Outils : ${tools.join(' ; ') || '—'}`,
    `- Entités : ${(c.entities ?? []).map((e: any) => e.name).join(', ') || '—'}`,
    `- Graphiques : ${relabelText((c.charts ?? []).join(' | ')) || '—'}`,
    `- Outils externes : ${(c.externalTools ?? []).join(', ') || '—'}`,
    `## Fichiers`,
    ...m.files.map((f) => `- ${f.path} (${f.lines} l., ${f.hash}) — ${relabelText(f.role)}${f.exports.length && f.path !== 'server/tools.ts' ? ` · exports : ${f.exports.slice(0, 8).join(', ')}` : ''}`),
    `## Critères déjà livrés (à ne pas casser)`,
    ...m.criteria.map((x) => `- ${x.id} (v${x.version}) : ${opts.compact ? x.text.slice(0, 140) : x.text}`),
    ...(m.decisions.length ? ['## Décisions', ...m.decisions.map((d) => `- ${d}`)] : []),
    `## Historique`,
    ...m.history.map((h) => `- v${h.version} (${h.kind}${h.mode ? `, ${h.mode}` : ''}) : ${h.request.split('\n')[0].slice(0, 160)}${h.filesChanged.length ? ` → ${h.filesChanged.join(', ')}` : ''}`),
  ];
  return lines.join('\n');
}

export async function saveMemory(m: CrewMemory, dir = APPS_DIR) {
  if (!ID.test(m.appId)) throw new Error('appId invalide');
  await mkdir(join(dir, m.appId), { recursive: true });
  await writeFile(memPath(m.appId, dir), JSON.stringify(m, null, 1));
  await writeFile(join(dir, m.appId, 'CREW.md'), memoryMarkdown(m) + '\n');
  return m;
}

/** La demande nécessite-t-elle une NOUVELLE source (le Data Engineer doit explorer) ? */
export function needsNewSource(prompt: string, mem: CrewMemory | null): boolean {
  const p = String(prompt ?? '');
  if (!mem) return true;
  const wf = /\b([A-Za-z0-9]{16})\b/g;
  for (const m of p.matchAll(wf)) if (/\d/.test(m[1]) && /[A-Z]/.test(m[1]) && m[1] !== mem.brief.source?.workflowId) return true;
  return /\b(nouvelle source|autre source|connecte|brancher?|ajoute (?:la |une )?source|autre workflow|nouveau workflow|data ?table|google sheet|import(?:e|er)? (?:un|mes) (?:fichier|csv))/i.test(p);
}

/** Évolution incrémentale ? (app existante + mémoire) — sauf demande explicite de tout refaire. */
export const isIncremental = (prompt: string, hasPrevious: boolean, mem: CrewMemory | null) =>
  hasPrevious && !!mem && !/\b(refai[st]|recrée|recommence|repars? de z[ée]ro|from scratch|tout refaire|nouvelle app)\b/i.test(prompt);

/**
 * Contrat par DIFF (spec delta du PO) : {"add_tools":[…],"update_tools":[…],"remove_tools":["x"],"add_entities":[…],
 * "add_charts":[…],"agent_tools_add":[…],"console":{…partiel},"externalTools_add":[…]}.
 */
export function applyContractDiff(base: any, diff: any): any {
  const c = JSON.parse(JSON.stringify(base ?? { entities: [], tools: [], charts: [], console: {}, agent: { tools: [] }, externalTools: [] }));
  if (!diff || typeof diff !== 'object') return c;
  c.tools = Array.isArray(c.tools) ? c.tools : [];
  const rm = new Set<string>((diff.remove_tools ?? []).map(String));
  c.tools = c.tools.filter((t: any) => !rm.has(t.name));
  for (const t of [...(diff.add_tools ?? []), ...(diff.update_tools ?? [])]) {
    if (!t?.name) continue;
    const i = c.tools.findIndex((x: any) => x.name === t.name);
    if (i >= 0) c.tools[i] = { ...c.tools[i], ...t }; else c.tools.push(t);
  }
  c.entities = [...(c.entities ?? [])];
  for (const e of diff.add_entities ?? []) if (e?.name && !c.entities.some((x: any) => x.name === e.name)) c.entities.push(e);
  const dropCharts = (diff.remove_charts ?? []).map((s: unknown) => String(s).toLowerCase()).filter((s: string) => s.length > 2);
  const named = (v: unknown) => String((v as { title?: string; id?: string })?.title ?? (v as { id?: string })?.id ?? v).toLowerCase();
  c.charts = [...new Set([...(c.charts ?? []).filter((ch: unknown) => !dropCharts.some((d: string) => named(ch) === d || named(ch).includes(d))), ...(diff.add_charts ?? [])])];
  if (Array.isArray(c.dashboard?.panels)) c.dashboard.panels = c.dashboard.panels.filter((p: unknown) => !dropCharts.some((d: string) => named(p) === d || named(p).includes(d)));
  c.externalTools = [...new Set([...(c.externalTools ?? []), ...(diff.externalTools_add ?? [])])];
  if (c.agent) c.agent.tools = [...new Set([...(c.agent.tools ?? []).filter((t: string) => !rm.has(t)), ...(diff.agent_tools_add ?? [])])];
  if (diff.console && typeof diff.console === 'object') {
    c.console = { ...(c.console ?? {}) };
    for (const k of ['decks', 'knobs', 'pads'] as const) if (Array.isArray(diff.console[k])) {
      const key = k === 'knobs' ? 'param' : k === 'pads' ? 'key' : 'label';
      const cur = [...(c.console[k] ?? [])];
      for (const x of diff.console[k]) { const i = cur.findIndex((y: any) => y[key] === x[key]); if (i >= 0) cur[i] = { ...cur[i], ...x }; else cur.push(x); }
      c.console[k] = cur;
    }
    for (const k of ['crossfader', 'refreshSec']) if (diff.console[k] !== undefined) c.console[k] = diff.console[k];
  }
  if (diff.dashboard && typeof diff.dashboard === 'object') c.dashboard = { ...(c.dashboard ?? {}), ...diff.dashboard, scenes: [...(c.dashboard?.scenes ?? []), ...(diff.dashboard.scenes ?? [])] };
  return c;
}

/** Bloc JSON « ## Contrat (diff) » d'une spec delta (null si absent). */
export function parseContractDiff(spec: string): any | null {
  const sec = /##\s*Contrat\s*\(?\s*diff[^\n]*\n([\s\S]*?)(?:\n##\s|$)/i.exec(spec ?? '')?.[1];
  if (!sec) return null;
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(sec) ?? /(\{[\s\S]*\})/.exec(sec);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { try { return JSON.parse(m[1].replace(/,\s*([}\]])/g, '$1')); } catch { return null; } }
}

/**
 * Outils implémentés par le backend mais absents du contrat : intégrés automatiquement s'ils sont appelés
 * par le front (fin de la boucle « outil hors contrat » quand le Dev a réellement implémenté l'outil).
 */
export function integrateBackendTools(contract: any, defs: Array<{ name: string; write?: boolean; safe?: boolean; kind?: string; description?: string; input?: any }>, usedByFront: string[]) {
  const known = new Set((contract?.tools ?? []).map((t: any) => t.name));
  const added: string[] = [];
  for (const d of defs ?? []) {
    if (known.has(d.name) || !usedByFront.includes(d.name) || /^es_/.test(d.name)) continue;
    contract.tools.push({ name: d.name, description: d.description ?? '', input: d.input ?? {}, kind: d.kind ?? (d.write ? 'store' : 'read'), write: !!d.write, safe: d.write ? !!d.safe : true });
    added.push(d.name);
  }
  return added;
}

/** Mémoire rétroactive d'une app existante (version la plus récente du stockage + source.json/schéma observé). */
export function retroMemory(appId: string, latest: { number: number; prompt?: string; plan?: string | null; files?: Record<string, string> | null; agent?: any; app?: any; kind?: string }, versions: Array<{ number: number; kind: string; prompt: string; created_at?: string }> = [], dir = APPS_DIR): CrewMemory {
  const m = buildMemory({ appId, version: latest.number, prompt: latest.prompt ?? '', kind: 'retro', spec: latest.plan ?? '', brief: latest.agent?.brief ?? '', contract: latest.app?.contract ?? null, files: latest.files ?? {}, title: latest.app?.title, dir });
  m.history = versions.map((v) => ({ version: v.number, at: v.created_at ?? '', kind: (v.kind as HistoryEntry['kind']) ?? 'generate', request: v.prompt.slice(0, 600), features: [], filesChanged: [] }));
  if (!m.history.length) m.history = [{ version: latest.number, at: '', kind: 'retro', request: latest.prompt ?? '', features: [], filesChanged: [] }];
  return m;
}

export const memoryExists = (appId: string, dir = APPS_DIR) => existsSync(memPath(appId, dir));
