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
  write?: boolean;
  inputSchema?: { required?: string[]; properties?: Record<string, unknown> };
};

const REPO = /(?:^|[\s('"`])([A-Za-z0-9][\w.-]{0,80})\/([A-Za-z0-9][\w.-]{0,80})/g;

export function repoInText(text: string): { owner: string; repo: string } | null {
  REPO.lastIndex = 0;
  for (const match of text.matchAll(REPO)) {
    if (match[1] === 'http' || match[1] === 'https') continue;
    return { owner: match[1], repo: match[2] };
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

/** Arguments qu'on sait remplir. Un argument requis inconnu écarte l'outil. */
export function argsForTool(tool: SourceTool, prompt: string): Record<string, unknown> | null {
  const args: Record<string, unknown> = {};
  const repo = repoInText(prompt);
  const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
  for (const key of required) {
    if (key === 'owner' && repo) args.owner = repo.owner;
    else if (key === 'repo' && repo) args.repo = repo.repo;
    else if (key === 'perPage' || key === 'per_page' || key === 'limit') args[key] = 20;
    else if (key === 'page') args[key] = 1;
    else if (key === 'state' && /issue/i.test(tool.name)) args.state = 'OPEN';
    else if (key === 'state' && /pull/i.test(tool.name)) args.state = 'open';
    else return null;
  }
  const props = tool.inputSchema?.properties ?? {};
  if (props.perPage && args.perPage == null) args.perPage = 20;
  return args;
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
