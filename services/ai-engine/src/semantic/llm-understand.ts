import type { CatalogServer } from '../discovery/catalog.js';
import { draftAnalytical } from './analytical.js';
import type { Understanding } from './lexicon.js';

/**
 * Appel 1 hybride : interprétation sémantique + plan. Repli déterministe si mock / JSON invalide.
 */
export async function refineUnderstanding(prompt: string, base: Understanding, catalog: CatalogServer[]): Promise<Understanding> {
  const draft = await draftAnalytical(prompt, base, catalog);
  return draft.u;
}
