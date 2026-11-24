/** Page suivante. Le curseur vient de la réponse, pas d'un pas fixe inventé. */
export function nextPage(input: { items: unknown[]; next?: string | null }, cap: number): { done: boolean; cursor: string | null; take: number } {
  const take = Math.max(1, Math.min(cap, input.items.length || cap));
  if (!input.next) return { done: true, cursor: null, take };
  return { done: false, cursor: input.next, take };
}
