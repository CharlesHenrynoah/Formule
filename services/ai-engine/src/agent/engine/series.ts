/**
 * Garantie sur les séries, pas une interprétation métier.
 * Deux colonnes [horodatage, mesure] se rejoignent par l'horodatage, pas par leur place dans le tableau.
 * Au-delà du plafond, on garde le début et la fin : la fenêtre temporelle reste entière.
 */

export function keepSpan<T>(rows: T[], cap: number): T[] {
  if (rows.length <= cap) return rows;
  const last = cap - 1;
  const step = (rows.length - 1) / last;
  const picked: T[] = [];
  for (let i = 0; i < cap; i++) picked.push(rows[Math.round(i * step)]!);
  return picked;
}

function markOf(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return `n:${value}`;
  return `s:${String(value ?? '')}`;
}

function shownDate(value: unknown): unknown {
  if (typeof value === 'number' && value > 1e11) return new Date(value).toISOString();
  return value;
}

/** Objet dont les valeurs sont des paires [x, mesure]. Null si ce n'est pas une série. */
export function alignPairSeries(data: unknown, cap = 240): Array<Record<string, unknown>> | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const series = Object.entries(data as Record<string, unknown>).filter((entry): entry is [string, unknown[][]] => {
    const value = entry[1];
    return Array.isArray(value) && Array.isArray(value[0]) && value[0].length >= 2 && typeof value[0][1] === 'number';
  });
  if (!series.length) return null;
  const byMark = new Map<string, { sort: number | null; seen: number; row: Record<string, unknown> }>();
  let seen = 0;
  for (const [key, points] of series) {
    for (const point of points) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const mark = markOf(point[0]);
      if (mark === 's:') continue;
      let slot = byMark.get(mark);
      if (!slot) {
        slot = { sort: typeof point[0] === 'number' ? point[0] : null, seen: seen++, row: { date: shownDate(point[0]) } };
        byMark.set(mark, slot);
      }
      slot.row[key] = point[1];
    }
  }
  const rows = [...byMark.values()]
    .sort((left, right) => {
      if (left.sort != null && right.sort != null) return left.sort - right.sort;
      return left.seen - right.seen;
    })
    .map((slot) => slot.row)
    .filter((row) => Object.keys(row).length > 1);
  if (!rows.length) return null;
  return keepSpan(rows, cap);
}
