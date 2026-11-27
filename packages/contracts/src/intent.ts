/** Classification déterministe des demandes (le LLM peut affiner, jamais élargir les droits).
 * La forme du prompt entier prime : un texte structuré (parties numérotées, puces, plusieurs phrases) est une construction.
 * Un ordre court, ou une suite d'ordres sans structure, reste un ordre. */
export type IntentClass = 'Ask' | 'Build' | 'Control' | 'Act' | 'Diagnose';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const SIGNALS = {
  diagnose: /\b(diagnostic|diagnostique|pourquoi .*(erreur|vide|marche)|ne marche pas|bug)\b/,
  act: /\b(achete|acheter|vends|vendre|passe (un )?ordre|envoie|supprime le|commande|execute l'action|mets? en pause|met en pause|reactive|desactive|change l'etape|passe l'affaire|archive la|annule la commande)\b/,
  control: /\b(affiche seulement|montre seulement|masque|cache|affiche|montre|focus|retire la vue|reaffiche)\b/,
  build: /\b(cree|creer|construis|construire|fais|genere|monte|application|app|tableau de bord|dashboard|console|interface|surveiller|suivre|ajoute|retire|renomme|change|couleur|graphique|simulation|simule|rends|compacte?|dense|aere)\b/,
} as const;

function shape(text: string) {
  const lines = text.split(/\n/).map((l) => l.replace(/\*\*/g, '').trim()).filter(Boolean);
  const items = lines.filter((l) => /^(?:[-•*]|\d{1,2}[.)])\s+\S/.test(l)).length;
  const parts = norm(text).split(/[.!?\n]+/).map((s) => s.trim()).filter((s) => s.length > 0);
  return { items, parts: parts.length ? parts : [norm(text)], structured: items >= 2, brief: parts.length >= 3 || text.trim().length > 280 };
}

export function classifyIntent(text: string, ctx: { projectOpen: boolean; mode: 'ask' | 'agent' }): IntentClass {
  const t = norm(text);
  const { parts, structured, brief } = shape(text);
  const score = { diagnose: 0, act: 0, control: 0, build: 0 };
  for (const part of parts) {
    if (SIGNALS.diagnose.test(part)) score.diagnose++;
    if (SIGNALS.act.test(part)) score.act++;
    if (SIGNALS.control.test(part)) score.control++;
    if (SIGNALS.build.test(part)) score.build++;
  }

  if (ctx.mode === 'ask') return !brief && !structured && score.diagnose > 0 && score.build === 0 ? 'Diagnose' : 'Ask';
  // Un cahier structuré, ou un brief qui n'est pas qu'une suite d'ordres, se construit.
  if (structured || (brief && score.act === 0)) return 'Build';
  if (!brief && score.act > score.build && score.act > 0) return 'Act';
  if (ctx.projectOpen && !brief && score.control > 0 && !/\b(ajoute|cree|creer|construis|genere)\b/.test(t)) return 'Control';
  if (score.build > 0 && score.build >= score.act) return 'Build';
  if (score.diagnose > 0 && score.diagnose >= score.build && score.diagnose >= score.act) return 'Diagnose';
  if (score.act > 0) return 'Act';
  if (ctx.projectOpen && score.control > 0 && score.build === 0) return 'Control';
  return 'Ask';
}

/** Une question simple ne crée pas d'application. */
export function isSimpleQuestion(text: string): boolean {
  const t = norm(text);
  return /\?\s*$/.test(t) || /^(quel|quelle|quels|combien|est-ce|c'est quoi|donne|dis)/.test(t);
}
