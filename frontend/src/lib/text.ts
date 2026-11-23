/** Description d'outil MCP compacte : première phrase seulement (le texte complet reste au survol). */
export function shortDescription(d?: string | null, max = 120): string {
  const flat = String(d ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const m = flat.match(/^(.+?[.!?])(\s|$)/);
  const first = m ? m[1] : flat;
  return first.length > max ? first.slice(0, max - 1).trimEnd() + '…' : first;
}
