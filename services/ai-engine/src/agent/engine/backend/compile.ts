/**
 * Compile un contrat d'opérations en server/tools.ts.
 * L'agent décrit la logique. Le fichier, l'export et les handlers synchrones viennent d'ici.
 */

const NAME = /^[a-z][a-z0-9_]{0,47}$/;
const COLLECTION = /^[A-Za-z][\w-]{0,40}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,40}(?:\.[A-Za-z_][A-Za-z0-9_]{0,40}){0,2}$/;
const OPERATIONS = new Set(['list', 'get', 'aggregate', 'groupby', 'sort', 'filter', 'simulate', 'insert']);
const METRICS = new Set(['count', 'sum', 'avg', 'min', 'max']);
const RESERVED = new Set(['data_list', 'data_get', 'es_set_source', 'es_get_source']);

export type CompileResult = {
  ok: boolean;
  source: string;
  tools: string[];
  problems: string[];
  typescript: boolean;
};

type Op = Record<string, unknown>;

const HELPERS = `function __pick(row, path) {
  var parts = String(path).split('.');
  var cur = row;
  for (var i = 0; i < parts.length; i++) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}
function __rows(db, collection, args, defaults) {
  var keys = Object.keys(defaults || {});
  return db.list(collection).filter(function (row) {
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var wanted = args[key] != null && args[key] !== '' ? args[key] : defaults[key];
      if (wanted == null || wanted === '') continue;
      if (String(__pick(row, key)).toLowerCase() !== String(wanted).toLowerCase()) return false;
    }
    return true;
  });
}
function __order(rows, field, direction) {
  var copy = rows.slice().sort(function (a, b) {
    var av = __pick(a, field), bv = __pick(b, field);
    if (av === bv) return 0;
    return av > bv ? 1 : -1;
  });
  if (direction === 'desc') copy.reverse();
  return copy;
}
function __page(rows, args) {
  if (args.perPage == null || args.perPage === '') return rows;
  var cap = Math.min(100, Math.max(1, Math.trunc(Number(args.perPage))));
  return rows.slice(0, cap);
}
`;

export function guardBackendSource(source: string): string[] {
  const problems: string[] = [];
  if (typeof source !== 'string' || !source.trim()) {
    problems.push('Écriture 0 bytes : contenu vide ou non transmis');
    return problems;
  }
  if (!/export\s+const\s+tools\b/.test(source)) problems.push('Backend 0/0 outils : export const tools absent');
  if (/\b(async|await)\b/.test(source)) problems.push('async/await interdit : les handlers doivent être synchrones');
  if (/\bimport\s*\(|\brequire\s*\(|\bprocess\.|\bglobalThis\b/.test(source)) problems.push('backend refusé : import, require ou process');
  return problems;
}

export function readOps(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return [parsed];
    } catch { /* contrat illisible */ }
    return [];
  }
  if (raw && typeof raw === 'object') return [raw];
  return [];
}

function ident(value: unknown, pattern: RegExp): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return pattern.test(text) ? text : null;
}

function flatFilter(filter: unknown): { defaults: Record<string, string | number | boolean>; input: string; problem?: string } {
  const defaults: Record<string, string | number | boolean> = {};
  if (filter == null) return { defaults, input: '' };
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return { defaults, input: '', problem: 'filter doit être un objet de valeurs simples' };
  const fields: string[] = [];
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (!FIELD.test(key) || key.includes('.')) return { defaults, input: '', problem: `filtre « ${key} » hors contrat` };
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return { defaults, input: '', problem: `filtre « ${key} » : valeur simple attendue` };
    defaults[key] = value;
    const type = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
    fields.push(`${key}: { type: '${type}', optional: true }`);
  }
  return { defaults, input: fields.join(', ') };
}

function inputOf(fields: string[], extra: string[] = []): string {
  const all = [...fields.filter(Boolean), ...extra];
  return `{ ${all.join(', ')} }`;
}

function toolBlock(name: string, description: string, kind: string, write: boolean, safe: boolean, input: string, body: string): string {
  return `  ${name}: {
    description: ${JSON.stringify(description)},
    kind: '${kind}',
    input: ${input},
    write: ${write},
    safe: ${safe},
    run: (args, db) => {
      ${body}
    },
  }`;
}

function compileOne(op: Op): { block: string; name: string } | { problem: string; typescript: boolean } {
  const name = ident(op.name, NAME);
  if (!name) return { problem: 'nom d\'outil invalide (snake_case attendu)', typescript: false };
  if (RESERVED.has(name)) return { problem: `${name} est déjà fourni par la plateforme`, typescript: false };
  const operation = String(op.operation ?? '').trim().toLowerCase();
  if (!OPERATIONS.has(operation)) return { problem: `${name} : opération « ${op.operation ?? ''} » hors compilateur`, typescript: true };
  const collection = ident(op.collection, COLLECTION);
  if (!collection) return { problem: `${name} : collection absente ou invalide`, typescript: false };
  const kindRaw = String(op.kind ?? '').trim().toLowerCase();
  if (kindRaw === 'action') return { problem: `${name} : une action confirme l'utilisateur, elle dépasse le compilateur`, typescript: true };
  const filterSource = op.filter && typeof op.filter === 'object' && !Array.isArray(op.filter) ? { ...(op.filter as Record<string, unknown>) } : undefined;
  const fallbackId = operation === 'get' && typeof filterSource?.id === 'string' ? filterSource.id : '';
  if (operation === 'get' && filterSource) delete filterSource.id;
  const filter = flatFilter(operation === 'get' ? filterSource : op.filter);
  if (filter.problem) return { problem: `${name} : ${filter.problem}`, typescript: true };
  const field = op.field == null || op.field === '' ? '' : ident(op.field, FIELD);
  if (op.field != null && op.field !== '' && !field) return { problem: `${name} : champ invalide`, typescript: true };
  const direction = String(op.direction ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
  const description = String(op.description ?? `${operation} ${collection}`).slice(0, 240);
  const defaults = JSON.stringify(filter.defaults);
  const rows = `__rows(db, ${JSON.stringify(collection)}, args, ${defaults})`;

  if (operation === 'insert') {
    const fields = Array.isArray(op.fields) ? op.fields.map((item) => ident(item, FIELD)).filter((item): item is string => !!item && !item.includes('.')) : [];
    if (field && !field.includes('.')) fields.push(field);
    const unique = [...new Set(fields)];
    if (!unique.length) return { problem: `${name} : insert exige fields`, typescript: true };
    const input = inputOf(unique.map((key) => `${key}: { type: 'string' }`));
    const body = `var row = db.insert(${JSON.stringify(collection)}, { ${unique.map((key) => `${key}: args.${key}`).join(', ')} });\n      return { item: row, items: [row], totalCount: 1, total: 1 };`;
    return { name, block: toolBlock(name, description, 'store', true, true, input, body) };
  }

  if (operation === 'get') {
    const body = `var id = args.id != null && args.id !== '' ? String(args.id) : ${JSON.stringify(fallbackId)};\n      if (!id) return { item: null, items: [], totalCount: 0, total: 0 };\n      var row = db.get(${JSON.stringify(collection)}, id);\n      if (!row) return { item: null, items: [], totalCount: 0, total: 0 };\n      return { item: row, items: [row], totalCount: 1, total: 1 };`;
    return { name, block: toolBlock(name, description, 'read', false, true, inputOf([filter.input, "id: { type: 'string', optional: true }"]), body) };
  }

  if (operation === 'aggregate') {
    const metric = METRICS.has(String(op.metric ?? 'count')) ? String(op.metric ?? 'count') : '';
    if (!metric) return { problem: `${name} : metric parmi count, sum, avg, min, max`, typescript: false };
    if (metric !== 'count' && !field) return { problem: `${name} : ${metric} exige field`, typescript: false };
    const body = metric === 'count'
      ? `var rows = ${rows};\n      return { total: rows.length, totalCount: rows.length };`
      : `var rows = ${rows};\n      var total = ${metric === 'min' || metric === 'max' ? 'null' : '0'};\n      for (var i = 0; i < rows.length; i++) {\n        var n = Number(__pick(rows[i], ${JSON.stringify(field)}));\n        if (n !== n || n === 1/0 || n === -1/0) continue;\n        ${metric === 'sum' || metric === 'avg' ? 'total += n;' : metric === 'min' ? 'if (total == null || n < total) total = n;' : 'if (total == null || n > total) total = n;'}\n      }\n      ${metric === 'avg' ? 'if (rows.length) total = total / rows.length;' : ''}\n      return { total: total == null ? 0 : total, totalCount: rows.length };`;
    return { name, block: toolBlock(name, description, 'read', false, true, inputOf([filter.input]), body) };
  }

  if (operation === 'groupby') {
    if (!field) return { problem: `${name} : groupBy exige field`, typescript: false };
    const body = `var rows = ${rows};\n      var buckets = {};\n      for (var i = 0; i < rows.length; i++) {\n        var key = String(__pick(rows[i], ${JSON.stringify(field)}) ?? '—');\n        buckets[key] = (buckets[key] || 0) + 1;\n      }\n      var items = Object.keys(buckets).map(function (key) { var row = { key: key, label: key, count: buckets[key], total: buckets[key], totalCount: buckets[key] }; row[${JSON.stringify(field)}] = key; return row; });\n      return { items: items, totalCount: items.length, total: rows.length };`;
    return { name, block: toolBlock(name, description, 'read', false, true, inputOf([filter.input]), body) };
  }

  if (operation === 'simulate') {
    const body = `var rows = ${rows};\n      var factor = args.factor != null && args.factor !== '' ? Number(args.factor) : 1;\n      if (factor !== factor || factor === 1/0 || factor === -1/0) factor = 1;\n      return { total: rows.length * factor, totalCount: rows.length };`;
    return { name, block: toolBlock(name, description, 'simulate', false, true, inputOf([filter.input, "factor: { type: 'number', optional: true }"]), body) };
  }

  const sortField = operation === 'sort' ? field : (field && (operation === 'list' || operation === 'filter') ? field : '');
  if (operation === 'sort' && !sortField) return { problem: `${name} : sort exige field`, typescript: false };
  const ordered = sortField ? `__order(${rows}, ${JSON.stringify(sortField)}, ${JSON.stringify(operation === 'sort' || op.direction ? direction : 'asc')})` : rows;
  const body = `var all = ${ordered};\n      var items = __page(all, args);\n      return { items: items, totalCount: all.length, total: all.length };`;
  const page = "perPage: { type: 'integer', optional: true }";
  return { name, block: toolBlock(name, description, 'read', false, true, inputOf([filter.input, page]), body) };
}

export function compileBackend(raw: unknown): CompileResult {
  const ops = readOps(raw);
  if (!ops.length) {
    return { ok: false, source: '', tools: [], problems: ['Backend 0/0 outils : aucune opération dans le contrat'], typescript: false };
  }
  const blocks: string[] = [];
  const tools: string[] = [];
  const problems: string[] = [];
  let typescript = false;
  const seen = new Set<string>();
  for (const item of ops) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      problems.push('opération illisible');
      continue;
    }
    const compiled = compileOne(item as Op);
    if ('problem' in compiled) {
      problems.push(compiled.problem);
      typescript = typescript || compiled.typescript;
      continue;
    }
    if (seen.has(compiled.name)) {
      problems.push(`${compiled.name} : nom déjà présent`);
      continue;
    }
    seen.add(compiled.name);
    tools.push(compiled.name);
    blocks.push(compiled.block);
  }
  if (problems.length || !blocks.length) {
    return { ok: false, source: '', tools, problems: problems.length ? problems : ['Backend 0/0 outils : aucune opération compilable'], typescript };
  }
  const source = `${HELPERS}\nexport const tools = {\n${blocks.join(',\n')},\n};\n`;
  const guard = guardBackendSource(source);
  if (guard.length) return { ok: false, source: '', tools, problems: guard, typescript: false };
  return { ok: true, source, tools, problems: [], typescript: false };
}
