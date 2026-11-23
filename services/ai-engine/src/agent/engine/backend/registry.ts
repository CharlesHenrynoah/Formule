/**
 * Registre consulté avant chaque génération.
 * Les erreurs viennent du journal Formule : le backend MCP échouait plusieurs fois
 * avant d'être conforme. La solution retenue est un contrat d'opérations,
 * compilé en handlers synchrones, sur le modèle d'une surface d'outils fixe.
 */

export type ResolvedError = { error: string; cause: string; solution: string };

export const RESOLVED_ERRORS: ResolvedError[] = [
  { error: 'Backend 0/0 outils', cause: 'Export tools absent ou invalide', solution: 'compile_backend écrit export const tools' },
  { error: 'Backend 0/N outils', cause: 'Handlers reconnus mais invalides', solution: 'Handlers synchrones, une collection vide renvoie un total de 0' },
  { error: 'Écriture 0 bytes', cause: 'Fichier vide ou contenu non transmis', solution: 'Un backend vide est refusé avant l\'écriture' },
  { error: 'async/await interdit', cause: 'Handler non synchrone', solution: 'Le compilateur n\'émet pas async ni await' },
  { error: 'Données GitHub indisponibles', cause: 'Échantillonnage MCP échoué', solution: 'Collections et champs viennent du rapport de la liaison' },
];

export const EXAMPLE_CONTRACT = {
  name: 'get_issue_stats',
  kind: 'read',
  collection: 'issues',
  operation: 'aggregate',
  metric: 'count',
  filter: { state: 'open' },
} as const;

export function registryBrief(): string {
  const lines = RESOLVED_ERRORS.map((item) => `- ${item.error} : ${item.cause}. ${item.solution}.`);
  return [
    'Registre des contrats, lu avant d\'écrire le backend.',
    ...lines,
    `Opérations autorisées : list, get, aggregate, groupBy, sort, filter, simulate, insert.`,
    `Exemple : ${JSON.stringify(EXAMPLE_CONTRACT)}`,
    'compile_backend assemble server/tools.ts. write_file sur ce fichier seulement si la réponse contient besoin typescript.',
  ].join('\n');
}
