/**
 * À l'ouverture d'une interface, les collections vides sont remplies depuis GitHub.
 * Le backend généré ne peut pas appeler le réseau : l'ingestion se fait ici, une fois.
 */
import { collectionsInBackend, seedFromSamples, type McpSample } from '../agent/seed-from-samples.ts';

const REPO = /(?:^|[\s(])([A-Za-z0-9][\w.-]{0,80})\/([A-Za-z0-9][\w.-]{0,80})/g;

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

export function emptyCollections(source: string, db: Record<string, unknown>): string[] {
  return collectionsInBackend(source).filter((name) => !Array.isArray(db[name]) || (db[name] as unknown[]).length === 0);
}

/** Verse les lectures GitHub dans les collections encore vides. N'écrase pas des lignes déjà là. */
export async function ingestEmptyCollections(
  source: string,
  db: Record<string, unknown>,
  prompt: string,
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<boolean> {
  const missing = emptyCollections(source, db);
  const repo = repoInText(prompt);
  if (!missing.length || !repo) return false;
  const samples: McpSample[] = [];
  for (const read of githubReads(repo)) {
    try {
      const result = await call(read.tool, read.args);
      if (result != null) samples.push({ tool: read.tool, args: read.args, result });
    } catch { /* une lecture en échec laisse les autres continuer */ }
  }
  if (!samples.length) return false;
  const seeded = seedFromSamples(source, samples);
  let filled = false;
  for (const [name, rows] of Object.entries(seeded)) {
    if (!missing.includes(name) || !rows.length) continue;
    db[name] = rows;
    filled = true;
  }
  return filled;
}
