/**
 * Dé-minification des erreurs React de production (« Minified React error #130; visit https://react.dev/errors/130?args[]=… »).
 * Les builds des mini-apps sont minifiés : on traduit le code en message lisible + piste de correction pour le Développeur.
 */
const MESSAGES: Record<string, string> = {
  '130': "Element type is invalid: expected a string (for built-in components) or a class/function (for composite components) but got: %s.%s",
  '152': '%s(...): Nothing was returned from render.',
  '185': 'Maximum update depth exceeded (setState en boucle dans un effet ou un rendu).',
  '300': 'Rendered fewer hooks than expected (hook appelé conditionnellement ou après un return anticipé).',
  '310': 'Rendered more hooks than during the previous render (hook appelé conditionnellement).',
  '31': 'Objects are not valid as a React child (found: %s). Rends une chaîne/un nombre, pas un objet.',
  '321': 'Invalid hook call (hook appelé hors d\'un composant React).',
  '418': "Hydration failed because the server rendered HTML didn't match the client.",
  '425': 'Text content does not match server-rendered HTML.',
  '423': 'There was an error while hydrating.',
  '301': 'Too many re-renders (setState appelé directement pendant le rendu).',
};
const HINTS: Record<string, string> = {
  '130': "Un composant utilisé dans le JSX vaut undefined : icône lucide-react inexistante, export nommé/par défaut inversé, sous-composant shadcn non exporté, ou propriété mal nommée (ex. <p.Icon /> alors que l'objet a `icon`). Vérifie chaque import et chaque <X.y />.",
  '31': "Un objet (ou une promesse) est rendu directement dans le JSX : affiche un champ (obj.label) ou JSON.stringify(obj).",
  '185': 'Un useEffect met à jour un état dont il dépend sans condition de sortie.',
  '301': 'Déplace le setState dans un gestionnaire ou un useEffect.',
  '300': 'Les hooks doivent être appelés au début du composant, sans condition.',
  '310': 'Les hooks doivent être appelés au début du composant, sans condition.',
};

export type DecodedReactError = { code: string; args: string[]; message: string; hint?: string };

/** Décode la première erreur React minifiée trouvée dans `text` (null si aucune). */
export function decodeReactError(text: string): DecodedReactError | null {
  const m = /Minified React error #(\d+)(?:;\s*visit\s+(\S+))?/.exec(String(text ?? ''));
  if (!m) return null;
  const code = m[1];
  const args: string[] = [];
  if (m[2]) {
    try {
      const u = new URL(m[2].replace(/[).,;]+$/, ''));
      for (const [k, v] of u.searchParams) if (k === 'args[]') args.push(v);
    } catch { /* URL tronquée */ }
  }
  let i = 0;
  const tpl = MESSAGES[code] ?? `Erreur React #${code} (voir https://react.dev/errors/${code}).`;
  const message = tpl.replace(/%s/g, () => args[i++] ?? '');
  return { code, args, message: message.trim(), hint: HINTS[code] };
}

/** Remplace l'erreur minifiée par sa version lisible (+ piste) ; laisse le texte intact sinon. */
export function explainError(text: string): string {
  const d = decodeReactError(text);
  if (!d) return String(text ?? '');
  return `React #${d.code} — ${d.message}${d.hint ? `\n→ ${d.hint}` : ''}`;
}
