/**
 * Les outils de l'app lisent db.list, ils ne peuvent pas appeler GitHub.
 * Les lignes ramenées par la liaison sont versées dans les collections que le backend lit vraiment.
 */

export type McpSample = { tool: string; args?: unknown; result: unknown; collection?: string };

export function collectionsInBackend(src: string): string[] {
  const names = new Set<string>();
  for (const match of src.matchAll(/db\.(?:list|insert|find|count|get|update|remove|clear)\(\s*['"]([A-Za-z][\w-]{0,40})['"]/g)) names.add(match[1]);
  for (const match of src.matchAll(/__rows\(\s*db\s*,\s*['"]([A-Za-z][\w-]{0,40})['"]/g)) names.add(match[1]);
  return [...names];
}

const NESTED_DATES = ['date', 'created_at', 'createdAt', 'published_at', 'publishedAt', 'updated_at', 'updatedAt', 'pushed_at', 'committed_at', 'authored_at', 'closed_at', 'merged_at', 'mergedAt'];

/** Première date ISO dans l'objet ou un niveau en dessous. Vaut pour commit, node, ou tout autre enrobage. */
function nestedDate(value: Record<string, unknown>, depth = 0): string | null {
  for (const key of NESTED_DATES) {
    const found = value[key];
    if (typeof found === 'string' && /\d{4}-\d{2}-\d{2}/.test(found)) return found;
  }
  if (depth >= 2) return null;
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      const found = nestedDate(child as Record<string, unknown>, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function asRow(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if ('_plus' in raw || '_champs_omises' in raw) return null;
  const row: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(raw)) {
    if (field == null || typeof field === 'number' || typeof field === 'boolean') row[key] = field;
    else if (typeof field === 'string') {
      if ((key === 'body' || key === 'body_text' || key === 'bodyText') && row.prCount == null) {
        const pulls = field.match(/\/pull\/\d+/g);
        row.prCount = pulls ? new Set(pulls).size : 0;
      }
      row[key] = field.length > 180 ? field.slice(0, 180) : field;
    }
    else if (Array.isArray(field)) {
      const names = field.map((item) => (typeof item === 'string' ? item : item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string' ? (item as { name: string }).name : null)).filter((name): name is string => !!name);
      if (names.length) row[key] = names.slice(0, 8);
    }     else if (typeof field === 'object') {
      const nested = field as Record<string, unknown>;
      const dated = nestedDate(nested);
      if (dated && row.date == null) row.date = dated;
      if (row.message == null && typeof nested.message === 'string') row.message = nested.message.length > 180 ? nested.message.slice(0, 180) : nested.message;
      if (row.title == null && typeof nested.title === 'string') row.title = nested.title.length > 180 ? nested.title.slice(0, 180) : nested.title;
      if (typeof nested.login === 'string') row[key] = { login: nested.login };
      else if (typeof nested.name === 'string' && key !== 'commit') row[key] = nested.name;
    }
  }
  if (typeof row.state === 'string') row.state = row.state.toLowerCase();
  const login = typeof row.author === 'string' ? row.author : (row.author && typeof row.author === 'object' ? String((row.author as { login?: unknown }).login ?? '') : typeof row.user === 'string' ? row.user : (row.user && typeof row.user === 'object' ? String((row.user as { login?: unknown }).login ?? '') : ''));
  if (login) { row.author = login; row.user = { login }; }
  if (typeof row.owner === 'string' && typeof row.repo === 'string' && !row.repo.includes('/')) row.repository = row.repository ?? `${row.owner}/${row.repo}`;
  if ((row.merged_at || row.mergedAt) && (row.state == null || row.state === 'closed')) row.state = 'merged';
  if (row.id == null && row.number != null) row.id = String(row.number);
  if (typeof row.date === 'string' && row.createdAt == null) { row.createdAt = row.date; row.created_at = row.date; }
  for (const [snake, camel] of [['created_at', 'createdAt'], ['updated_at', 'updatedAt'], ['merged_at', 'mergedAt'], ['closed_at', 'closedAt'], ['published_at', 'publishedAt'], ['tag_name', 'tagName']] as const) {
    if (row[camel] == null && typeof row[snake] === 'string') row[camel] = row[snake];
    if (row[snake] == null && typeof row[camel] === 'string') row[snake] = row[camel];
  }
  if (row.user == null && row.author && typeof row.author === 'object') row.user = { login: String((row.author as { login?: unknown }).login ?? '') };
  if (row.author == null && row.user && typeof row.user === 'object') row.author = { login: String((row.user as { login?: unknown }).login ?? '') };
  return Object.keys(row).length ? row : null;
}

function groupsOf(data: unknown, depth = 0): Array<{ key: string; rows: Array<Record<string, unknown>> }> {
  if (!data || typeof data !== 'object' || depth > 3) return [];
  if (Array.isArray(data)) {
    const rows = data.map(asRow).filter((row): row is Record<string, unknown> => !!row);
    return rows.length ? [{ key: '', rows }] : [];
  }
  const out: Array<{ key: string; rows: Array<Record<string, unknown>> }> = [];
  for (const [key, value] of Object.entries(data as object)) {
    if (Array.isArray(value)) {
      const rows = value.map(asRow).filter((row): row is Record<string, unknown> => !!row);
      if (rows.length) out.push({ key, rows });
    } else if (value && typeof value === 'object') {
      for (const child of groupsOf(value, depth + 1)) out.push({ key: child.key || key, rows: child.rows });
    }
  }
  return out;
}

/** Même famille, noms différents : search_repositories alimente `depots`, get_me alimente `profil`. */
const FAMILIES: Array<[string, string[]]> = [
  ['depot', ['depot', 'depots', 'repo', 'repos', 'repository', 'repositories']],
  ['profil', ['profil', 'profile', 'user', 'owner']],
  ['issue', ['issue', 'issues']],
  ['pullrequest', ['pullrequest', 'pullrequests']],
  ['commit', ['commit', 'commits']],
];

function tokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length > 1));
}

function serverOf(tool: string): string {
  return tool.includes('__') ? tool.split('__')[0] : '';
}

/** Correspondance exacte pour tout serveur. Les synonymes (profil, dépôts, issues) ne valent que pour GitHub. */
export function affinity(collection: string, tool: string, key: string): number {
  const flat = (value: string) => value.toLowerCase().replace(/[_-]/g, '');
  const bag = flat(`${tool} ${key}`);
  const name = flat(collection);
  if (key && flat(key) === name) return 5;
  if (bag.includes(name)) return 4;
  const stem = name.replace(/s$/, '');
  if (stem.length > 3 && bag.includes(stem)) return 3;
  if (serverOf(tool) !== 'github') return 0;
  const bagTokens = tokens(`${tool} ${key}`);
  const nameTokens = tokens(collection);
  for (const [, words] of FAMILIES) {
    const collectionHit = words.some((word) => nameTokens.has(word) || name === word || stem === word.replace(/s$/, ''));
    const bagHit = words.some((word) => bagTokens.has(word));
    if (collectionHit && bagHit) return 3;
  }
  if ((name === 'profil' || name === 'profile' || nameTokens.has('profil')) && bagTokens.has('me')) return 3;
  return 0;
}

function titled(text: string, index: number): Record<string, unknown> {
  const titre = text.trim().slice(0, 180);
  return { id: String(index + 1), titre, title: titre, label: titre };
}

/** Un texte, ou une liste de textes, devient des lignes. Beaucoup de MCP ne renvoient pas un tableau d'objets. */
function textRows(data: string): Array<Record<string, unknown>> {
  const lines = data.split('\n').map((line) => line.replace(/^\s*[-*]\s*/, '').replace(/^\d+(?:\.\d+)*\s+/, '').trim()).filter((line) => line.length > 2 && line.length < 180 && !line.endsWith(':'));
  const picked = lines.length > 1 ? lines.slice(0, 40) : [data.trim().slice(0, 280)];
  return picked.filter(Boolean).map(titled);
}

function sampleGroups(data: unknown): Array<{ key: string; rows: Array<Record<string, unknown>> }> {
  if (typeof data === 'string' && data.trim()) return [{ key: '', rows: textRows(data) }];
  if (Array.isArray(data) && data.length && data.every((item) => typeof item === 'string')) return [{ key: '', rows: data.slice(0, 40).map((item, index) => titled(String(item), index)) }];
  const groups = groupsOf(data);
  if (groups.length) return groups;
  const row = asRow(data);
  return row ? [{ key: '', rows: [row] }] : [];
}

function lookupId(src: string, collection: string): string | null {
  const match = new RegExp(`db\\.get\\(\\s*['"]${collection}['"]\\s*,\\s*['"]([^'"]+)['"]`).exec(src);
  return match?.[1] ?? null;
}

const DETAIL_KEYS = ['name', 'location', 'bio', 'public_repos', 'company', 'blog', 'followers', 'following'];

function stampScope(row: Record<string, unknown>, args: unknown) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return;
  const scope = args as Record<string, unknown>;
  if (row.repo == null && typeof scope.repo === 'string') row.repo = scope.repo;
  if (row.owner == null && typeof scope.owner === 'string') row.owner = scope.owner;
  if (typeof row.owner === 'string' && typeof row.repo === 'string' && !row.repo.includes('/') && row.repository == null) row.repository = `${row.owner}/${row.repo}`;
}

export const CANONICAL = ['issues', 'pullRequests', 'commits', 'depots', 'profil'];

/** Collection qui peut recevoir ces lignes. Une famille canonique ne sert pas de bac par défaut. */
export function collectionForRead(toolsSource: string, samples: Array<{ tool?: string; rows?: Array<Record<string, unknown>> }>): string {
  const backend = collectionsInBackend(toolsSource);
  const richest = [...samples].sort((left, right) => (right.rows?.length ?? 0) - (left.rows?.length ?? 0))[0];
  const tool = richest?.tool ?? '';
  const ranked = backend.map((collection) => ({ collection, score: affinity(collection, tool, '') }));
  const best = ranked.reduce((max, item) => Math.max(max, item.score), 0);
  if (best > 0) return ranked.find((item) => item.score === best)!.collection;
  const neutral = backend.find((collection) => !CANONICAL.includes(collection));
  if (neutral) return neutral;
  const stem = tool.includes('__') ? tool.split('__').slice(1).join('__') : tool;
  const name = stem.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
  return name || backend[0] || 'lignes';
}

/** Une collection `serveur__table` ne reçoit pas les lignes d'un autre serveur. */
function sameServer(tool: string, collection: string): boolean {
  const locked = collection.includes('__') ? collection.split('__')[0] : '';
  if (!locked) return true;
  const server = tool.includes('__') ? tool.split('__')[0] : '';
  return server === locked;
}

/** Colections → lignes. state passe en minuscules pour que `=== "open"` voie les "OPEN" de GitHub.
 *  data_list lit ces noms même si tools.ts ne les a pas écrits : la porte de lecture reste stable. */
export function seedFromSamples(toolsSource: string, samples: McpSample[], extra: string[] = []): Record<string, Array<Record<string, unknown>>> {
  const fromBackend = collectionsInBackend(toolsSource);
  const collections = [...new Set([...fromBackend, ...CANONICAL, ...extra])];
  const seed: Record<string, Array<Record<string, unknown>>> = {};
  const seen = new Map<string, Set<string>>();
  for (const sample of samples) {
    for (const group of sampleGroups(sample.result)) {
      const ranked = collections.map((collection) => ({ collection, score: affinity(collection, sample.tool, group.key) }));
      const best = ranked.reduce((max, item) => Math.max(max, item.score), 0);
      let targets = sample.collection
        ? [sample.collection]
        : ranked.filter((item) => item.score === best && best > 0).map((item) => item.collection);
      const only = fromBackend.length === 1 ? fromBackend[0] : '';
      if (!sample.collection && !targets.length && only && sameServer(sample.tool, only) && !CANONICAL.includes(only)) targets = [only];
      if (!sample.collection && !targets.length && best === 0) {
        const home = collectionForRead('', [{ tool: sample.tool }]);
        if (home && home !== 'lignes') targets = [home];
      }
      if (!targets.length) continue;
      for (const target of targets) {
        const rows = seed[target] ?? [];
        const ids = seen.get(target) ?? new Set<string>();
        for (const row of group.rows) {
          if (rows.length >= 240) break;
          const id = String(row.id ?? row.number ?? '');
          if (id && ids.has(id)) continue;
          if (id) ids.add(id);
          const copy = { ...row };
          stampScope(copy, sample.args);
          rows.push(copy);
        }
        seed[target] = rows;
        seen.set(target, ids);
        const id = lookupId(toolsSource, target);
        if (id && rows.length === 1) rows[0].id = id;
        if (rows.length === 1 && /\.details|details\./.test(toolsSource) && !rows[0].details) {
          const details: Record<string, unknown> = {};
          for (const key of DETAIL_KEYS) if (rows[0][key] != null) details[key] = rows[0][key];
          if (Object.keys(details).length) rows[0].details = details;
        }
      }
    }
  }
  return seed;
}
