/** Sources n8n et reprise de chantier : helpers purs (testés dans test/source.test.ts). */

/** Le pad appelle `<serveur>__execute_workflow` et l'app peut lire ses exécutions → le studio fait exécuter → attendre → ingérer. */
export function isSourceRefresh(toolId: string, whitelist: string[] = []) {
  const m = /^(.+)__execute_workflow$/.exec(toolId);
  return !!m && whitelist.includes(toolId) && whitelist.includes(`${m[1]}__get_workflow_execution`);
}

/** Marqueur posé par le contremaître quand son budget d'étapes est épuisé (voir runner.ts). */
export const PAUSE_MARK = '⏸️ Chantier en pause';
export const CONTINUE_ORDER = "Continue le chantier en pause là où tu t'es arrêté (ne refais pas les étapes déjà faites).";
export const isPaused = (text: unknown) => typeof text === 'string' && (text.includes(PAUSE_MARK) || /⛔ Limite de \d+ étapes atteinte/.test(text));
