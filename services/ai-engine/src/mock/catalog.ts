import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f: string) => readFileSync(join(here, 'apps', f), 'utf8');

export type MockApp = { id: string; keywords: RegExp; plan: string; file: string; usesTools?: string[] };

export const MOCK_APPS: MockApp[] = [
  {
    id: 'meteo', keywords: /m[ée]t[ée]o|weather|temp[ée]rature|pr[ée]vision/i, file: 'meteo.html', usesTools: ['get_weather', 'add_note'],
    plan: `# Météo connectée aux outils MCP
- Champ de recherche de ville et bouton « Rechercher »
- Appel à l'exécution de l'outil MCP demo__get_weather via window.mcp.call
- Carte « maintenant » : température, condition, ressenti, humidité, vent
- Prévisions sur 5 jours sous forme de grille
- Bouton « Enregistrer en note » : outil MCP en écriture demo__add_note (confirmation utilisateur)
- Gestion des erreurs si le pont MCP est absent`,
  },
  {
    id: 'todo', keywords: /t[âa]che|todo|to-do|checklist|liste de choses/i, file: 'todo.html',
    plan: `# Liste de tâches
- Champ de saisie + bouton « Ajouter » (touche Entrée prise en charge)
- Cases à cocher pour marquer une tâche terminée, bouton de suppression
- Filtres : Toutes / À faire / Terminées
- Compteur de tâches restantes et « Supprimer les terminées »
- Persistance dans localStorage`,
  },
  {
    id: 'calculatrice', keywords: /calcul|calculatrice|calculator|addition/i, file: 'calculatrice.html',
    plan: `# Calculatrice
- Écran avec expression en cours et résultat en direct
- Pavé : chiffres, virgule, + − × ÷, %, C et retour arrière
- Support du clavier (Entrée, Échap, Retour arrière)
- Historique des derniers calculs
- Évaluation sécurisée (liste blanche de caractères)`,
  },
  {
    id: 'pomodoro', keywords: /pomodoro|minuteur|timer|chrono|compte [àa] rebours|focus/i, file: 'pomodoro.html',
    plan: `# Minuteur Pomodoro
- Trois modes : Focus 25 min, Pause 5 min, Longue pause 15 min
- Anneau de progression SVG et temps restant en grand
- Boutons Démarrer / Pause et Réinitialiser
- Bip sonore en fin de session et compteur de sessions
- Temps restant affiché dans le titre de l'onglet`,
  },
  {
    id: 'convertisseur', keywords: /convert|unit[ée]|conversion/i, file: 'convertisseur.html',
    plan: `# Convertisseur d'unités
- Catégories : Longueur, Masse, Volume, Vitesse, Température
- Valeur source + unité source, unité cible, conversion instantanée
- Bouton pour inverser les unités
- Formule lisible sous le résultat, format numérique français`,
  },
];

export function pickApp(prompt: string): MockApp | undefined {
  return MOCK_APPS.find((a) => a.keywords.test(prompt));
}

const esc = (s: string) => s.replace(/[&<>"{}]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '{': '&#123;', '}': '&#125;' })[c]!);

export function genericTitle(prompt: string) {
  const t = prompt.replace(/^(cr[ée]e|fais|g[ée]n[èe]re|construis|je veux)\s+(moi\s+)?(une?\s+)?(app(lication)?|outil|mini-app)?\s*(de|d'|pour)?\s*/i, '').trim();
  const s = t || prompt;
  return s.charAt(0).toUpperCase() + s.slice(1, 60);
}

export function appHtml(app: MockApp | undefined, prompt: string): string {
  if (app) return load(app.file);
  return load('generique.html').replaceAll('{{TITLE}}', esc(genericTitle(prompt))).replaceAll('{{PROMPT}}', esc(prompt.slice(0, 200)));
}

export function appPlan(app: MockApp | undefined, prompt: string): string {
  if (app) return app.plan;
  return `# ${genericTitle(prompt)}
- Interface sombre et responsive centrée sur la demande : « ${prompt.slice(0, 120)} »
- Zone de saisie multi-lignes pour ajouter des éléments
- Liste des éléments ajoutés et bouton pour vider
- Indicateurs : nombre d'éléments, de mots et d'actions
- (Mode démo : branchez un vrai LLM pour une app sur mesure)`;
}

const COLORS: Record<string, string> = {
  rouge: '#ef4444', vert: '#22c55e', bleu: '#3b82f6', orange: '#f97316', rose: '#ec4899', violet: '#8b5cf6', jaune: '#eab308', cyan: '#06b6d4',
};

/** Itération simulée : applique des modifications reconnues dans la consigne (apps shadcn/ui). */
export function applyIteration(code: string, instruction: string): { code: string; changes: string[] } {
  const changes: string[] = [];
  const css: string[] = [];
  const i = instruction.toLowerCase();
  let out = code;
  if (/clair|light|blanc/.test(i)) {
    out = out.replace(/<html([^>]*?)\sclass="([^"]*)"/i, (_m, a: string, c: string) => {
      const rest = c.split(/\s+/).filter((x) => x && x !== 'dark').join(' ');
      return `<html${a}${rest ? ` class="${rest}"` : ''}`;
    });
    css.push('/* thème clair : variables shadcn de :root */');
    changes.push('Thème clair');
  } else if (/sombre|dark|noir/.test(i) && !/<html[^>]*class="[^"]*\bdark\b/i.test(out)) {
    out = out.replace(/<html/i, '<html class="dark"');
    changes.push('Thème sombre');
  }
  for (const [name, hex] of Object.entries(COLORS)) {
    if (new RegExp(`\\b${name}`).test(i)) { css.push(`html:root, html.dark { --primary: ${hex}; --ring: ${hex}; --accent-color: ${hex}; }`); changes.push(`Couleur principale ${name}`); break; }
  }
  if (/plus grand|agrandi|gros|zoom/.test(i)) { css.push('body { zoom: 1.15; }'); changes.push('Interface agrandie'); }
  if (/arrondi|rond/.test(i)) { css.push("html:root, html.dark { --radius: 1.25rem; }"); changes.push('Coins plus arrondis'); }
  const title = /titre\s*(?:en|:|par|=)?\s*[«"']?\s*([^»"'{}<>]+)/i.exec(instruction)?.[1]?.trim();
  if (title) {
    out = out.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`);
    // Premier titre visible : <CardTitle …>…</CardTitle> ou <h1>…</h1> (on garde l'icône éventuelle)
    out = out.replace(/(<(CardTitle|h1)\b[^>]*>)((?:<[A-Z]\w*[^>]*\/>)?)[^<{]*(<\/\2>)/, `$1$3${title}$4`);
    changes.push(`Titre « ${title} »`);
  }
  if (css.length) out = out.replace(/<\/head>/i, `<style data-iteration>\n${css.join('\n')}\n</style>\n</head>`);
  if (!changes.length) {
    const note = instruction.replace(/[<>&{}]/g, '').slice(0, 140);
    out = out.replace(/<\/body>/i, `<div data-iteration style="position:fixed;bottom:10px;left:10px;background:#8b5cf6;color:#fff;padding:8px 12px;border-radius:10px;font:13px system-ui;max-width:60%">✏️ ${note}</div>\n</body>`);
    changes.push('Note de modification ajoutée (mode démo)');
  }
  return { code: out, changes };
}
