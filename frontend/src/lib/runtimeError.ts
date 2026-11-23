/**
 * Erreurs d'exécution des mini-apps (iframe) : dé-minification des erreurs React de production et
 * ordre de correction envoyé au contremaître (« Demander au contremaître de corriger »).
 */
export type RuntimeError = { message: string; explained: string; panel?: string; componentStack?: string };

const HINT: Record<string, string> = {
  '130': "un composant utilisé dans le JSX vaut undefined (icône lucide inexistante, export nommé/par défaut inversé, sous-composant non exporté ou propriété mal nommée comme <p.Icon /> au lieu de <p.icon />)",
  '31': 'un objet est rendu directement dans le JSX',
  '185': 'boucle infinie de mises à jour (setState dans un effet sans condition)',
  '301': 'trop de rendus (setState pendant le rendu)',
  '300': 'hooks appelés conditionnellement',
  '310': 'hooks appelés conditionnellement',
  '321': "hook appelé hors d'un composant",
};

/** « Uncaught Error: Minified React error #130; visit https://react.dev/errors/130?args[]=undefined&args[]= … » → texte lisible. */
export function explainRuntimeError(message: string): string {
  const raw = String(message ?? '').replace(/^Uncaught\s+/, '');
  const m = /Minified React error #(\d+)(?:;\s*visit\s+(\S+))?/.exec(raw);
  if (!m) return raw;
  let args: string[] = [];
  try { args = m[2] ? new URL(m[2]).searchParams.getAll('args[]').filter(Boolean) : []; } catch { /* URL tronquée */ }
  return `React #${m[1]} : ${HINT[m[1]] ?? 'erreur React'}${args.length ? ` (reçu : ${args.join(', ')})` : ''}`;
}

/** Normalise le message `app:error` posté par l'iframe (bridge window.onerror ou error boundary du template). */
export function toRuntimeError(d: { message?: unknown; explained?: unknown; panel?: unknown; componentStack?: unknown }): RuntimeError {
  const message = String(d?.message ?? '').slice(0, 2000);
  const explained = typeof d?.explained === 'string' && d.explained ? d.explained.slice(0, 600) : explainRuntimeError(message);
  return { message, explained, panel: d?.panel ? String(d.panel).slice(0, 120) : undefined, componentStack: d?.componentStack ? String(d.componentStack).slice(0, 600) : undefined };
}

/** Ordre envoyé au contremaître pour qu'il fasse corriger l'erreur par l'équipe (evolve_app). */
export function fixOrder(e: RuntimeError): string {
  return [
    `Erreur d'exécution dans l'app${e.panel ? ` (panneau « ${e.panel} »)` : ''} : ${e.explained}`,
    e.componentStack ? `Composants : ${e.componentStack}` : '',
    e.message && e.message !== e.explained ? `Message brut : ${e.message.slice(0, 300)}` : '',
    "Corrige ce bug dans le code de l'app (evolve_app) sans rien changer d'autre.",
  ].filter(Boolean).join('\n');
}
