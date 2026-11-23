/**
 * @es/app-mcp — cœur du backend MCP de chaque app générée.
 *
 * Le Développeur écrit `server/tools.ts` :
 *   export const tools = {
 *     add_task: {
 *       description: 'Ajoute une tâche',
 *       input: { title: { type: 'string', description: 'Titre' }, priority: { type: 'string', enum: ['basse','moyenne','haute'], optional: true } },
 *       write: true, safe: true,            // safe : l'agent de l'app peut l'exécuter sans confirmation
 *       run: (args, db) => db.insert('tasks', { title: args.title, done: false }),
 *     },
 *   };
 *
 * Isolation : le code est transpilé (esbuild, hors bac à sable) puis évalué dans un contexte `node:vm`
 * SANS objet hôte (DONT_CONTEXTIFY) : ni require, ni process, ni fetch, ni eval/Function (codeGeneration off).
 * Les arguments entrent et les résultats sortent en JSON (chaînes) ; chaque appel a un délai maximal.
 * Le processus serveur est en plus lancé avec le modèle de permissions Node (voir server.mjs).
 */
import vm from 'node:vm';

export const MAX_DB_BYTES = 5 * 1024 * 1024;
export const CALL_TIMEOUT_MS = 1000;
const NAME = /^[a-z][a-z0-9_]{0,47}$/;
/** Familles d'outils : lecture/agrégation, simulation (sans écriture), stockage local, action (effet externe → confirmation). */
export const KINDS = new Set(['read', 'simulate', 'store', 'action']);
/** Outils de plateforme ajoutés à chaque backend (non écrits par l'équipe). */
export const BUILTINS = [
  { name: 'es_set_source', description: "Plateforme : mémorise la provenance des données ingérées (workflow, exécution, nœud) — lue par get_kpis via db.getMeta('source')", input: { source: { type: 'object' } }, write: true, safe: true, kind: 'store' },
  { name: 'es_get_source', description: 'Plateforme : provenance des dernières données ingérées (workflow, exécution, date)', input: {}, write: false, safe: true, kind: 'read' },
];
/** Le modèle écrit souvent `int`. Sans alias, le schéma retombe sur string et refuse le nombre 100. */
const TYPE_ALIAS = {
  int: 'integer', integer: 'integer', long: 'integer',
  number: 'number', float: 'number', double: 'number', num: 'number', decimal: 'number',
  bool: 'boolean', boolean: 'boolean',
  str: 'string', string: 'string', text: 'string',
  arr: 'array', array: 'array', list: 'array',
  obj: 'object', object: 'object', dict: 'object', map: 'object',
};
function jsonType(raw) {
  return TYPE_ALIAS[String(raw ?? '').trim().toLowerCase()] ?? 'string';
}

/** API `db` disponible dans les handlers (évaluée DANS le contexte isolé). */
const PRELUDE = `
var module = { exports: {} }; var exports = module.exports;
var console = { log: function(){}, warn: function(){}, error: function(){} };
var __data = {};
function __clone(x) { return x === undefined ? null : JSON.parse(JSON.stringify(x)); }
function __col(n) { n = String(n); if (!/^[A-Za-z][\\w-]{0,40}$/.test(n)) throw new Error('collection invalide : ' + n); if (!Array.isArray(__data[n])) __data[n] = []; return __data[n]; }
function __match(x, f) { if (!f) return true; for (var k in f) { if (f[k] !== undefined && x[k] !== f[k]) return false; } return true; }
var db = {
  list: function (n, filter) { return __clone(__col(n).filter(function (x) { return __match(x, filter); })); },
  get: function (n, id) { var x = __col(n).find(function (y) { return String(y.id) === String(id); }); return x ? __clone(x) : null; },
  find: function (n, pred) { return __clone(__col(n).filter(function (x) { return pred(__clone(x)); })); },
  count: function (n, filter) { return __col(n).filter(function (x) { return __match(x, filter); }).length; },
  insert: function (n, obj) { __data.__seq = (__data.__seq || 0) + 1; var item = Object.assign({ id: String(__data.__seq), createdAt: new Date().toISOString() }, __clone(obj), { id: (obj && obj.id) ? String(obj.id) : String(__data.__seq) }); __col(n).push(item); return __clone(item); },
  update: function (n, id, patch) { var c = __col(n); var i = c.findIndex(function (y) { return String(y.id) === String(id); }); if (i < 0) return null; c[i] = Object.assign({}, c[i], __clone(patch), { id: c[i].id, updatedAt: new Date().toISOString() }); return __clone(c[i]); },
  remove: function (n, id) { var c = __col(n); var i = c.findIndex(function (y) { return String(y.id) === String(id); }); if (i < 0) return false; c.splice(i, 1); return true; },
  clear: function (n) { __data[String(n)] = []; return true; },
  collections: function () { return Object.keys(__data).filter(function (k) { return k.indexOf('__') !== 0; }); },
  getMeta: function (k) { return __clone((__data.__meta || {})[k]); },
  setMeta: function (k, v) { __data.__meta = __data.__meta || {}; __data.__meta[k] = __clone(v); return true; },
};
`;

/** Noms sous lesquels un écran généré va chercher la même liste. Un seul présent suffit : on recopie. */
const LIST_NAMES = ['items', 'issues', 'pullRequests', 'pull_requests', 'commits', 'rows', 'results', 'records', 'data'];
const DATE_PAIRS = [['created_at', 'createdAt'], ['updated_at', 'updatedAt'], ['merged_at', 'mergedAt'], ['closed_at', 'closedAt']];
const FIELD_PAIRS = [['language', 'lang'], ['count', 'nombre'], ['week', 'semaine']];

function isRowArray(value) {
  return Array.isArray(value) && (value.length === 0 || (value[0] && typeof value[0] === 'object'));
}

function alignRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return;
  for (const [snake, camel] of DATE_PAIRS) {
    if (row[camel] == null && typeof row[snake] === 'string') row[camel] = row[snake];
    if (row[snake] == null && typeof row[camel] === 'string') row[snake] = row[camel];
  }
  if (typeof row.user === 'string') row.user = { login: row.user };
  if (typeof row.author === 'string') row.author = { login: row.author };
  if (row.user == null && row.author && typeof row.author === 'object' && row.author.login) row.user = { login: row.author.login };
  if (row.author == null && row.user && typeof row.user === 'object' && row.user.login) row.author = { login: row.user.login };
  for (const [left, right] of FIELD_PAIRS) {
    if (row[right] == null && (typeof row[left] === 'string' || typeof row[left] === 'number')) row[right] = row[left];
    if (row[left] == null && (typeof row[right] === 'string' || typeof row[right] === 'number')) row[left] = row[right];
  }
  if (row.date == null && typeof row.week === 'string') row.date = row.week;
  for (const key of Object.keys(row)) {
    if (!key.includes('.')) continue;
    const parts = key.split('.');
    let cur = row;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    if (cur[leaf] == null) cur[leaf] = row[key];
  }
}

function mirrorTotals(parsed) {
  if (parsed.total == null && typeof parsed.totalCount === 'number') parsed.total = parsed.totalCount;
  if (parsed.totalCount == null && typeof parsed.total === 'number') parsed.totalCount = parsed.total;
}

function isIdentity(parsed) {
  return Object.keys(parsed).some((key) => key === 'login' || key === 'full_name' || key.includes('.'));
}

/** Une liste unique devient lisible sous chaque nom. Une liste déjà présente (même vide) n'est pas écrasée. */
function exposeItems(parsed) {
  if (Array.isArray(parsed)) parsed = { items: parsed, totalCount: parsed.length };
  if (!parsed || typeof parsed !== 'object') return parsed;
  let lists = LIST_NAMES.filter((name) => isRowArray(parsed[name])).map((name) => parsed[name]);
  if (!lists.length) {
    const extras = Object.entries(parsed).filter(([key, value]) => !LIST_NAMES.includes(key) && isRowArray(value)).map(([, value]) => value);
    if (extras.length === 1) lists = extras;
    else if (isIdentity(parsed)) {
      const row = { ...parsed };
      alignRow(row);
      parsed.items = [row];
      lists = [parsed.items];
    } else {
      mirrorTotals(parsed);
      return parsed;
    }
  }
  const primary = lists.find((rows) => rows.length > 0) ?? lists[0];
  for (const row of primary) alignRow(row);
  for (const name of LIST_NAMES) if (!isRowArray(parsed[name])) parsed[name] = primary;
  if (parsed.totalCount == null) parsed.totalCount = primary.length;
  mirrorTotals(parsed);
  return parsed;
}

const CALL = `(function () {
  var t = (module.exports.tools || module.exports.default || {})[__name];
  if (!t || typeof t.run !== 'function') throw new Error('outil inconnu : ' + __name);
  var r = t.run(JSON.parse(__args), db);
  if (r && typeof r.then === 'function') throw new Error('les handlers doivent être synchrones (pas de async/await)');
  return JSON.stringify(r === undefined ? { ok: true } : r);
})()`;

const META = `JSON.stringify(Object.entries(module.exports.tools || module.exports.default || {}).map(function (e) {
  var t = e[1] || {}; return { name: e[0], description: t.description, input: t.input || {}, write: !!t.write, safe: !!t.safe, kind: t.kind || '', hasRun: typeof t.run === 'function' };
}))`;

/** Transpile server/tools.ts en JS CommonJS (esbuild, côté hôte). */
export async function compileTools(tsSource) {
  if (typeof tsSource !== 'string' || !tsSource.trim()) throw new Error('server/tools.ts vide');
  if (tsSource.length > 200_000) throw new Error('server/tools.ts trop gros');
  const { transform } = await import('esbuild');
  const r = await transform(tsSource, { loader: 'ts', format: 'cjs', target: 'es2022', sourcefile: 'server/tools.ts' });
  return r.code;
}

/** Filtres de lecture : l'interface peut les omettre. Un défaut vit dans le handler. `required: true` les rend exigibles. */
const FILTERS = new Set(['sort', 'direction', 'order', 'orderBy', 'order_by', 'perPage', 'per_page', 'page', 'limit', 'offset', 'fields', 'state', 'since', 'until']);
/** Pagination : l'écran envoie un nombre, même si le schéma a dit string. */
const PAGINATION = new Set(['perPage', 'per_page', 'page', 'limit', 'offset']);

/** Schéma JSON d'entrée à partir de la description simplifiée `input`. */
export function inputToJsonSchema(input = {}) {
  const properties = {}; const required = [];
  for (const [k, f0] of Object.entries(input ?? {})) {
    const f = typeof f0 === 'string' ? { type: f0 } : (f0 ?? {});
    const type = jsonType(f.type);
    const p = { type };
    if (f.description) p.description = String(f.description);
    if (Array.isArray(f.enum)) p.enum = f.enum;
    if (type === 'array') {
      const itemType = jsonType(f.items?.type ?? f.items);
      p.items = f.items && TYPE_ALIAS[String(f.items?.type ?? f.items).trim().toLowerCase()] ? { type: itemType } : {};
    }
    properties[k] = p;
    if (!f.optional && !(FILTERS.has(k) && f.required !== true)) required.push(k);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function checkArgs(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments : objet attendu');
  for (const k of schema.required) if (args[k] === undefined || args[k] === null || args[k] === '') throw new Error(`argument requis : ${k}`);
  const stateRequired = schema.required.includes('state');
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    const p = schema.properties[k];
    if (!p) continue; // champs inconnus ignorés
    let val = v;
    const asNumber = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : NaN);
    const paginating = PAGINATION.has(k) && Number.isFinite(asNumber);
    if ((p.type === 'number' || p.type === 'integer') && typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) val = Number(v);
    if (paginating) val = p.type === 'number' ? asNumber : Math.trunc(asNumber);
    if (p.type === 'boolean' && typeof v === 'string') val = v === 'true';
    const t = Array.isArray(val) ? 'array' : typeof val;
    const ok = paginating ? typeof val === 'number' && Number.isFinite(val) : p.type === 'integer' ? Number.isInteger(val) : p.type === 'number' ? typeof val === 'number' && Number.isFinite(val) : p.type === t;
    if (!ok) throw new Error(`argument ${k} : ${p.type} attendu`);
    if (p.enum && !p.enum.includes(val)) throw new Error(`argument ${k} : valeur parmi ${p.enum.join(', ')}`);
    // « all » veut dire « pas de filtre ». Le comparer à r.state vide chaque liste.
    if (!stateRequired && k === 'state' && typeof val === 'string' && /^(all|any|both|\*|tous|toutes)$/i.test(val.trim())) continue;
    out[k] = val;
  }
  return out;
}

/** Charge un backend (JS transpilé) dans un contexte isolé. */
export function loadBackend(jsCode, initialData = {}, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
  const ctx = vm.createContext(vm.constants.DONT_CONTEXTIFY, { name: 'app-backend', codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  const runIn = (code, ms = timeoutMs) => new vm.Script(code, { filename: 'server/tools.ts' }).runInContext(ctx, { timeout: ms, breakOnSigint: false });
  if (/\bimport\s*\(|\brequire\s*\(|\bprocess\.|\bglobalThis\b/.test(jsCode)) throw new Error('backend refusé : import/require/process/globalThis interdits (code autonome, données via db uniquement)');
  runIn(PRELUDE);
  runIn(`__data = JSON.parse(${JSON.stringify(JSON.stringify(initialData ?? {}))});`);
  runIn(jsCode, 2000);
  const meta = JSON.parse(runIn(META));
  const tools = [];
  for (const m of meta) {
    if (!NAME.test(m.name)) throw new Error(`nom d'outil invalide : ${m.name} (snake_case attendu)`);
    if (!m.hasRun) throw new Error(`outil ${m.name} : run(args, db) manquant`);
    tools.push({ name: m.name, description: String(m.description ?? m.name).slice(0, 500), write: m.write, safe: m.write ? m.safe : true, kind: KINDS.has(m.kind) ? m.kind : (m.write ? 'store' : 'read'), input: m.input, inputSchema: inputToJsonSchema(m.input) });
  }
  if (!tools.length) throw new Error('aucun outil exporté (export const tools = { … })');
  // Outils de plateforme (toutes les apps, même déjà générées) : provenance des données ingérées.
  for (const b of BUILTINS) if (!tools.some((x) => x.name === b.name)) tools.push({ ...b, builtin: true, inputSchema: inputToJsonSchema(b.input) });
  return {
    tools,
    call(name, args = {}) {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`outil inconnu : ${name}`);
      const clean = checkArgs(t.inputSchema, args);
      if (t.builtin) {
        if (name === 'es_get_source') return JSON.parse(runIn(`JSON.stringify(db.getMeta('source'))`));
        const src = clean.source && typeof clean.source === 'object' ? clean.source : {};
        if (JSON.stringify(src).length > 4000) throw new Error('source trop volumineuse');
        runIn(`db.setMeta('source', JSON.parse(${JSON.stringify(JSON.stringify(src))}))`);
        return { ok: true, source: src };
      }
      const snapshot = runIn('JSON.stringify(__data)');
      try {
        const res = runIn(`var __name = ${JSON.stringify(name)}, __args = ${JSON.stringify(JSON.stringify(clean))}; ${CALL}`);
        const size = runIn('JSON.stringify(__data).length');
        if (size > MAX_DB_BYTES) throw new Error('quota de données dépassé (5 Mo)');
        const parsed = JSON.parse(res);
        // Une liste nue, ou nommée issues / pullRequests / commits, n'a pas de .items : l'écran affiche 0.
        return exposeItems(parsed);
      } catch (e) {
        runIn(`__data = JSON.parse(${JSON.stringify(snapshot)});`); // rollback
        const msg = String(e?.message ?? e);
        throw new Error(/Script execution timed out/.test(msg) ? `délai dépassé (${timeoutMs} ms)` : msg);
      }
    },
    data() { return JSON.parse(runIn('JSON.stringify(__data)')); },
  };
}

/**
 * Vérifie qu'un backend respecte le contrat du PO et l'exerce dans une base jetable.
 * Renvoie { ok, problems[], tools[], smoke[] }.
 */
export async function testBackend(tsSource, contract) {
  const problems = []; const smoke = [];
  let backend;
  try { backend = loadBackend(await compileTools(tsSource), {}); }
  catch (e) { return { ok: false, problems: [`chargement : ${e.message}`], tools: [], smoke }; }
  const names = backend.tools.filter((t) => !t.builtin).map((t) => t.name);
  for (const ct of contract?.tools ?? []) {
    const t = backend.tools.find((x) => x.name === ct.name);
    if (!t) { problems.push(`outil du contrat absent du backend : ${ct.name}`); continue; }
    if (!!ct.write !== t.write) problems.push(`${ct.name} : write=${t.write} alors que le contrat dit ${!!ct.write}`);
    if (ct.kind === 'action' && t.safe) problems.push(`${ct.name} : action marquée safe — une action exige la confirmation (safe: false)`);
    for (const k of Object.keys(ct.input ?? {})) if (!(k in (t.input ?? {}))) problems.push(`${ct.name} : paramètre « ${k} » du contrat absent`);
  }
  // Exercice : écritures avec des valeurs d'exemple, puis lectures.
  const sample = (s) => Object.fromEntries(Object.entries(s.properties).filter(([k]) => s.required.includes(k)).map(([k, p]) => [k, p.enum?.[0] ?? (p.type === 'number' || p.type === 'integer' ? 1 : p.type === 'boolean' ? true : p.type === 'array' ? [] : p.type === 'object' ? {} : (/id$/i.test(k) ? '1' : 'Exemple'))]));
  const mine = backend.tools.filter((t) => !t.builtin);
  const order = [...mine.filter((t) => t.write && /^(add|create|new|set|save|log|record)_/.test(t.name)), ...mine.filter((t) => !t.write)];
  for (const t of order) {
    const args = sample(t.inputSchema);
    try {
      const r = backend.call(t.name, args); const json = JSON.stringify(r) ?? '';
      // `data` (lectures seulement, ≤ 200 Ko) sert de données factices au smoke render du front.
      smoke.push({ tool: t.name, args, ok: true, write: !!t.write, result: json.slice(0, 300), ...(!t.write && json.length <= 200_000 ? { data: r } : {}) });
    }
    catch (e) { smoke.push({ tool: t.name, args, ok: false, error: e.message }); if (!/introuvable|not found|inconnu/i.test(e.message)) problems.push(`${t.name}(${JSON.stringify(args)}) lève : ${e.message}`); }
  }
  const defs = mine.map((t) => ({ name: t.name, write: !!t.write, safe: !!t.safe, kind: t.kind, description: t.description ?? '', input: t.input ?? {} }));
  return { ok: problems.length === 0, problems, tools: names, smoke, defs };
}

/** Extrait le bloc ```json du contrat d'une spec PO et le normalise. */
export function parseContract(spec) {
  const sec = /##\s*Contrat[^\n]*\n([\s\S]*?)(?:\n##\s|$)/i.exec(spec ?? '')?.[1] ?? spec ?? '';
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(sec) ?? /(\{[\s\S]*"tools"[\s\S]*\})/.exec(sec);
  if (!m) return null;
  let c;
  try { c = JSON.parse(m[1]); } catch { try { c = JSON.parse(m[1].replace(/,\s*([}\]])/g, '$1')); } catch { return null; } }
  return normalizeContract(c);
}

export function normalizeContract(c) {
  if (!c || typeof c !== 'object') return null;
  const tools = (Array.isArray(c.tools) ? c.tools : []).filter((t) => t && NAME.test(String(t.name))).map((t) => {
    const kind = KINDS.has(t.kind) ? t.kind : (t.write ? 'store' : 'read');
    // Une action a toujours un effet : écriture + confirmation explicite, quoi que dise la spec.
    const write = kind === 'action' ? true : kind === 'simulate' ? !!t.write : !!t.write;
    return {
      name: String(t.name), description: String(t.description ?? ''), input: t.input && typeof t.input === 'object' ? t.input : {},
      kind, write, safe: kind === 'action' ? false : (write ? !!t.safe : true), ...(t.output ? { output: t.output } : {}),
    };
  });
  const k = c.console && typeof c.console === 'object' ? c.console : {};
  const str = (v, n = 80) => String(v ?? '').slice(0, n);
  const consoleCfg = {
    decks: (Array.isArray(k.decks) ? k.decks : []).slice(0, 4).map((d) => ({ label: str(d.label ?? d.tool), tool: str(d.tool, 120), args: d.args && typeof d.args === 'object' ? d.args : {} })).filter((d) => d.tool),
    knobs: (Array.isArray(k.knobs) ? k.knobs : []).slice(0, 8).map((x) => ({ param: str(x.param), label: str(x.label ?? x.param), min: Number(x.min ?? 0), max: Number(x.max ?? 100), step: Number(x.step ?? 1), default: Number(x.default ?? 0) })).filter((x) => x.param),
    pads: (Array.isArray(k.pads) ? k.pads : []).slice(0, 8).map((x) => ({ key: str(x.key, 1), label: str(x.label ?? x.tool), tool: str(x.tool, 120) })).filter((x) => x.tool),
    crossfader: k.crossfader ? str(k.crossfader, 160) : '',
    refreshSec: Math.max(5, Math.min(3600, Number(k.refreshSec ?? 15) || 15)),
  };
  // Layout imposé : zone DASHBOARD (panneaux visuels) + zone CHAT agentique (commandes en langage naturel).
  const PANEL_TYPES = new Set(['kpi', 'gauge', 'bar', 'hbar', 'combo', 'line', 'area', 'multiline', 'pie', 'radar', 'table', 'heatmap', 'map', 'simulation', 'log']);
  const dsh = c.dashboard && typeof c.dashboard === 'object' ? c.dashboard : {};
  const dashboard = {
    panels: (Array.isArray(dsh.panels) ? dsh.panels : []).slice(0, 16).map((x, i) => ({
      id: str(x?.id ?? `p${i + 1}`, 40), type: PANEL_TYPES.has(x?.type) ? x.type : 'line', title: str(x?.title ?? x?.id ?? `Panneau ${i + 1}`),
      tools: (Array.isArray(x?.tools) ? x.tools : x?.tool ? [x.tool] : []).map((t) => str(t, 120)).slice(0, 4),
    })),
    state: Object.fromEntries(Object.entries(dsh.state && typeof dsh.state === 'object' ? dsh.state : {}).slice(0, 12).map(([key, v]) => [str(key, 40), str(v, 160)])),
  };
  const ch = c.chat && typeof c.chat === 'object' ? c.chat : {};
  const chat = {
    commands: (Array.isArray(ch.commands) ? ch.commands : []).slice(0, 10).map((x) => (typeof x === 'string' ? { example: str(x, 120), does: '' } : { example: str(x?.example, 120), does: str(x?.does, 200) })).filter((x) => x.example),
  };
  const a = c.agent ?? {};
  return {
    entities: Array.isArray(c.entities) ? c.entities : [],
    tools,
    agent: {
      name: String(a.name ?? 'Assistant'), persona: String(a.persona ?? ''),
      capabilities: Array.isArray(a.capabilities) ? a.capabilities.map(String) : [],
      guardrails: Array.isArray(a.guardrails) ? a.guardrails.map(String) : [],
      tools: Array.isArray(a.tools) ? a.tools.map(String).filter((n) => tools.some((t) => t.name === n)) : tools.map((t) => t.name),
    },
    charts: Array.isArray(c.charts) ? c.charts.map(String) : [],
    console: consoleCfg,
    dashboard, chat,
    externalTools: Array.isArray(c.externalTools) ? c.externalTools.map(String).filter((x) => /^[\w-]+__[\w.-]+$/.test(x)) : [],
  };
}

/** Définition du sous-agent de l'app (OpenAI Agents SDK) dérivée de la spec et du contrat. */
export function buildAgentDef(contract, { title = 'Mini-app', spec = '' } = {}) {
  const stories = (/##\s*User stories[^\n]*\n([\s\S]*?)(?:\n##\s|$)/i.exec(spec)?.[1] ?? '').trim();
  const label = { read: 'lecture', simulate: 'simulation', store: 'stockage local', action: "ACTION, confirmation de l'utilisateur" };
  const toolLines = contract.tools.filter((t) => contract.agent.tools.includes(t.name))
    .map((t) => `- ${t.name} (${t.write && !t.safe ? label.action : label[t.kind] ?? (t.write ? 'écriture' : 'lecture')}) : ${t.description}`);
  const guardrails = [
    'Réponds en français, de façon concise (3 à 6 lignes), avec des listes si utile.',
    "N'invente jamais de données : lis-les avec les outils avant de répondre ou de résumer.",
    "Tu es le CONTREMAÎTRE du pipeline de l'app et l'unique point d'entrée de l'utilisateur (chat). Pour chaque message, ROUTE : (a) ordre opérationnel sur les données (question, retrieval, simulation, action) → tu exécutes ; (b) demande d'évolution de l'app (nouveau panneau, graphique, connecter un MCP, changer l'interface) → evolve_app (délégation à l'équipe Data Engineer/PO/Développeur, nouvelle version) ; tu n'écris jamais de code toi-même.",
    "Ordre multi-étapes : appelle d'abord plan_tasks (2 à 7 tâches), puis update_task (doing → done/failed avec une note) au fil de l'exécution ; délègue aux ouvriers (outils de l'app, MCP connectés via mcp_call, ressources via mcp_read_resource, calculs de simulation).",
    "RETRIEVAL : si l'info n'est pas dans tes outils directs, découvre avec mcp_list_tools / mcp_list_resources puis enchaîne les lectures et agrège ; lecture libre, écriture uniquement après confirmation de l'utilisateur.",
    "CONTRÔLE QUALITÉ avant de conclure : cohérence des chiffres, données manquantes, anomalies ; dis-le si un résultat est douteux.",
    "COMPTE RENDU concis (≤ 6 lignes) : ✅ fait · 📊 résultat chiffré · 🔗 sources (serveur › outil ou ressource) · 👉 prochaine suggestion. Puis mets le dashboard à jour avec set_dashboard (focus, scénario, filtre, ou panneau temporaire { panel: { type: 'bar'|'hbar'|'line'|'table', title, data: [{ label, value }] } }).",
    "Simulations : lance les outils de simulation toi-même avec des paramètres chiffrés et compare au réel ; aucune saisie de données n'est demandée à l'utilisateur.",
    "Actions (effet sur un système externe) : toujours via l'outil prévu, qui affiche une carte de confirmation ; journalise ensuite l'action si un outil de journal existe.",
    "app_cli : inspection en lecture (ls, cat, grep) et npm run build du workspace de l'app uniquement.",
    ...contract.agent.guardrails,
  ];
  const instructions = `Tu es « ${contract.agent.name} », l'agent intégré de l'app « ${title} ».
${contract.agent.persona || `Tu aides l'utilisateur à tirer le meilleur de l'app « ${title} ».`}
${stories ? `\nUser stories de l'app :\n${stories}\n` : ''}
Capacités :
${contract.agent.capabilities.map((c) => `- ${c}`).join('\n') || '- répondre aux questions sur les données de l\'app'}

Outils (backend MCP de l'app) :
${toolLines.join('\n')}
${contract.externalTools.length ? `\nOutils MCP externes autorisés : ${contract.externalTools.join(', ')}` : ''}
${contract.dashboard?.panels?.length ? `\nDashboard affiché à côté du chat (panneaux) :\n${contract.dashboard.panels.map((p) => `- ${p.id} [${p.type}] ${p.title}${p.tools.length ? ` ← ${p.tools.join(', ')}` : ''}`).join('\n')}` : ''}
${Object.keys(contract.dashboard?.state ?? {}).length ? `\nÉtat pilotable du dashboard (outil set_dashboard({ patch })) : ${Object.entries(contract.dashboard.state).map(([k, v]) => `${k} = ${v}`).join(' ; ')}` : ''}
${contract.chat?.commands?.length ? `\nOrdres typiques de l'utilisateur dans le chat :\n${contract.chat.commands.map((c) => `- « ${c.example} »${c.does ? ` → ${c.does}` : ''}`).join('\n')}` : ''}

Règles :
${guardrails.map((g) => `- ${g}`).join('\n')}`;
  return {
    name: contract.agent.name, title, instructions,
    tools: contract.agent.tools, externalTools: contract.externalTools, guardrails,
    capabilities: contract.agent.capabilities,
    confirm: contract.tools.filter((t) => t.write && !t.safe).map((t) => t.name),
    framework: 'OpenAI Agents SDK',
  };
}

/** Outils `window.app.call('<outil>')` utilisés par le front. */
export const frontToolsUsed = (code) => [...new Set([...String(code ?? '').matchAll(/app\.call\(\s*['"`]([a-z][a-z0-9_]*)['"`]/g)].map((m) => m[1]))];

/** Cohérence front / backend / agent vis-à-vis du contrat. */
export function coherence({ contract, appCode, backendTools }) {
  const names = new Set(contract.tools.map((t) => t.name));
  const front = frontToolsUsed(appCode);
  const frontUnknown = front.filter((n) => !names.has(n));
  const missing = contract.tools.map((t) => t.name).filter((n) => !(backendTools ?? []).includes(n));
  const agentUnknown = contract.agent.tools.filter((n) => !names.has(n));
  return {
    front: { ok: front.length > 0 && frontUnknown.length === 0, used: front, unknown: frontUnknown },
    backend: { ok: missing.length === 0, missing },
    agent: { ok: contract.agent.tools.length > 0 && agentUnknown.length === 0, unknown: agentUnknown },
    usesAgent: /agent\.ask\(/.test(String(appCode ?? '')),
    usesChart: /@\/components\/ui\/chart/.test(String(appCode ?? '')),
    // Mindset DJ : flux live, knobs instantanés, pads.
    live: /setInterval\(|useInterval|useLive\(/.test(String(appCode ?? '')),
    knobs: /@\/components\/ui\/slider/.test(String(appCode ?? '')),
    pads: /keydown/.test(String(appCode ?? '')),
    shell: /@\/components\/es\/app-shell/.test(String(appCode ?? '')),
  };
}
