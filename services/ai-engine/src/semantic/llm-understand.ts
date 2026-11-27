import type { CatalogServer } from '../discovery/catalog.js';
import { draftAnalytical } from './analytical.js';
import type { Understanding } from './lexicon.js';

/**
 * Le modèle ne remplace plus le contrat. Il peut seulement compléter des mots de mesure vides.
 * Toutes les vues du runtime restent admissibles, et aucune exigence n'est coupée en silence.
 */
export async function refineUnderstanding(prompt: string, base: Understanding, catalog: CatalogServer[]): Promise<Understanding> {
  return draftAnalytical(prompt, base, catalog);
}
