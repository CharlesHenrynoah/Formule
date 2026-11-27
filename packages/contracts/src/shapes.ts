import { getCollection, getPath, parseTime } from './values.js';

/** Calculs purs des graphiques « de forme » : regroupement, distribution, nuage, calendrier. Aucun null→0. */
export interface Group { label: string; value: number; count: number; members?: { label: string; value: number }[] }

export function groupAgg(raw: unknown, b: { collection: string; label: string; metric?: string; agg: 'sum' | 'count' | 'avg' | 'identity'; limit: number }): { groups: Group[]; others: Group | null; total: number; skipped: number } {
  const rows = getCollection(raw, b.collection) ?? [];
  const m = new Map<string, { s: number; n: number; c: number; first: number | null }>();
  let skipped = 0;
  for (const r of rows) {
    const lab = getPath(r, b.label);
    const label = lab === null || lab === undefined || lab === '' ? '(non renseigné)' : String(lab);
    const g = m.get(label) ?? { s: 0, n: 0, c: 0, first: null };
    g.c++;
    if (b.agg !== 'count') {
      const v = b.metric ? getPath(r, b.metric) : undefined;
      if (typeof v === 'number' && Number.isFinite(v)) { g.s += v; g.n++; if (g.first === null) g.first = v; }
      else skipped++;
    }
    m.set(label, g);
  }
  const all = [...m.entries()].map(([label, g]) => {
    // identity : une valeur brute par entité — jamais une somme artificielle.
    if (b.agg === 'identity') return { label, count: g.c, value: g.c === 1 && g.first !== null ? g.first : NaN };
    return { label, count: g.c, value: b.agg === 'count' ? g.c : b.agg === 'sum' ? r2(g.s) : g.n ? r2(g.s / g.n) : NaN };
  }).filter((g) => !Number.isNaN(g.value)).sort((a, c) => c.value - a.value || a.label.localeCompare(c.label));
  const groups = all.slice(0, b.limit);
  const rest = all.slice(b.limit);
  const others = rest.length && b.agg !== 'avg' && b.agg !== 'identity' ? { label: `Autres (${rest.length})`, value: r2(rest.reduce((a, g) => a + g.value, 0)), count: rest.reduce((a, g) => a + g.count, 0), members: rest.map((g) => ({ label: g.label, value: g.value })) } : null;
  return { groups, others, total: b.agg === 'identity' ? groups.length : r2(all.reduce((a, g) => a + g.value, 0)), skipped };
}

export function histogram(raw: unknown, b: { collection: string; v: string; bins: number }): { bins: { from: number; to: number; n: number }[]; n: number; missing: number; min: number | null; max: number | null; median: number | null } {
  const rows = getCollection(raw, b.collection) ?? [];
  const xs: number[] = []; let missing = 0;
  for (const r of rows) { const v = getPath(r, b.v); if (typeof v === 'number' && Number.isFinite(v)) xs.push(v); else missing++; }
  if (!xs.length) return { bins: [], n: 0, missing, min: null, max: null, median: null };
  xs.sort((a, c) => a - c);
  const min = xs[0], max = xs[xs.length - 1]; const k = Math.max(1, Math.min(b.bins, xs.length));
  const w = (max - min) / k || 1;
  const bins = Array.from({ length: k }, (_, i) => ({ from: r2(min + i * w), to: r2(min + (i + 1) * w), n: 0 }));
  for (const x of xs) bins[Math.min(k - 1, Math.floor((x - min) / w))].n++;
  return { bins, n: xs.length, missing, min, max, median: xs[Math.floor(xs.length / 2)] };
}

export function scatter(raw: unknown, b: { collection: string; x: string; y: string; color?: string }): { pts: { x: number; y: number; c: string | null }[]; dropped: number } {
  const rows = getCollection(raw, b.collection) ?? [];
  const pts: { x: number; y: number; c: string | null }[] = []; let dropped = 0;
  for (const r of rows) {
    const x = getPath(r, b.x), y = getPath(r, b.y);
    if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) pts.push({ x, y, c: b.color ? String(getPath(r, b.color) ?? '') || null : null });
    else dropped++;
  }
  return { pts, dropped };
}

/** Agrégation quotidienne (jour UTC). Un jour sans mesure n'existe pas dans le résultat : c'est un trou. */
export function daily(raw: unknown, b: { collection: string; t: string; v: string; agg: 'sum' | 'avg' }): { days: { day: string; t: number; v: number }[]; invalid: number } {
  const rows = getCollection(raw, b.collection) ?? [];
  const m = new Map<string, { s: number; n: number }>(); let invalid = 0;
  for (const r of rows) {
    const t = parseTime(getPath(r, b.t)); const v = getPath(r, b.v);
    if (t === null || typeof v !== 'number' || !Number.isFinite(v)) { invalid++; continue; }
    const day = new Date(t).toISOString().slice(0, 10);
    const g = m.get(day) ?? { s: 0, n: 0 }; g.s += v; g.n++; m.set(day, g);
  }
  const days = [...m.entries()].map(([day, g]) => ({ day, t: Date.parse(day), v: r2(b.agg === 'sum' ? g.s : g.s / g.n) })).sort((a, c) => a.t - c.t);
  return { days, invalid };
}

const r2 = (x: number) => Math.round(x * 100) / 100;
