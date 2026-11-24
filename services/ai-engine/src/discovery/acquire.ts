import { keepSpan } from '../agent/engine/series.ts';

/** Les lignes stockées et l'échantillon montré au modèle ne sont pas le même objet. */
export function splitAcquisition<T>(rows: T[], storedCap = 240, inferenceCap = 8): { stored: T[]; inference: T[] } {
  return { stored: keepSpan(rows, storedCap), inference: keepSpan(rows, inferenceCap) };
}
