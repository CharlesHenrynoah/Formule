import { parseTime } from './values.js';

export interface Point { t: number; v: number | null }
export interface JoinedRow { t: number; values: Record<string, number | null> }

/** Extraction d'une série : l'horodatage garde sa précision native ; une absence reste un trou (null). */
export function toSeries(rows: unknown[], tKey: string, vKey: string, get: (o: unknown, p: string) => unknown): { points: Point[]; rejected: number } {
  const points: Point[] = [];
  let rejected = 0;
  for (const r of rows) {
    const t = parseTime(get(r, tKey));
    if (t === null) { rejected++; continue; }
    const raw = get(r, vKey);
    points.push({ t, v: typeof raw === 'number' && Number.isFinite(raw) ? raw : null });
  }
  points.sort((a, b) => a.t - b.t);
  return { points, rejected };
}

/** Jointure par timestamp normalisé, jamais par indice. Les absences restent null (pas de faux zéros). */
export function joinByTimestamp(series: Record<string, Point[]>): JoinedRow[] {
  const byT = new Map<number, JoinedRow>();
  const names = Object.keys(series);
  for (const name of names) {
    for (const p of series[name]) {
      let row = byT.get(p.t);
      if (!row) { row = { t: p.t, values: Object.fromEntries(names.map((n) => [n, null])) }; byT.set(p.t, row); }
      row.values[name] = p.v;
    }
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

/**
 * Rebase déterministe : premier point non nul → 100, les suivants en proportion.
 * Les trous (null) restent des trous. Base absente ou nulle → série inchangée côté appelant (retourne null).
 */
export function toBase100(points: Point[]): Point[] | null {
  const base = points.find((p) => p.v !== null && p.v !== 0)?.v;
  if (base == null || !Number.isFinite(base) || base === 0) return null;
  return points.map((p) => ({ t: p.t, v: p.v === null ? null : (p.v / base) * 100 }));
}

/** Détecte les intervalles anormalement longs (série irrégulière) sans rien combler. */
export function detectGaps(points: Point[], factor = 2.5): { from: number; to: number }[] {
  if (points.length < 3) return [];
  const steps = points.slice(1).map((p, i) => p.t - points[i].t).sort((a, b) => a - b);
  const median = steps[Math.floor(steps.length / 2)];
  const gaps: { from: number; to: number }[] = [];
  for (let i = 1; i < points.length; i++) if (points[i].t - points[i - 1].t > median * factor) gaps.push({ from: points[i - 1].t, to: points[i].t });
  return gaps;
}
