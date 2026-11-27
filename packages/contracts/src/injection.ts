/**
 * Le contenu MCP, documentaire ou généré est de la DONNÉE. Il n'est jamais une instruction de contrôle.
 * On l'encapsule et on signale les motifs d'injection pour le journal (sans jamais leur obéir).
 */
const PATTERNS = [
  /ignore[sz]? (tes|les|vos|toutes les|all|previous|prior) (instructions|consignes)/i,
  /(system|developer) prompt/i,
  /tu es maintenant|you are now/i,
  /(appelle|call|execute|exécute)\s+[\w.-]+__?[\w-]+/i,
  /(envoie|send|exfiltr)\w* .*(token|secret|cl[ée]|password)/i,
];

export function detectInjection(text: string): string[] {
  return PATTERNS.filter((p) => p.test(text)).map((p) => p.source);
}

export function fenceUntrusted(label: string, text: string, max = 4000): string {
  const clipped = text.length > max ? text.slice(0, max) + '…[tronqué]' : text;
  return `<donnee_non_fiable source="${label.replace(/"/g, '')}">\n${clipped.replace(/<\/?donnee_non_fiable/gi, '‹balise›')}\n</donnee_non_fiable>`;
}
