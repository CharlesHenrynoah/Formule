import type { Aggregate } from './spec.js';
import { getPath, getCollection, parseTime, type ValueState } from './values.js';

export interface AggResult { state: ValueState | 'empty'; value: number | null; unit: string | null; count: number; skipped: number; reason?: string; label?: string }

/** Mesures qu'on ne somme jamais (prix, taux, pourcentages, températures, rangs…). */
export const NON_ADDITIVE = /(prix|price|cours|taux|rate|pct|ratio|moyenne|avg|mean|temp|variation|change|probabilit|score|rang|rank|humid|%)/;

function sameMonth(t: number, ref: number) {
  const a = new Date(t), b = new Date(ref);
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function matches(v: unknown, w: Aggregate['where'][number], refTime: number): boolean {
  if (w.op === 'eq') return v === w.value || (asNumber(v) !== null && asNumber(v) === asNumber(w.value));
  if (w.op === 'neq') return v !== w.value;
  if (w.op === 'current_month') { const t = parseTime(v); return t !== null && sameMonth(t, refTime); }
  if (w.op === 'in') {
    const list = Array.isArray(w.value) ? w.value : w.value === undefined ? [] : [w.value];
    return list.some((x) => x === v || (asNumber(v) !== null && asNumber(v) === asNumber(x)));
  }
  if (w.op === 'between') {
    const span = Array.isArray(w.value) ? w.value : [];
    const n = asNumber(v), lo = asNumber(span[0]), hi = asNumber(span[1]);
    return n !== null && lo !== null && hi !== null && n >= lo && n <= hi;
  }
  const n = asNumber(v), t = asNumber(w.value);
  if (n === null || t === null) return false;
  if (w.op === 'gt') return n > t;
  if (w.op === 'lt') return n < t;
  if (w.op === 'gte') return n >= t;
  if (w.op === 'lte') return n <= t;
  return false;
}

export function filterRows(rows: unknown[], where: Aggregate['where'], refTime: number): unknown[] {
  return rows.filter((r) => where.every((w) => matches(getPath(r, w.path), w, refTime)));
}

/**
 * Agrégation pure et déclarée. Pas de fusion d'unités, pas de null→0,
 * une collection vide n'est pas un zéro observé (sauf count).
 */
export function aggregate(raw: unknown, a: Aggregate, unitFallback: string | null, refTime: number): AggResult {
  const all = getCollection(raw, a.collection);
  if (!all) return { state: 'inaccessible', value: null, unit: null, count: 0, skipped: 0, reason: 'collection absente' };
  const rows = filterRows(all, a.where ?? [], refTime);
  if (a.agg === 'count') return { state: 'available', value: rows.length, unit: null, count: rows.length, skipped: 0 };
  if (rows.length === 0) return { state: 'empty', value: null, unit: unitFallback, count: 0, skipped: 0, reason: 'aucune ligne' };
  const units = new Set<string>();
  if (a.unitPath) for (const r of rows) { const u = getPath(r, a.unitPath); if (typeof u === 'string') units.add(u); }
  if (units.size > 1) return { state: 'invalid', value: null, unit: null, count: rows.length, skipped: 0, reason: `unités multiples (${[...units].join(', ')}) : pas de fusion implicite` };
  const unit = a.percent ? '%' : units.size === 1 ? [...units][0] : unitFallback;
  const nums = (p: string | undefined) => rows.map((r) => (p ? getPath(r, p) : undefined)).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
  const m = nums(a.measure);
  const present = m.filter((x): x is number => x !== null);
  const skipped = m.length - present.length;
  if (a.agg === 'top') {
    // élément au maximum de la mesure : la valeur affichée est son libellé, la mesure reste en appui
    let best = -Infinity; let label: string | undefined;
    rows.forEach((r, i) => { const v = m[i]; if (v !== null && v > best) { best = v; const l = a.labelPath ? getPath(r, a.labelPath) : undefined; label = l === undefined || l === null ? undefined : String(l); } });
    return label === undefined ? { state: 'missing', value: null, unit, count: rows.length, skipped, reason: 'aucun libellé' } : { state: 'available', value: round(best), unit, count: rows.length, skipped, label };
  }
  if (a.agg === 'last') {
    const v = m[m.length - 1];
    return v === null ? { state: 'missing', value: null, unit, count: rows.length, skipped, reason: 'dernière valeur absente' } : { state: 'available', value: v, unit, count: rows.length, skipped };
  }
  if (a.agg === 'identity') {
    if (!a.measure) return { state: 'invalid', value: null, unit, count: rows.length, skipped: 0, reason: 'identité sans mesure' };
    if (rows.length === 0) return { state: 'empty', value: null, unit, count: 0, skipped: 0, reason: 'aucune ligne' };
    if (rows.length > 1) return { state: 'invalid', value: null, unit, count: rows.length, skipped: 0, reason: 'identité ambiguë : plusieurs entités, filtre requis' };
    const v = m[0];
    return v === null ? { state: 'missing', value: null, unit, count: 1, skipped: 1, reason: 'mesure absente' } : { state: 'available', value: v, unit, count: 1, skipped: 0 };
  }
  if (present.length === 0 && a.measure) return { state: 'missing', value: null, unit, count: rows.length, skipped, reason: 'aucune mesure présente' };
  const sum = present.reduce((x, y) => x + y, 0);
  const state: ValueState = skipped > 0 ? 'partial' : 'available';
  if (a.agg === 'sum' && a.measure && NON_ADDITIVE.test(a.measure.toLowerCase())) {
    return { state: 'invalid', value: null, unit, count: rows.length, skipped, reason: `somme interdite sur « ${a.measure} » : mesure non additive` };
  }
  if (a.agg === 'sum') return { state, value: round(sum), unit, count: rows.length, skipped };
  if (a.agg === 'avg') return { state, value: round(sum / present.length), unit, count: rows.length, skipped };
  const denRows = a.denWhere !== undefined ? filterRows(all, a.denWhere, refTime) : rows;
  if (!a.measure && !a.den) {
    if (!denRows.length) return { state: 'invalid', value: null, unit, count: rows.length, skipped: 0, reason: 'population de référence vide' };
    const ratio = rows.length / denRows.length;
    return { state: 'available', value: round(a.percent ? ratio * 100 : ratio), unit: a.percent ? '%' : null, count: rows.length, skipped: 0 };
  }
  // ratio : sommes sur les lignes où numérateur ET dénominateur sont présents, ou la même mesure sur deux populations
  if (a.measure && !a.den && a.denWhere !== undefined) {
    const num = present.reduce((x, y) => x + y, 0);
    const denVals = denRows.map((r) => getPath(r, a.measure!)).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const den = denVals.reduce((x, y) => x + y, 0);
    if (!denVals.length || den === 0) return { state: 'invalid', value: null, unit, count: rows.length, skipped, reason: 'dénominateur nul ou absent' };
    if (NON_ADDITIVE.test(a.measure.toLowerCase())) return { state: 'invalid', value: null, unit, count: rows.length, skipped, reason: `ratio de sommes interdit sur « ${a.measure} » : mesure non additive` };
    return { state: 'available', value: round(a.percent ? (num / den) * 100 : num / den), unit: a.percent ? '%' : unit, count: rows.length, skipped };
  }
  const d = nums(a.den);
  let n = 0, dd = 0, used = 0;
  for (let i = 0; i < m.length; i++) if (m[i] !== null && d[i] !== null) { n += m[i]!; dd += d[i]!; used++; }
  if (used === 0 || dd === 0) return { state: 'invalid', value: null, unit, count: rows.length, skipped, reason: 'dénominateur nul ou absent' };
  return { state: used < m.length ? 'partial' : 'available', value: round(a.percent ? (n / dd) * 100 : n / dd), unit, count: rows.length, skipped: m.length - used };
}

export interface RankRow { label: string; value: number; count: number }
/** Classement : SUM/COUNT/RATIO uniquement si déclarés. `identity` = valeur brute puis SORT/LIMIT (jamais une somme implicite). */
export function rank(raw: unknown, b: { collection: string; label: string; metric: string; den?: string; groupBy: boolean; agg: 'sum' | 'count' | 'ratio' | 'identity'; order: 'asc' | 'desc'; limit: number }): { rows: RankRow[]; total: number; partial: boolean } {
  const all = getCollection(raw, b.collection) ?? [];
  const groups = new Map<string, { n: number; d: number; c: number; first: number | null }>();
  for (const r of all) {
    const label = String(getPath(r, b.label) ?? '—');
    const key = b.groupBy ? label : `${label}#${groups.size}`;
    const g = groups.get(key) ?? { n: 0, d: 0, c: 0, first: null };
    const mv = getPath(r, b.metric); const dv = b.den ? getPath(r, b.den) : undefined;
    if (b.agg === 'count') g.n += 1;
    else if (b.agg === 'identity') {
      if (typeof mv === 'number' && Number.isFinite(mv) && g.first === null) { g.first = mv; g.n = mv; }
    } else if (typeof mv === 'number' && (b.agg !== 'ratio' || typeof dv === 'number')) { g.n += mv; if (typeof dv === 'number') g.d += dv; }
    g.c += 1; groups.set(key, g);
  }
  const rows: RankRow[] = [];
  for (const [k, g] of groups) {
    const label = b.groupBy ? k : k.replace(/#\d+$/, '');
    if (b.agg === 'ratio') { if (g.d > 0) rows.push({ label, value: round(g.n / g.d), count: g.c }); }
    else if (b.agg === 'identity') { if (g.first !== null) rows.push({ label, value: round(g.first), count: g.c }); }
    else rows.push({ label, value: round(g.n), count: g.c });
  }
  rows.sort((x, y) => (b.order === 'desc' ? y.value - x.value : x.value - y.value));
  return { rows: rows.slice(0, b.limit), total: rows.length, partial: false };
}

const round = (x: number) => Math.round(x * 100) / 100;
