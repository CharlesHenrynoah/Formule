/** Tableau vivant : un document, dessiné par les graphiques du studio, nourri par les outils MCP. */

export const INTERPRETER_TIMEOUT_MS = 120_000;

export const CHART_TYPES = ['kpi', 'line', 'bar', 'area', 'pie', 'table'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

/** Où l'élément se pose sur le visage : signal en haut, regard au centre, voix en large. */
export type ChartPlace = 'signal' | 'gaze' | 'voice';

export type ChartSpec = {
  id: string;
  title: string;
  type: ChartType;
  tool: string;
  args: Record<string, unknown>;
  x: string;
  y: string;
  place?: ChartPlace;
};

export type FilterSpec = { id: string; label: string; arg: string; options: string[] };

export type Density = 'calme' | 'parle' | 'dense';

export type DashboardSpec = {
  title: string;
  description: string;
  filters: FilterSpec[];
  charts: ChartSpec[];
  /** La phrase courte laisse de l'air. La phrase chargée serre les éléments. */
  density?: Density;
};

export type DashMode = 'create' | 'chart' | 'add' | 'filters';

const TYPES = new Set<string>(CHART_TYPES);

export function questionTitle(prompt: string) {
  const line = prompt.replace(/\s+/g, ' ').trim().replace(/[?.!]+$/, '');
  return (line || 'Tableau').slice(0, 80);
}

function slug(s: string, i: number) {
  const id = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28);
  return id || `vue-${i + 1}`;
}

export function extractJson(s: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  const raw = fenced?.[1] ?? s;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

function asArgs(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

export function normalizeChart(raw: unknown, allowed: string[], fallbackId: string): ChartSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const x = raw as Record<string, unknown>;
  const tool = String(x.tool ?? '');
  if (!allowed.includes(tool)) return null;
  const type = String(x.type ?? 'bar');
  const place = String((x as { place?: string }).place ?? '');
  return {
    id: slug(String(x.id ?? x.title ?? fallbackId), 0),
    title: String(x.title ?? 'Graphique').slice(0, 80),
    type: (TYPES.has(type) ? type : 'bar') as ChartType,
    tool,
    args: asArgs(x.args),
    x: String(x.x ?? 'label').slice(0, 40),
    y: String(x.y ?? 'value').slice(0, 40),
    ...(place === 'signal' || place === 'gaze' || place === 'voice' ? { place } : {}),
  };
}

export function normalizeFilters(raw: unknown): FilterSpec[] {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? (raw as { filters?: unknown }).filters : null);
  if (!Array.isArray(list)) return [];
  const out: FilterSpec[] = [];
  for (const f of list.slice(0, 4)) {
    if (!f || typeof f !== 'object') continue;
    const g = f as Record<string, unknown>;
    const options = Array.isArray(g.options) ? g.options.map((v) => String(v)).filter(Boolean).slice(0, 12) : [];
    if (!g.arg || !options.length) continue;
    out.push({ id: slug(String(g.id ?? g.arg), out.length), label: String(g.label ?? g.arg).slice(0, 40), arg: String(g.arg).slice(0, 40), options });
  }
  return out;
}

export function normalizeSpec(raw: unknown, allowed: string[]): DashboardSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const charts: ChartSpec[] = [];
  for (const c of (Array.isArray(o.charts) ? o.charts : []).slice(0, 8)) {
    const chart = normalizeChart(c, allowed, `vue-${charts.length + 1}`);
    if (chart) charts.push({ ...chart, id: charts.some((x) => x.id === chart.id) ? `${chart.id}-${charts.length + 1}` : chart.id });
  }
  if (!charts.length) return null;
  return {
    title: String(o.title ?? 'Tableau').slice(0, 80),
    description: String(o.description ?? '').slice(0, 240),
    filters: normalizeFilters(o.filters),
    charts,
  };
}

export function applyChart(spec: DashboardSpec, chart: ChartSpec): DashboardSpec {
  const i = spec.charts.findIndex((c) => c.id === chart.id);
  if (i < 0) return spec;
  const charts = spec.charts.slice();
  charts[i] = { ...chart, id: spec.charts[i].id };
  return { ...spec, charts };
}

export function appendChart(spec: DashboardSpec, chart: ChartSpec): DashboardSpec {
  const ids = new Set(spec.charts.map((c) => c.id));
  let id = chart.id;
  let n = 2;
  while (ids.has(id)) id = `${chart.id}-${n++}`;
  return { ...spec, charts: [...spec.charts, { ...chart, id }] };
}

export function wantsNewDashboard(prompt: string) {
  return /\b(nouveau|autre)\s+(tableau|dashboard)\b/i.test(prompt);
}

export function targetChart(prompt: string, spec: DashboardSpec | null): ChartSpec | null {
  if (!spec || wantsNewDashboard(prompt)) return null;
  const p = prompt.toLowerCase();
  const mentioned = spec.charts.filter((c) => {
    const title = c.title.toLowerCase();
    const needle = title.slice(0, Math.min(18, title.length));
    return needle.length > 3 && p.includes(needle);
  });
  const verb = /\b(change|modifie|remplace|passe|uniquement|seulement|reconstruis)\b/i.test(prompt);
  if (mentioned.length === 1 && verb) return mentioned[0];
  if (spec.charts.length === 1 && verb && /\b(graphique|courbe|barre|carte|tableau|kpi)\b/i.test(prompt)) return spec.charts[0];
  return null;
}

/** create = nouveau tableau dans l'app. Les trois autres ne touchent qu'une partie du tableau ouvert. */
export function dashMode(prompt: string, spec: DashboardSpec | null): DashMode {
  if (!spec || wantsNewDashboard(prompt)) return 'create';
  if (targetChart(prompt, spec)) return 'chart';
  if (/\bajoute\b/i.test(prompt) && /\b(graphique|courbe|carte|barre|tableau|kpi|camembert|indicateur)\b/i.test(prompt)) return 'add';
  if (/\bfiltre\b/i.test(prompt)) return 'filters';
  return 'create';
}

const STOP = new Set(['un', 'une', 'des', 'les', 'pour', 'dans', 'avec', 'sur', 'par', 'que', 'qui', 'quoi', 'comment', 'quel', 'quelle', 'quels', 'quelles', 'est', 'sont', 'etait', 'cette', 'cet', 'mon', 'mes', 'ton', 'tes', 'aux', 'du', 'au', 'le', 'la', 'et', 'ou', 'en', 'de', 'tableau', 'bord', 'dashboard', 'graphique', 'montre', 'affiche', 'depuis', 'partir', 'chaque', 'source', 'open', 'mcp', 'donne', 'donnees', 'data', 'outil', 'outils', 'branchee', 'branche', 'fait', 'faire', 'veux', 'voir', 'tout', 'tous', 'toutes', 'son', 'ses', 'leur', 'nos', 'vos', 'pas', 'comme', 'ainsi', 'alors', 'donc', 'mais', 'car', 'ces', 'elle', 'ils', 'elles', 'nous', 'vous', 'the', 'and', 'for', 'from', 'with']);

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export type ToolLike = { id: string; name?: string; description?: string; write?: boolean; inputSchema?: unknown };

export function promptTokens(prompt: string) {
  return norm(prompt).split(/[^a-z0-9]+/).filter((t) => t.length > 3 && !STOP.has(t));
}

export function repoRef(prompt: string): { owner: string; repo: string } | null {
  const m = /(?:github\.com\/)?([A-Za-z0-9_.-]{2,})\/([A-Za-z0-9_.-]{1,})/.exec(prompt);
  if (!m || /^(https?|www)$/i.test(m[1])) return null;
  return { owner: m[1], repo: m[2].replace(/[.,;:!?)]+$/, '') };
}

export function cityOf(prompt: string): string | null {
  const named = /(?:météo|meteo)\s+(?:à|a|de|pour|dans)\s+([A-ZÉÈÀÂÎÔÛÙ][\p{L}\-']{1,40})/iu.exec(prompt);
  const prep = /(?:^|[^\p{L}])(?:à|pour|dans|ville)\s+([A-ZÉÈÀÂÎÔÛÙ][\p{L}\-']{1,40})/u.exec(prompt);
  return named?.[1] ?? prep?.[1] ?? null;
}

export function expressionOf(prompt: string): string | null {
  const m = /(\d+(?:[.,]\d+)?(?:\s*[+\-*/%^]\s*\d+(?:[.,]\d+)?)+)/.exec(prompt);
  return m?.[1]?.replace(/\s/g, '') ?? null;
}

function schemaOf(schema: unknown): { properties: Record<string, { type?: string; description?: string; default?: unknown; enum?: unknown[] }>; required: string[] } {
  const s = schema && typeof schema === 'object' ? schema as { properties?: Record<string, { type?: string; description?: string; default?: unknown; enum?: unknown[] }>; required?: unknown } : {};
  return { properties: s.properties ?? {}, required: Array.isArray(s.required) ? s.required.map(String) : [] };
}

/** Arguments exigés par le schéma, remplis depuis la question. `null` si un champ requis manque. */
export function argsForPrompt(tool: ToolLike, prompt: string): Record<string, unknown> | null {
  const { properties, required } = schemaOf(tool.inputSchema);
  const args: Record<string, unknown> = {};
  const schemaDefaults = (schema: unknown) => {
    const props = schemaOf(schema).properties;
    const out: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(props)) {
      if (p?.default !== undefined) out[k] = p.default;
      else if (Array.isArray(p?.enum) && p.enum.length) out[k] = p.enum[0];
    }
    return out;
  };
  Object.assign(args, schemaDefaults(tool.inputSchema));
  const repo = repoRef(prompt);
  const city = cityOf(prompt);
  const expr = expressionOf(prompt);
  for (const key of new Set([...Object.keys(properties), ...required])) {
    if (args[key] !== undefined && args[key] !== '') continue;
    const k = key.toLowerCase();
    let v: unknown;
    if (/^(city|ville)$/.test(k)) v = city ?? undefined;
    else if (/expression/.test(k)) v = expr ?? undefined;
    else if (/^(owner|org|organization|user|username|login)$/.test(k)) v = repo?.owner;
    else if (/^(repo|repository)$/.test(k) || (k === 'name' && (properties.owner || properties.org))) v = repo?.repo;
    else if (/timezone|fuseau/.test(k) && /heure|date|fuseau|timezone|paris/.test(norm(prompt))) v = 'Europe/Paris';
    if (v !== undefined && v !== '') args[key] = v;
  }
  if (required.some((k) => args[k] === undefined || args[k] === '')) return null;
  return args;
}

export type SourcePick = { tool: ToolLike; args: Record<string, unknown>; reason: string };
export type SourceSkip = { tool: ToolLike; reason: string };

/** Ne garde que les outils qui peuvent répondre à la question, avec des arguments valides. */
export function considerSources(prompt: string, tools: ToolLike[]): { kept: SourcePick[]; skipped: SourceSkip[] } {
  const tokens = promptTokens(prompt);
  const ranked: Array<SourcePick & { score: number }> = [];
  const skipped: SourceSkip[] = [];
  for (const tool of tools) {
    if (tool.write) { skipped.push({ tool, reason: 'outil d’écriture' }); continue; }
    const { required } = schemaOf(tool.inputSchema);
    const args = argsForPrompt(tool, prompt);
    if (!args) { skipped.push({ tool, reason: `exige ${required.join(', ') || 'des arguments'}, absents de la question` }); continue; }
    const blob = norm(`${tool.id} ${tool.name ?? ''} ${tool.description ?? ''}`);
    const overlap = tokens.filter((t) => blob.includes(t));
    const repo = repoRef(prompt);
    const city = cityOf(prompt);
    const expr = expressionOf(prompt);
    const anchored = required.some((k) => {
      const v = args[k];
      const key = k.toLowerCase();
      if (/^(city|ville)$/.test(key)) return v === city;
      if (/expression/.test(key)) return expr != null && String(v).replace(/\s/g, '') === expr;
      if (/^(owner|org|organization|user|username|login)$/.test(key)) return v === repo?.owner;
      if (/^(repo|repository)$/.test(key) || key === 'name') return v === repo?.repo;
      return false;
    });
    if (!overlap.length && !anchored) { skipped.push({ tool, reason: 'ne répond pas à la question' }); continue; }
    const score = overlap.reduce((n, t) => n + t.length, 0) + (anchored ? 8 : 0);
    ranked.push({ tool, args, reason: overlap.length ? `recoupe « ${overlap.slice(0, 3).join(', ')} »` : 'arguments pris dans la question', score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return { kept: ranked.slice(0, promptDensity(prompt).slots).map(({ tool, args, reason }) => ({ tool, args, reason })), skipped };
}

/** Plus la phrase est chargée (clauses, questions, longueur), plus le visage a d'éléments. */
export function promptDensity(prompt: string): { level: Density; slots: number } {
  const text = prompt.replace(/\s+/g, ' ').trim();
  const tokens = promptTokens(text);
  const clauses = text.split(/[.;!?]|,\s+|\b(?:et|puis|aussi|avec|ainsi)\b/i).map((s) => s.trim()).filter((s) => s.length > 12);
  const asks = Math.max(0, (text.match(/\?/g) ?? []).length - 1);
  const score = tokens.length + clauses.length * 2 + asks * 3 + (text.length > 160 ? 3 : 0) + (text.length > 280 ? 4 : 0);
  if (score <= 5) return { level: 'calme', slots: 1 };
  if (score <= 12) return { level: 'parle', slots: Math.min(3, Math.max(2, clauses.length || 2)) };
  return { level: 'dense', slots: Math.min(8, Math.max(4, clauses.length + asks)) };
}

const PLACE_OF: Record<ChartType, ChartPlace> = { kpi: 'signal', bar: 'gaze', line: 'gaze', pie: 'gaze', area: 'voice', table: 'voice' };
const VIEW_NAME: Record<ChartType, string> = { kpi: 'Mesure', bar: 'Répartition', line: 'Mouvement', area: 'Amplitude', pie: 'Parts', table: 'Détail' };

function viewsFor(sample: unknown, level: Density, room: number, alone: boolean): ChartType[] {
  const rows = shapeRows(sample);
  const rich = rows.length > 1;
  if (level === 'calme') return [rich ? (rows.length > 6 ? 'line' : 'bar') : 'kpi'];
  const n = Math.min(room, alone ? (level === 'dense' ? 4 : 2) : (level === 'dense' ? 2 : 1));
  const seq: ChartType[] = rich ? ['kpi', 'bar', 'line', 'table', 'area', 'pie'] : ['kpi', 'table'];
  return seq.slice(0, Math.max(1, n));
}

/** Découpe les sources retenues en éléments : une question courte, un élément ; une question dense, un visage chargé. */
export function faceCharts(prompt: string, picks: SourcePick[], samples: Map<string, unknown> = new Map()): ChartSpec[] {
  const { level, slots } = promptDensity(prompt);
  const charts: ChartSpec[] = [];
  picks.forEach((pick, index) => {
    const views = viewsFor(samples.get(pick.tool.id), level, slots - charts.length, picks.length === 1);
    const base = chartForSource(prompt, pick, samples.get(pick.tool.id), index);
    views.forEach((type, v) => {
      if (charts.length >= slots) return;
      const title = v === 0 ? base.title : `${VIEW_NAME[type]} · ${base.title}`.slice(0, 80);
      charts.push({ ...base, id: v === 0 ? base.id : `${base.id}-${type}`, type, title, place: PLACE_OF[type] });
    });
  });
  return charts.slice(0, slots);
}

export function titleRespects(title: string, prompt: string, tool: ToolLike) {
  const clean = title.replace(/\s+/g, ' ').trim();
  if (/\b(change|modifie|remplace|passe|ajoute|filtre)\b/i.test(prompt)) return (clean || tool.name || 'Graphique').slice(0, 80);
  const repo = repoRef(prompt);
  const withRepo = (t: string) => !repo || norm(t).includes(norm(repo.repo)) ? t.slice(0, 80) : `${t.slice(0, 54)} · ${repo.owner}/${repo.repo}`.slice(0, 80);
  const tokens = promptTokens(prompt);
  if (tokens.some((t) => norm(clean).includes(t))) return withRepo(clean);
  const q = questionTitle(prompt);
  const name = tool.name ?? tool.id.split('__').pop() ?? '';
  return withRepo(q.length <= 64 ? q : `${q.slice(0, 52)} · ${name}`);
}

export function chartForSource(prompt: string, pick: SourcePick, sample: unknown, index: number): ChartSpec {
  const rows = shapeRows(sample);
  const type: ChartType = rows.length <= 1 ? 'kpi' : rows.length > 6 ? 'line' : 'bar';
  const name = pick.tool.name ?? pick.tool.id.split('__').pop() ?? `vue-${index + 1}`;
  return {
    id: slug(String(pick.tool.id.split('__').pop() ?? name), index),
    title: titleRespects(pick.tool.description || name, prompt, pick.tool),
    type,
    tool: pick.tool.id,
    args: pick.args,
    x: 'label',
    y: 'value',
  };
}

export function answerSpec(prompt: string, charts: ChartSpec[]): DashboardSpec {
  const { level } = promptDensity(prompt);
  const title = questionTitle(prompt);
  const description = !charts.length
    ? `Aucune source branchée ne répond à « ${title} ».`
    : level === 'calme'
      ? `Un élément répond à « ${title} ».`
      : level === 'parle'
        ? `${charts.length} éléments répondent à « ${title} ».`
        : `${charts.length} éléments serrés répondent à « ${title} ».`;
  return { title, description, filters: [], density: level, charts };
}

export function fallbackSpec(prompt: string, tools: Array<{ id: string; description?: string; write?: boolean }>): DashboardSpec {
  const reads = tools.filter((t) => !t.write).slice(0, 4);
  const cycle: ChartType[] = ['kpi', 'bar', 'line', 'table'];
  const source = reads.length ? reads : [];
  const charts: ChartSpec[] = source.map((t, i) => ({
    id: slug(t.id.split('__').pop() ?? t.id, i),
    title: (t.description || t.id.split('__').pop() || 'Mesure').replace(/\s+/g, ' ').slice(0, 80),
    type: cycle[i % cycle.length],
    tool: t.id,
    args: {},
    x: 'label',
    y: 'value',
  }));
  return {
    title: questionTitle(prompt),
    description: 'Chaque source branchée apporte sa part. Les chiffres sont relus à l’ouverture.',
    filters: [],
    charts,
  };
}

/** Aplatit une réponse MCP en lignes que les graphiques shadcn savent dessiner. */
export function shapeRows(data: unknown, x = 'label', y = 'value'): Array<Record<string, string | number>> {
  const keys = ['rows', 'data', 'items', 'results', 'series', 'notes', 'previsions', 'alertes', 'commits', 'issues', 'points', 'values', 'pulls'] as const;
  const nested = data && typeof data === 'object' && !Array.isArray(data)
    ? keys.map((k) => (data as Record<string, unknown>)[k]).find(Array.isArray) as unknown[] | undefined
    : undefined;
  if (nested && !nested.length) return [];
  const list = Array.isArray(data) ? data : nested ?? (data && typeof data === 'object' ? [data] : [{ [y]: data }]);
  return list.slice(0, 200).map((row, i) => {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      const o = row as Record<string, unknown>;
      const label = o[x] ?? o.label ?? o.name ?? o.title ?? o.date ?? Object.values(o).find((v) => typeof v === 'string') ?? String(i + 1);
      const value = o[y] ?? o.value ?? o.count ?? o.total ?? Object.values(o).find((v) => typeof v === 'number') ?? 0;
      const flat: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(o)) flat[k] = typeof v === 'number' || typeof v === 'string' ? v : String(v ?? '');
      flat.label = typeof label === 'number' ? label : String(label);
      flat.value = typeof value === 'number' ? value : Number(value) || 0;
      return flat;
    }
    return { label: String(i + 1), value: typeof row === 'number' ? row : 0 };
  });
}
