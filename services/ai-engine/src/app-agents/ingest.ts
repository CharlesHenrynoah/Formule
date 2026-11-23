/**
 * À l'ouverture, une collection vide est remplie depuis la source MCP qui la nomme.
 * GitHub reste le chemin connu quand la demande cite owner/repo.
 * Le backend généré ne peut pas appeler le réseau : l'ingestion se fait ici, une fois.
 */
import { affinity, collectionsInBackend, seedFromSamples, type McpSample } from '../agent/seed-from-samples.ts';

export type SourceTool = {
  id: string;
  name: string;
  description?: string;
  serverName?: string;
  write?: boolean;
  inputSchema?: { required?: string[]; properties?: Record<string, unknown> };
};

const REPO = /(?:^|[\s('"`])([A-Za-z0-9][\w.-]{0,80})\/([A-Za-z0-9][\w.-]{0,80})/g;

export function repoInText(text: string): { owner: string; repo: string } | null {
  REPO.lastIndex = 0;
  for (const match of text.matchAll(REPO)) {
    if (match[1] === 'http' || match[1] === 'https') continue;
    return { owner: match[1], repo: match[2].replace(/\.+$/, '') };
  }
  return null;
}

export function githubReads(repo: { owner: string; repo: string }): Array<{ tool: string; args: Record<string, unknown> }> {
  const base = { owner: repo.owner, repo: repo.repo, perPage: 20 };
  return [
    { tool: 'github__list_issues', args: { ...base, state: 'OPEN' } },
    { tool: 'github__list_issues', args: { ...base, state: 'CLOSED' } },
    { tool: 'github__list_pull_requests', args: { ...base, state: 'open' } },
    { tool: 'github__list_pull_requests', args: { ...base, state: 'closed' } },
    { tool: 'github__list_commits', args: { ...base } },
  ];
}

/** Noms lus par l'écran via data_list, en plus de ceux du backend. */
export function collectionsInScreen(screen: string): string[] {
  const names = new Set<string>();
  for (const match of screen.matchAll(/data_list[\s\S]{0,120}?collection\s*:\s*['"]([A-Za-z][\w-]{0,40})['"]/g)) names.add(match[1]);
  return [...names];
}

const DATE_KEYS = ['date', 'createdAt', 'created_at', 'publishedAt', 'published_at', 'updatedAt', 'mergedAt'];

export function rowHasDate(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;
  const record = row as Record<string, unknown>;
  return DATE_KEYS.some((key) => typeof record[key] === 'string');
}

export function emptyCollections(source: string, db: Record<string, unknown>, screen = ''): string[] {
  const names = new Set([...collectionsInBackend(source), ...collectionsInScreen(screen)]);
  return [...names].filter((name) => !Array.isArray(db[name]) || (db[name] as unknown[]).length === 0);
}

/** Lignes déjà là, mais sans aucune date : un graphique par semaine ne peut rien tracer. */
export function datelessCollections(source: string, db: Record<string, unknown>, screen = ''): string[] {
  const names = new Set([...collectionsInBackend(source), ...collectionsInScreen(screen)]);
  return [...names].filter((name) => {
    const rows = db[name];
    return Array.isArray(rows) && rows.length > 0 && rows.every((row) => !rowHasDate(row));
  });
}

function githubFamily(collection: string): 'issues' | 'pulls' | 'commits' | null {
  if (affinity(collection, 'list_issues', 'issues') >= 3) return 'issues';
  if (affinity(collection, 'list_pull_requests', 'pull_requests') >= 3) return 'pulls';
  if (affinity(collection, 'list_commits', 'commits') >= 3) return 'commits';
  return null;
}

function hintOf(tool: SourceTool, key: string): string {
  const prop = tool.inputSchema?.properties?.[key];
  const description = prop && typeof prop === 'object' && 'description' in prop ? String((prop as { description?: unknown }).description ?? '') : '';
  return `${key} ${description}`.toLowerCase();
}

/** Arguments qu'on sait remplir, pour n'importe quel serveur. Un argument requis inconnu écarte l'outil. */
export function argsForTool(tool: SourceTool, prompt: string): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  const repo = repoInText(prompt);
  const full = repo ? `${repo.owner}/${repo.repo}` : '';
  const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
  for (const key of required) {
    const hint = hintOf(tool, key);
    if (key === 'owner' && repo) args.owner = repo.owner;
    else if (key === 'repo' && repo) args.repo = repo.repo;
    else if ((/^(repo(name)?|repository|full_?name)$/i.test(key) || /repositor|owner\/repo/.test(hint)) && full) args[key] = full;
    else if (key === 'perPage' || key === 'per_page' || key === 'limit') args[key] = 20;
    else if (key === 'page') args[key] = 1;
    else if (key === 'state' && /issue/i.test(tool.name)) args.state = 'OPEN';
    else if (key === 'state' && /pull/i.test(tool.name)) args.state = 'open';
    else if (/^(question|query|q|prompt|search)$/i.test(key)) args[key] = prompt.trim().slice(0, 200);
    else return null;
  }
  const props = tool.inputSchema?.properties ?? {};
  if (props.perPage && args.perPage == null) args.perPage = 20;
  return args;
}

function serverOf(id: string): string {
  return id.includes('__') ? id.split('__')[0] : '';
}

function squash(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '');
}

function edits(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const next = a[i - 1] === b[j - 1] ? row[j - 1]! : Math.min(row[j - 1]!, row[j]!, prev) + 1;
      row[j - 1] = prev;
      prev = next;
    }
    row[b.length] = prev;
  }
  return row[b.length] ?? 0;
}

function closeName(have: string, want: string): boolean {
  if (have.length < 4 || want.length < 4) return false;
  if (have === want || have.includes(want) || want.includes(have)) return true;
  const limit = Math.max(have.length, want.length) >= 8 ? 2 : 1;
  return edits(have, want) <= limit;
}

/** Où le nom du serveur, ou un nom qui lui ressemble, apparaît dans la demande. */
function hitAt(prompt: string, label: string): number {
  const target = squash(label);
  if (target.length < 4) return -1;
  if (squash(prompt).includes(target)) {
    const token = label.toLowerCase().split(/[^a-z0-9]+/).find((word) => word.length >= 3) ?? target.slice(0, 4);
    const at = prompt.toLowerCase().indexOf(token);
    return at < 0 ? 0 : at;
  }
  const words = prompt.toLowerCase().split(/[^a-z0-9àâäéèêëïîôùûüç]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= 3 && i + n <= words.length; n++) {
      if (!closeName(squash(words.slice(i, i + n).join('')), target)) continue;
      const at = prompt.toLowerCase().indexOf(words[i]!);
      return at < 0 ? 0 : at;
    }
  }
  return -1;
}

function mentionedServers(prompt: string, tools: SourceTool[]): { use: string[]; skip: string[] } {
  const labels = new Map<string, string[]>();
  for (const tool of tools) {
    const id = serverOf(tool.id);
    if (id.length < 3) continue;
    const names = labels.get(id) ?? [];
    names.push(id);
    if (tool.serverName) names.push(tool.serverName);
    labels.set(id, names);
  }
  const text = prompt.toLowerCase();
  const use: string[] = [];
  const skip: string[] = [];
  for (const [id, names] of labels) {
    const at = names.map((name) => hitAt(prompt, name)).find((index) => index >= 0);
    if (at == null || at < 0) continue;
    const before = text.slice(Math.max(0, at - 32), at);
    if (/sans|aucun|jamais|pas\s/.test(before)) skip.push(id);
    else use.push(id);
  }
  return { use, skip };
}

function toolScore(prompt: string, tool: SourceTool): number {
  const bag = new Set(`${tool.id} ${tool.name} ${tool.description ?? ''}`.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3));
  let score = 0;
  for (const word of prompt.toLowerCase().split(/[^a-z0-9]+/)) if (word.length > 3 && bag.has(word)) score += 2;
  if (/^(list|search|find|read|get)_/.test(tool.name)) score += 1;
  return score;
}

/**
 * Quand aucune collection connue ne nomme d'outil, on lit quand même le serveur demandé.
 * Sert à une application neuve et à un MCP qui vient d'être ajouté.
 */
export function readsForUnmatched(prompt: string, tools: SourceTool[] = []): Array<{ tool: string; args: Record<string, unknown> }> {
  const { use, skip } = mentionedServers(prompt, tools);
  let pool = tools.filter((tool) => !tool.write && tool.id && !tool.id.startsWith('app-'));
  if (use.length) pool = pool.filter((tool) => use.includes(serverOf(tool.id)));
  else if (skip.length) pool = pool.filter((tool) => !skip.includes(serverOf(tool.id)));
  const ranked = pool
    .map((tool) => ({ tool, args: argsForTool(tool, prompt), score: toolScore(prompt, tool) }))
    .filter((item): item is { tool: SourceTool; args: Record<string, unknown>; score: number } => !!item.args)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) return [];
  const floor = use.length ? 0 : 1;
  return ranked.filter((item) => item.score >= floor).slice(0, 3).map((item) => ({ tool: item.tool.id, args: item.args }));
}

/** Lectures à jouer : GitHub si le dépôt est nommé, sinon l'outil en lecture dont le nom colle à la collection. */
export function readsForCollections(missing: string[], prompt: string, tools: SourceTool[] = []): Array<{ tool: string; args: Record<string, unknown> }> {
  const reads: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const repo = repoInText(prompt);
  const families = new Set(missing.map(githubFamily).filter((family): family is 'issues' | 'pulls' | 'commits' => !!family));
  if (repo && families.size) {
    for (const read of githubReads(repo)) {
      const family = read.tool.includes('issues') ? 'issues' : read.tool.includes('pull') ? 'pulls' : 'commits';
      if (families.has(family)) reads.push(read);
    }
  }
  const used = new Set(reads.map((read) => read.tool));
  for (const collection of missing) {
    if (repo && githubFamily(collection)) continue;
    const ranked = tools
      .filter((tool) => !tool.write && tool.id && !tool.id.startsWith('app-') && !used.has(tool.id))
      .map((tool) => ({ tool, score: affinity(collection, `${tool.id} ${tool.name}`, tool.name), list: /^(list|search|find)_/.test(tool.name) ? 1 : 0 }))
      .filter((item) => item.score >= 3 && argsForTool(item.tool, prompt))
      .sort((a, b) => b.score - a.score || b.list - a.list);
    const pick = ranked[0];
    if (!pick) continue;
    reads.push({ tool: pick.tool.id, args: argsForTool(pick.tool, prompt)! });
    used.add(pick.tool.id);
  }
  return reads.slice(0, 8);
}

/** Verse les lectures dans les collections encore vides. N'écrase pas des lignes déjà là. */
export async function ingestEmptyCollections(
  source: string,
  db: Record<string, unknown>,
  prompt: string,
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  catalog?: { tools?: SourceTool[]; screen?: string },
): Promise<boolean> {
  const screen = catalog?.screen ?? '';
  const missing = emptyCollections(source, db, screen);
  const stale = datelessCollections(source, db, screen);
  const targets = [...new Set([...missing, ...stale])];
  if (!targets.length) return false;
  const samples: McpSample[] = [];
  for (const read of readsForCollections(targets, prompt, catalog?.tools ?? [])) {
    try {
      const result = await call(read.tool, read.args);
      if (result != null) samples.push({ tool: read.tool, args: read.args, result });
    } catch { /* une lecture en échec laisse les autres continuer */ }
  }
  if (!samples.length) return false;
  const seeded = seedFromSamples(source, samples, targets);
  let filled = false;
  for (const [name, rows] of Object.entries(seeded)) {
    if (!rows.length) continue;
    if (missing.includes(name)) { db[name] = rows; filled = true; continue; }
    if (stale.includes(name) && rows.some(rowHasDate)) { db[name] = rows; filled = true; }
  }
  return filled;
}
