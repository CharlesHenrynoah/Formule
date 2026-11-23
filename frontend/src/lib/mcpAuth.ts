/** Aides (pures) du formulaire MCP : en-têtes personnalisés et détection des erreurs d'authentification. */

/** « Nom: valeur » par ligne → objet ; lignes vides et commentaires (#) ignorés. */
export function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i <= 0) throw new Error(`en-tête invalide (attendu « Nom: valeur ») : ${line.slice(0, 40)}`);
    const name = line.slice(0, i).trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name)) throw new Error(`nom d'en-tête invalide : ${name.slice(0, 40)}`);
    out[name] = line.slice(i + 1).trim();
  }
  return out;
}

/** Vrai si l'erreur du serveur indique une authentification manquante ou refusée. */
export const isAuthError = (msg?: string) => !!msg && /authentification|jeton refusé|\b401\b|unauthori[sz]ed/i.test(msg);
