/**
 * Les outils de l'app lisent db.list, ils ne peuvent pas appeler GitHub.
 * Les lignes ramenées par la liaison sont versées dans les collections que le backend lit vraiment.
 */

export type McpSample = { tool: string; args?: unknown; result: unknown };

export function collectionsInBackend(src: string): string[] {
  const names = new Set<string>();
  for (const match of src.matchAll(/db\.(?:list|insert|find|count|get|update|remove|clear)\(\s*['"]([A-Za-z][\w-]{0,40})['"]/g)) names.add(match[1]);
  return [...names];
}

function asRow(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if ('_plus' in raw || '_champs_omises' in raw) return null;
  const row: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(raw)) {
    if (field == null || typeof field === 'number' || typeof field === 'boolean') row[key] = field;
    else if (typeof field === 'string') row[key] = field.length > 180 ? field.slice(0, 180) : field;
    else if (Array.isArray(field)) {
      const names = field.map((item) => (typeof item === 'string' ? item : item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string' ? (item as { name: string }).name : null)).filter((name): name is string => !!name);
      if (names.length) row[key] = names.slice(0, 8);
    }     else if (typeof field === 'object') {
      const nested = field as Record<string, unknown>;
      if (typeof nested.login === 'string') row[key] = { login: nested.login };
      else if (typeof nested.name === 'string') row[key] = nested.name;
    }
  }
  if (typeof row.state === 'string') row.state = row.state.toLowerCase();
  if (row.id == null && row.number != null) row.id = String(row.number);
  for (const [snake, camel] of [['created_at', 'createdAt'], ['updated_at', 'updatedAt'], ['merged_at', 'mergedAt'], ['closed_at', 'closedAt']] as const) {
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

function affinity(collection: string, tool: string, key: string): number {
  const flat = (value: string) => value.toLowerCase().replace(/[_-]/g, '');
  const bag = flat(`${tool} ${key}`);
  const name = flat(collection);
  if (key && flat(key) === name) return 5;
  if (bag.includes(name)) return 4;
  const stem = name.replace(/s$/, '');
  if (stem.length > 3 && bag.includes(stem)) return 3;
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

function sampleGroups(data: unknown): Array<{ key: string; rows: Array<Record<string, unknown>> }> {
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
}

const CANONICAL = ['issues', 'pullRequests', 'commits', 'depots', 'profil'];

/** Colections → lignes. state passe en minuscules pour que `=== "open"` voie les "OPEN" de GitHub.
 *  data_list lit ces noms même si tools.ts ne les a pas écrits : la porte de lecture reste stable. */
export function seedFromSamples(toolsSource: string, samples: McpSample[]): Record<string, Array<Record<string, unknown>>> {
  const fromBackend = collectionsInBackend(toolsSource);
  const collections = [...new Set([...fromBackend, ...CANONICAL])];
  const seed: Record<string, Array<Record<string, unknown>>> = {};
  const seen = new Map<string, Set<string>>();
  for (const sample of samples) {
    for (const group of sampleGroups(sample.result)) {
      let target = '';
      let best = 0;
      for (const collection of collections) {
        const score = affinity(collection, sample.tool, group.key);
        const prefer = score === best && score > 0 && CANONICAL.includes(collection) && !CANONICAL.includes(target);
        if (score > best || prefer) { target = collection; best = score; }
      }
      if (!target && fromBackend.length === 1) target = fromBackend[0];
      if (!target || (best === 0 && fromBackend.length !== 1)) continue;
      const rows = seed[target] ?? [];
      const ids = seen.get(target) ?? new Set<string>();
      for (const row of group.rows) {
        if (rows.length >= 40) break;
        const id = String(row.id ?? row.number ?? '');
        if (id && ids.has(id)) continue;
        if (id) ids.add(id);
        stampScope(row, sample.args);
        rows.push(row);
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
  return seed;
}
