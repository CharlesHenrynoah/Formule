/** Trois essais, pas une boucle ouverte. */
export function withinBudget(attempt: number, max = 3): boolean {
  return attempt >= 0 && attempt < max;
}
