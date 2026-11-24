/** L'âge se mesure depuis la récupération. Ce n'est pas la date de la mesure. */
export function freshness(fetchedAt: number, maxAgeMs: number, now = Date.now()): { age: number; stale: boolean } {
  const age = Math.max(0, now - fetchedAt);
  return { age, stale: age > maxAgeMs };
}
