import type { Aggregate } from './spec.js';
import { getPath, getCollection, parseTime, type ValueState } from './values.js';

export interface AggResult { state: ValueState | 'empty'; value: number | null; unit: string | null; count: number; skipped: number; reason?: string; label?: string }

function sameMonth(t: number, ref: number) {
  const a = new Date(t), b = new Date(ref);
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

export function filterRows(rows: unknown[], where: Aggregate['where'], refTime: number): unknown[] {
  return rows.filter((r) => where.every((w) => {
    const v = getPath(r, w.path);
    if (w.op === 'eq') return v === w.value;
    if (w.op === 'neq') return v !== w.value;
    const t = parseTime(v);
    return t !== null && sameMonth(t, refTime);
  }));
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
  if (present.length === 0) return { state: 'missing', value: null, unit, count: rows.length, skipped, reason: 'aucune mesure présente' };
  const sum = present.reduce((x, y) => x + y, 0);
  const state: ValueState = skipped > 0 ? 'partial' : 'available';
  if (a.agg === 'sum') return { state, value: round(sum), unit, count: rows.length, skipped };
  if (a.agg === 'avg') return { state, value: round(sum / present.length), unit, count: rows.length, skipped };
  // ratio : sommes sur les lignes où numérateur ET dénominateur sont présents
  const d = nums(a.den);
  let n = 0, dd = 0, used = 0;
  for (let i = 0; i < m.length; i++) if (m[i] !== null && d[i] !== null) { n += m[i]!; dd += d[i]!; used++; }
  if (used === 0 || dd === 0) return { state: 'invalid', value: null, unit, count: rows.length, skipped, reason: 'dénominateur nul ou absent' };
  return { state: used < m.length ? 'partial' : 'available', value: round(a.percent ? (n / dd) * 100 : n / dd), unit, count: rows.length, skipped: m.length - used };
}

export interface RankRow { label: string; value: number; count: number }
export function rank(raw: unknown, b: { collection: string; label: string; metric: string; den?: string; groupBy: boolean; agg: 'sum' | 'count' | 'ratio'; order: 'asc' | 'desc'; limit: number }): { rows: RankRow[]; total: number; partial: boolean } {
  const all = getCollection(raw, b.collection) ?? [];
  const groups = new Map<string, { n: number; d: number; c: number }>();
  for (const r of all) {
    const label = String(getPath(r, b.label) ?? '—');
    const key = b.groupBy ? label : `${label}#${groups.size}`;
    const g = groups.get(key) ?? { n: 0, d: 0, c: 0 };
    const mv = getPath(r, b.metric); const dv = b.den ? getPath(r, b.den) : undefined;
    if (b.agg === 'count') g.n += 1;
    else if (typeof mv === 'number' && (b.agg !== 'ratio' || typeof dv === 'number')) { g.n += mv; if (typeof dv === 'number') g.d += dv; }
    g.c += 1; groups.set(key, g);
  }
  const rows: RankRow[] = [];
  for (const [k, g] of groups) {
    const label = b.groupBy ? k : k.replace(/#\d+$/, '');
    if (b.agg === 'ratio') { if (g.d > 0) rows.push({ label, value: round(g.n / g.d), count: g.c }); }
    else rows.push({ label, value: round(g.n), count: g.c });
  }
  rows.sort((x, y) => (b.order === 'desc' ? y.value - x.value : x.value - y.value));
  return { rows: rows.slice(0, b.limit), total: rows.length, partial: false };
}

const round = (x: number) => Math.round(x * 100) / 100;
