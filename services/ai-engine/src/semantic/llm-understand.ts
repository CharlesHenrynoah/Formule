import type { CatalogServer } from '../discovery/catalog.js';
import { draftAnalytical } from './analytical.js';
import type { Understanding } from './lexicon.js';

/**
 * AI-first : délègue au contrat LLM. Si l'interprétation échoue, renvoie la base inchangée
 * sans fabriquer un contrat syntaxique « équivalent ».
 */
export async function refineUnderstanding(prompt: string, base: Understanding, catalog: CatalogServer[]): Promise<Understanding> {
  const draft = await draftAnalytical(prompt, base, catalog);
  if (!draft.ok) return base;
  return draft.u;
}
