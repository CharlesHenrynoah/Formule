/**
 * GitHub MCP (api.githubcopilot.com) : search_issues est TOUJOURS en search_type=semantic.
 * Les requêtes type `repo:owner/name is:issue` → 422 « cannot be searched ».
 * list_issues / list_pull_requests fonctionnent. On réécrit et on retente.
 */

export type CallAttempt = { tool: string; name: string; args: Record<string, unknown>; reason?: string };

const REPO_IN_Q = /\brepo:([\w.-]+)\/([\w.-]+)\b/i;
const PAGE_KEYS = /^(perPage|per_page|limit|pageSize|page_size|max_results)$/i;

/** Vrai message d'erreur GitHub (texte), jamais un payload JSON qui contient « 422 » dans un SHA. */
export const isGithubSearchFailure = (data: unknown) => {
  if (typeof data !== 'string') return false;
  return /failed to search|Validation Failed|cannot be searched|search_type=semantic|rate limit exceeded/i.test(data);
};

/** Extrait owner/repo depuis args ou query `repo:o/r`. */
export function extractRepo(args: Record<string, unknown>) {
  const owner = typeof args.owner === 'string' ? args.owner : undefined;
  const repo = typeof args.repo === 'string' ? args.repo : undefined;
  if (owner && repo) return { owner, repo };
  const q = typeof args.query === 'string' ? args.query : '';
  const m = REPO_IN_Q.exec(q);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function capPage(args: Record<string, unknown>, max = 30) {
  const out = { ...args };
  for (const [k, v] of Object.entries(out)) {
    if (PAGE_KEYS.test(k) && typeof v === 'number' && v > max) out[k] = max;
  }
  return out;
}

function issueState(q: string, args: Record<string, unknown>): string {
  const s = String(args.state ?? '');
  // list_issues n'accepte que OPEN | CLOSED (pas ALL).
  if (/closed/i.test(s) || /\bis:closed\b/i.test(q)) return 'CLOSED';
  return 'OPEN';
}

function prState(q: string, args: Record<string, unknown>): string {
  const s = String(args.state ?? '');
  if (/closed|merged/i.test(s) || /\bis:(closed|merged)\b/i.test(q)) return 'closed';
  if (/all/i.test(s)) return 'all';
  return 'open';
}

/** Query « pure listing » (qualifiers GitHub sans vrai texte sémantique). */
export function isListingQuery(query: unknown) {
  const q = String(query ?? '').trim();
  if (!q) return true;
  const stripped = q
    .replace(/\brepo:[\w.-]+\/[\w.-]+\b/gi, '')
    .replace(/\bis:(issue|pr|open|closed|merged|all|public|private)\b/gi, '')
    .replace(/\bstate:(open|closed|all)\b/gi, '')
    .replace(/\b(type|author|assignee|label|sort|order|created|updated|merged):[^\s]+/gi, '')
    .replace(/["']/g, '')
    .trim();
  return stripped.length < 3;
}

/** Enums stricts list_issues / list_pull_requests (MCP Copilot) — pas de champs hors schéma. */
const LIGHT_FIELDS_ISSUES = ['number', 'title', 'state', 'user', 'labels', 'created_at', 'updated_at'];
const LIGHT_FIELDS_PRS = ['number', 'title', 'state', 'user', 'labels', 'created_at', 'updated_at', 'merged_at', 'html_url'];

/** Ne garde que des fields compatibles avec l'outil cible. */
function sanitizeFields(fields: unknown, allowed: string[]) {
  if (!Array.isArray(fields)) return allowed;
  const ok = fields.map(String).filter((f) => allowed.includes(f));
  return ok.length ? ok : allowed;
}

/**
 * Produit la liste d'essais : réécriture proactive search→list + original en secours éventuellement.
 * name = nom d'outil SANS préfixe serveur (list_issues), tool = id complet (github__list_issues).
 */
export function githubAttempts(toolId: string, rawArgs: Record<string, unknown>): CallAttempt[] {
  const [server, ...rest] = toolId.split('__');
  const name = rest.join('__');
  if (server !== 'github') return [{ tool: toolId, name, args: capPage(rawArgs) }];

  const args = capPage(rawArgs);
  const repo = extractRepo(args);
  const q = typeof args.query === 'string' ? args.query : '';
  const out: CallAttempt[] = [];

  if (name === 'search_issues' && repo) {
    const listArgs: Record<string, unknown> = {
      owner: repo.owner,
      repo: repo.repo,
      state: issueState(q, args),
      perPage: args.perPage ?? args.per_page ?? 20,
      fields: sanitizeFields(args.fields, LIGHT_FIELDS_ISSUES),
    };
    out.push({ tool: 'github__list_issues', name: 'list_issues', args: capPage(listArgs), reason: 'search_issues sémantique → list_issues (évite 422)' });
    // Garde search seulement s'il y a une vraie requête NL (sinon inutile).
    if (!isListingQuery(q)) {
      const searchArgs = { ...args, owner: repo.owner, repo: repo.repo, query: q.replace(REPO_IN_Q, '').replace(/\bis:issue\b/gi, '').trim() || 'issue' };
      out.push({ tool: toolId, name, args: capPage(searchArgs), reason: 'search sémantique (NL)' });
    }
    return out;
  }

  if (name === 'search_pull_requests' && repo) {
    const listArgs: Record<string, unknown> = {
      owner: repo.owner,
      repo: repo.repo,
      state: prState(q, args),
      perPage: args.perPage ?? args.per_page ?? 20,
      fields: sanitizeFields(args.fields, LIGHT_FIELDS_PRS),
    };
    out.push({ tool: 'github__list_pull_requests', name: 'list_pull_requests', args: capPage(listArgs), reason: 'search_pull_requests → list_pull_requests (évite 422)' });
    if (!isListingQuery(q) && !/\bis:merged\b/i.test(q)) {
      out.push({ tool: toolId, name, args: capPage({ ...args, owner: repo.owner, repo: repo.repo }), reason: 'search PR' });
    }
    return out;
  }

  // list_* : owner/repo + fields valides + pagination
  if (name === 'list_issues' && repo) {
    return [{ tool: toolId, name, args: capPage({ ...args, owner: repo.owner, repo: repo.repo, state: issueState(q, args), fields: sanitizeFields(args.fields, LIGHT_FIELDS_ISSUES) }) }];
  }
  if (name === 'list_pull_requests' && repo) {
    return [{ tool: toolId, name, args: capPage({ ...args, owner: repo.owner, repo: repo.repo, state: prState(q, args), fields: sanitizeFields(args.fields, LIGHT_FIELDS_PRS) }) }];
  }

  return [{ tool: toolId, name, args }];
}

/** Après un échec search : tentative list si on a un dépôt. */
export function githubFallbackAfterError(toolId: string, args: Record<string, unknown>, err: unknown): CallAttempt | null {
  const [server, ...rest] = toolId.split('__');
  const name = rest.join('__');
  if (server !== 'github') return null;
  if (!isGithubSearchFailure(err) && !isGithubSearchFailure(typeof err === 'string' ? err : (err as Error)?.message)) return null;
  const repo = extractRepo(args);
  if (!repo) return null;
  const q = typeof args.query === 'string' ? args.query : '';
  if (name === 'search_issues' || name === 'list_issues') {
    return {
      tool: 'github__list_issues', name: 'list_issues',
      args: capPage({ owner: repo.owner, repo: repo.repo, state: issueState(q, args), perPage: 20, fields: LIGHT_FIELDS_ISSUES }),
      reason: 'fallback après échec search_issues',
    };
  }
  if (name === 'search_pull_requests' || name === 'list_pull_requests') {
    return {
      tool: 'github__list_pull_requests', name: 'list_pull_requests',
      args: capPage({ owner: repo.owner, repo: repo.repo, state: prState(q, args), perPage: 20, fields: LIGHT_FIELDS_PRS }),
      reason: 'fallback après échec search_pull_requests',
    };
  }
  return null;
}
