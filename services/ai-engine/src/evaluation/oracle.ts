/**
 * Oracle indépendant : recalcule les valeurs attendues SANS utiliser le code du runtime (aggregate/rank).
 * Écrit séparément, volontairement naïf, pour détecter une erreur d'agrégation ou de liaison.
 */
import type { ViewSpec } from '@formule/contracts';

function dig(o: unknown, p: string): unknown {
  return p.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k.replace('[]', '')] : undefined), o);
}

/** Collection aplatie (« a[].b.c ») — implémentation indépendante de getCollection. */
function coll(raw: unknown, path: string): unknown[] {
  let cur: unknown[] = [raw];
  for (const seg of path.replace(/\[\]$/, '').split('[].')) cur = cur.flatMap((o) => { const v = dig(o, seg); return Array.isArray(v) ? v : []; });
  return cur;
}

export type Expectation =
  | { viewId: string; kind: 'kpi'; value: string }
  | { viewId: string; kind: 'line'; points: number }
  | { viewId: string; kind: 'table'; rows: number }
  | { viewId: string; kind: 'ranking'; first: string }
  | { viewId: string; kind: 'count'; count: number }
  | { viewId: string; kind: 'present' };

export function expectations(views: ViewSpec[], raws: Record<string, unknown>, refTimes: Record<string, number>): Expectation[] {
  const out: Expectation[] = [];
  for (const v of views) {
    if (v.kind === 'note') continue;
    const raw = raws[v.queryId];
    if (raw == null) continue;
    if (v.kind === 'kpi') {
      if (v.bindings.value) { const x = dig(raw, v.bindings.value); out.push({ viewId: v.id, kind: 'kpi', value: typeof x === 'number' && isFinite(x) ? String(x) : '' }); continue; }
      const a = v.bindings.aggregate!;
      const rows = coll(raw, a.collection);
      const ref = new Date(refTimes[v.queryId]);
      const kept = rows.filter((r) => a.where.every((w) => keep(dig(r, w.path), w, ref)));
      let value = '';
      if (a.agg === 'top') {
        let best = -Infinity; let lab: string | null = null;
        for (const r of kept) { const x = a.measure ? dig(r, a.measure) : undefined; if (typeof x === 'number' && isFinite(x) && x > best) { best = x; const l = a.labelPath ? dig(r, a.labelPath) : undefined; lab = l === undefined || l === null ? null : String(l); } }
        out.push({ viewId: v.id, kind: 'kpi', value: lab ?? '' }); continue;
      }
      if (a.agg === 'count') value = String(kept.length);
      else if (kept.length) {
        const units = new Set(a.unitPath ? kept.map((r) => dig(r, a.unitPath!)).filter((u) => typeof u === 'string') : []);
        if (units.size <= 1) {
          const num = (r: unknown, p?: string) => { const x = p ? dig(r, p) : undefined; return typeof x === 'number' && isFinite(x) ? x : null; };
          if (a.agg === 'sum' && a.measure && /(prix|price|cours|taux|rate|pct|ratio|moyenne|avg|mean|temp|variation|change|probabilit|score|rang|rank|humid|%)/.test(a.measure.toLowerCase())) value = '';
          else if (a.agg === 'ratio' && !a.measure && !a.den) {
            const denN = a.denWhere ? rows.filter((r) => a.denWhere!.every((w) => keep(dig(r, w.path), w, ref))).length : kept.length;
            if (denN) value = String(Math.round(((a.percent ? kept.length / denN * 100 : kept.length / denN)) * 100) / 100);
          } else if (a.agg === 'ratio' && a.measure && !a.den && a.denWhere) {
            if (/(prix|price|cours|taux|rate|pct|ratio|moyenne|avg|mean|temp|variation|change|probabilit|score|rang|rank|humid|%)/.test(a.measure.toLowerCase())) value = '';
            else {
              const denRows = rows.filter((r) => a.denWhere!.every((w) => keep(dig(r, w.path), w, ref)));
              let n = 0, d = 0;
              for (const r of kept) { const x = num(r, a.measure); if (x !== null) n += x; }
              for (const r of denRows) { const x = num(r, a.measure); if (x !== null) d += x; }
              if (d) value = String(Math.round((a.percent ? (n / d) * 100 : n / d) * 100) / 100);
            }
          } else if (a.agg === 'ratio') {
            let n = 0, d = 0, used = 0;
            for (const r of kept) { const x = num(r, a.measure), y = num(r, a.den); if (x !== null && y !== null) { n += x; d += y; used++; } }
            if (used && d) value = String(Math.round((a.percent ? (n / d) * 100 : n / d) * 100) / 100);
          } else if (a.agg === 'last') { const x = num(kept[kept.length - 1], a.measure); value = x === null ? '' : String(x); }
          else if (a.agg === 'identity') {
            if (kept.length === 1) { const x = num(kept[0], a.measure); value = x === null ? '' : String(x); }
            else value = '';
          } else {
            const xs = kept.map((r) => num(r, a.measure)).filter((x): x is number => x !== null);
            if (xs.length) { let s = 0; for (const x of xs) s += x; value = String(Math.round((a.agg === 'avg' ? s / xs.length : s) * 100) / 100); }
          }
        }
      }
      out.push({ viewId: v.id, kind: 'kpi', value });
    } else if (v.kind === 'line') {
      const rows = coll(raw, v.bindings.collection);
      const valid = rows.filter((r) => { const t = dig(r, v.bindings.t); return typeof t === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t) && !isNaN(Date.parse(t)); });
      out.push({ viewId: v.id, kind: 'line', points: valid.length });
    } else if (v.kind === 'table') {
      out.push({ viewId: v.id, kind: 'table', rows: coll(raw, v.bindings.collection).filter((r) => (v.bindings.where ?? []).every((w) => keep(dig(r, w.path), w, new Date(refTimes[v.queryId])))).length });
    } else if (v.kind === 'ranking') {
      const b = v.bindings;
      const rows = coll(raw, b.collection);
      const acc: Record<string, { n: number; d: number }> = {};
      const order: string[] = [];
      rows.forEach((r, i) => {
        const lab = String(dig(r, b.label) ?? '—');
        const k = b.groupBy ? lab : `${lab}#${i}`;
        if (!acc[k]) { acc[k] = { n: 0, d: 0 }; order.push(k); }
        const m = dig(r, b.metric), d = b.den ? dig(r, b.den) : undefined;
        if (b.agg === 'count') acc[k].n++;
        else if (typeof m === 'number' && (b.agg !== 'ratio' || typeof d === 'number')) { acc[k].n += m; if (typeof d === 'number') acc[k].d += d; }
      });
      const list = order.map((k) => ({ label: b.groupBy ? k : k.replace(/#\d+$/, ''), value: b.agg === 'ratio' ? (acc[k].d > 0 ? acc[k].n / acc[k].d : NaN) : acc[k].n }))
        .filter((x) => !isNaN(x.value)).map((x) => ({ ...x, value: Math.round(x.value * 100) / 100 }));
      list.sort((x, y) => (b.order === 'desc' ? y.value - x.value : x.value - y.value));
      out.push({ viewId: v.id, kind: 'ranking', first: list[0] ? `${list[0].label}=${list[0].value}` : '' });
    } else if (v.kind === 'bars' || v.kind === 'donut') {
      const b = v.bindings; const rows = coll(raw, b.collection).filter((r) => (b.where ?? []).every((w) => keep(dig(r, w.path), w, new Date(refTimes[v.queryId]))));
      const acc: Record<string, { s: number; n: number; c: number; first: number | null }> = {};
      for (const r of rows) {
        const l = dig(r, b.label); const k = l === null || l === undefined || l === '' ? '(non renseigné)' : String(l);
        acc[k] ??= { s: 0, n: 0, c: 0, first: null }; acc[k].c++;
        const m = b.metric ? dig(r, b.metric) : undefined;
        if (typeof m === 'number' && isFinite(m)) { acc[k].s += m; acc[k].n++; if (acc[k].first === null) acc[k].first = m; }
      }
      const list = Object.entries(acc).map(([label, g]) => ({
        label,
        value: b.agg === 'count' ? g.c : b.agg === 'identity' ? (g.c === 1 && g.first !== null ? g.first : NaN) : b.agg === 'sum' ? Math.round(g.s * 100) / 100 : g.n ? Math.round((g.s / g.n) * 100) / 100 : NaN,
      })).filter((x) => !isNaN(x.value)).sort((a, c) => c.value - a.value || a.label.localeCompare(c.label));
      out.push({ viewId: v.id, kind: 'ranking', first: list[0] ? `${list[0].label}=${list[0].value}` : '' });
    } else if (v.kind === 'histogram') {
      const rows = coll(raw, v.bindings.collection);
      out.push({ viewId: v.id, kind: 'count', count: rows.filter((r) => { const x = dig(r, v.bindings.v); return typeof x === 'number' && isFinite(x); }).length });
    } else if (v.kind === 'scatter') {
      const rows = coll(raw, v.bindings.collection);
      out.push({ viewId: v.id, kind: 'count', count: rows.filter((r) => [dig(r, v.bindings.x), dig(r, v.bindings.y)].every((x) => typeof x === 'number' && isFinite(x as number))).length });
    } else if (v.kind === 'heatmap') {
      const rows = coll(raw, v.bindings.collection);
      const days = new Set<string>();
      for (const r of rows) { const t = dig(r, v.bindings.t); const x = dig(r, v.bindings.v); if (typeof t === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t) && !isNaN(Date.parse(t)) && typeof x === 'number' && isFinite(x)) days.add(new Date(Date.parse(t)).toISOString().slice(0, 10)); }
      out.push({ viewId: v.id, kind: 'count', count: days.size });
    } else out.push({ viewId: v.id, kind: 'present' });
  }
  return out;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function keep(v: unknown, w: { op: string; value?: string | number | (string | number)[] }, ref: Date): boolean {
  if (w.op === 'eq') return v === w.value || (asNumber(v) !== null && asNumber(v) === asNumber(w.value));
  if (w.op === 'neq') return v !== w.value;
  if (w.op === 'in') {
    const list = Array.isArray(w.value) ? w.value : w.value === undefined ? [] : [w.value];
    return list.some((x) => x === v || (asNumber(v) !== null && asNumber(v) === asNumber(x)));
  }
  if (w.op === 'between') {
    const span = Array.isArray(w.value) ? w.value : [];
    const n = asNumber(v), lo = asNumber(span[0]), hi = asNumber(span[1]);
    return n !== null && lo !== null && hi !== null && n >= lo && n <= hi;
  }
  if (w.op === 'gt' || w.op === 'lt' || w.op === 'gte' || w.op === 'lte') {
    const n = asNumber(v), t = asNumber(w.value);
    if (n === null || t === null) return false;
    return w.op === 'gt' ? n > t : w.op === 'lt' ? n < t : w.op === 'gte' ? n >= t : n <= t;
  }
  if (typeof v !== 'string') return false;
  const d = new Date(v);
  return !isNaN(+d) && d.getUTCFullYear() === ref.getUTCFullYear() && d.getUTCMonth() === ref.getUTCMonth();
}

function sameValue(a: unknown, b: unknown) {
  if (a === b) return true;
  if (asNumber(a) !== null && asNumber(a) === asNumber(b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  return String(a) === String(b);
}

/** Refuse toute divergence avec le contrat d'origine jusqu'à la certification. */
export function contradicts(
  req: {
    view: string; visualization?: string; agg?: string; operation?: string;
    where?: { field?: string[]; path?: string; op: string; value?: unknown }[];
    filters?: { field?: string[]; path?: string; op: string; value?: unknown }[];
    percent?: boolean; limit?: number; order?: string; entities?: string[];
    population?: string; period?: string; grain?: string; unit?: string; columns?: string[];
  },
  view: {
    kind: string;
    bindings?: Record<string, unknown> & {
      aggregate?: { agg?: string; where?: { path: string; op: string; value?: unknown }[]; percent?: boolean; unitPath?: string; measure?: string };
      limit?: number; order?: string; population?: string; unit?: string | null; columns?: { path: string; label?: string }[];
      label?: string; metric?: string; agg?: string; where?: { path: string; op: string; value?: unknown }[];
    };
  } | undefined,
): string | null {
  if (!view) return `vue « ${req.visualization ?? req.view} » absente`;
  const wantView = req.visualization ?? req.view;
  if (view.kind !== wantView) return `vue « ${view.kind} » au lieu de « ${wantView} »`;

  const wantOp = req.operation ?? req.agg;
  const gotOp = view.bindings?.aggregate?.agg ?? (typeof view.bindings?.agg === 'string' ? view.bindings.agg : undefined);
  if (wantOp && gotOp && gotOp !== wantOp) return `opération « ${gotOp} » au lieu de « ${wantOp} »`;
  if (wantOp === 'identity' && gotOp && gotOp !== 'identity') return `identité remplacée par « ${gotOp} »`;

  const wantFilters = req.filters ?? req.where ?? [];
  const gotFilters = view.bindings?.aggregate?.where ?? view.bindings?.where ?? [];
  if (['kpi','table','bars','donut'].includes(view.kind)) {
    for (const w of wantFilters) {
      const hit = gotFilters.find((g) => g.op === w.op && (w.value === undefined || sameValue(g.value, w.value)) && (w.path ? g.path === w.path : !w.field?.length || w.field.some((f) => g.path.toLowerCase().includes(f.toLowerCase()))));
      if (!hit) return `filtre « ${w.op}${w.value !== undefined ? `=${JSON.stringify(w.value)}` : ''} » absent ou altéré`;
    }
  }

  if (req.percent && view.bindings?.aggregate && view.bindings.aggregate.percent !== true) return 'pourcentage exigé absent';
  if (req.limit != null && view.bindings?.limit != null && view.bindings.limit !== req.limit) return `limite ${view.bindings.limit} au lieu de ${req.limit}`;
  if (req.order && view.bindings?.order && view.bindings.order !== req.order) return `ordre « ${view.bindings.order} » au lieu de « ${req.order} »`;
  if (req.population && view.bindings?.population && !String(view.bindings.population).toLowerCase().includes(req.population.split(/\s+/)[0]?.toLowerCase() ?? '')) {
    return `population « ${view.bindings.population} » au lieu de « ${req.population} »`;
  }
  if (req.unit && view.bindings?.unit != null && view.bindings.unit !== null) {
    const u = String(view.bindings.unit).toLowerCase();
    if (!u.includes(req.unit.toLowerCase()) && !req.unit.toLowerCase().includes(u)) return `unité « ${view.bindings.unit} » au lieu de « ${req.unit} »`;
  }
  if (req.columns?.length && view.kind === 'table' && Array.isArray(view.bindings?.columns)) {
    const paths = view.bindings.columns.flatMap((c) => [c.path.toLowerCase(), c.label?.toLowerCase() ?? c.path.toLowerCase()]);
    for (const col of req.columns) {
      if (!paths.some((p) => p.includes(col.toLowerCase()) || col.toLowerCase().includes(p.split('.').pop() ?? ''))) {
        return `colonne « ${col} » absente`;
      }
    }
  }
  return null;
}
