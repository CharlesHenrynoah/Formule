/**
 * Packs : connaissances optionnelles et éditables (JSON) qui s'ajoutent au cœur générique sans le modifier.
 *  - recipes / knownMissing : vocabulaire métier (exigences pré-écrites) ;
 *  - taxonomies : regroupements de valeurs pour les filtres de catégories ;
 *  - codeTemplates : gabarits relus pour les serveurs « code mode » ;
 *  - synonyms : vocabulaire supplémentaire pour la synthèse d'arguments.
 * Un pack ne s'active que si le catalogue RÉEL contient ses outils. Sources : <repo>/packs et $FORMULE_DATA_DIR/packs.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { dataDir, findRepoRoot } from '@formule/service-kit';
import type { CatalogServer } from './discovery/catalog.js';

const Param = z.object({
  dictionary: z.string().optional(), default: z.union([z.string(), z.number()]).optional(), pattern: z.string().optional(),
  numbers: z.array(z.object({ re: z.string(), mul: z.number().optional(), value: z.number().optional() })).optional(),
  min: z.number().optional(), max: z.number().optional(),
});
export const PackSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/), version: z.number().int(), description: z.string().max(400),
  appliesTo: z.object({ anyTool: z.array(z.string()).optional(), server: z.string().optional() }),
  recipes: z.array(z.object({ match: z.string(), title: z.string(), mission: z.string(), commands: z.array(z.string()).default([]), reqs: z.array(z.record(z.string(), z.unknown())) })).default([]),
  knownMissing: z.array(z.record(z.string(), z.unknown())).default([]),
  taxonomies: z.array(z.object({ fields: z.array(z.string()), groups: z.record(z.string(), z.array(z.string())) })).default([]),
  synonyms: z.array(z.object({ re: z.string(), tokens: z.array(z.string()) })).default([]),
  codeTemplates: z.object({
    tool: z.string(), argument: z.string(), boost: z.string().optional(),
    dictionaries: z.record(z.string(), z.record(z.string(), z.string())).default({}),
    params: z.record(z.string(), Param).default({}),
    templates: z.array(z.object({ name: z.string(), when: z.string().optional(), requires: z.array(z.string()).default([]), intent: z.string(), code: z.string().max(8000) })).min(1),
  }).optional(),
});
export type Pack = z.infer<typeof PackSchema>;

let cache: { at: number; packs: Pack[]; errors: string[] } | null = null;

export function loadPacks(): { packs: Pack[]; errors: string[] } {
  if (cache && Date.now() - cache.at < 5000) return cache;
  const dirs = [path.join(findRepoRoot(), 'packs'), path.join(dataDir(), 'packs'), ...(process.env.FORMULE_PACKS_DIR ? [process.env.FORMULE_PACKS_DIR] : [])];
  const packs: Pack[] = []; const errors: string[] = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith('.json'))) {
      try {
        const p = PackSchema.parse(JSON.parse(readFileSync(path.join(d, f), 'utf8')));
        if (process.env.FORMULE_PACKS_DISABLED?.split(',').includes(p.id)) continue;
        const i = packs.findIndex((x) => x.id === p.id); if (i >= 0) packs[i] = p; else packs.push(p);
      } catch (e) { errors.push(`${f} : ${(e as Error).message.slice(0, 160)}`); }
    }
  }
  cache = { at: Date.now(), packs, errors };
  return cache;
}

/** Packs dont les outils existent dans le catalogue réel (sans catalogue : aucun). */
export function activePacks(catalog?: CatalogServer[]): Pack[] {
  if (!catalog) return [];
  return loadPacks().packs.filter((p) => {
    const servers = catalog.filter((s) => s.status === 'connected' && (!p.appliesTo.server || new RegExp(p.appliesTo.server, 'i').test(`${s.serverId} ${s.name}`)));
    if (!servers.length) return false;
    return !p.appliesTo.anyTool?.length || servers.some((s) => s.tools.some((t) => p.appliesTo.anyTool!.includes(t.name)));
  });
}

export function taxonomyFor(fieldKey: string, catalog?: CatalogServer[]): Record<string, string[]> | null {
  for (const p of activePacks(catalog)) for (const t of p.taxonomies) if (t.fields.includes(fieldKey)) return t.groups;
  return null;
}
