import type { Aggregate } from '@formule/contracts';

/** Toutes les vues que le runtime sait afficher. Le contrat analytique n'en retire aucune. */
export const VIEW_KINDS = ['kpi', 'line', 'table', 'ranking', 'simulation', 'bars', 'donut', 'histogram', 'scatter', 'heatmap', 'note'] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];
export const AGGS = ['sum', 'count', 'avg', 'last', 'ratio', 'top', 'identity'] as const;
export type FilterOp = 'eq' | 'neq' | 'current_month' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'between';
export interface ClauseFilter { field: string[]; op: FilterOp; value?: string | number | (string | number)[] }
export type OrderDir = 'asc' | 'desc';
import { activePacks } from '../packs.js';
import type { CatalogServer } from '../discovery/catalog.js';

/**
 * Exigences candidates. Chaque exigence décrit CE QU'IL FAUT PROUVER (outil, mesure, agrégation),
 * pas une valeur. La couverture est décidée plus tard, sur les lectures réelles.
 */
export interface ReqTemplate {
  id: string;
  label: string;
  mandatory: boolean;
  tool: string[];
  /** Visualisation demandée (alias explicite : visualization). */
  view: ViewKind;
  visualization?: ViewKind;
  measure?: string[];
  measures?: string[];
  den?: string[];
  time?: string[];
  label_?: string[];
  /** Opération demandée (alias explicite : operation). */
  agg?: Aggregate['agg'];
  operation?: Aggregate['agg'];
  where?: ClauseFilter[];
  filters?: ClauseFilter[];
  denWhere?: ClauseFilter[];
  groupBy?: boolean;
  percent?: boolean;
  series?: string[][];
  title: string;
  acceptance?: string;
  entities?: string[];
  population?: string;
  limit?: number;
  period?: string;
  grain?: string;
  dimensions?: string[];
  columns?: string[];
  order?: OrderDir;
  design?: string;
  section?: string;
  parentId?: string;
  unit?: string;
}

interface Recipe { match: RegExp; reqs: ReqTemplate[]; title: string; mission: string; commands: string[] }

/** Recettes et mesures « connues manquantes » : uniquement celles des packs ACTIFS (outils présents au catalogue). */
function packRecipes(catalog?: CatalogServer[]): { recipes: Recipe[]; missing: (ReqTemplate & { match: RegExp })[] } {
  const recipes: Recipe[] = []; const missing: (ReqTemplate & { match: RegExp })[] = [];
  for (const p of activePacks(catalog)) {
    for (const r of p.recipes) recipes.push({ match: new RegExp(r.match), title: r.title, mission: r.mission, commands: r.commands, reqs: r.reqs as unknown as ReqTemplate[] });
    for (const m of p.knownMissing) if (typeof m.match === 'string') missing.push({ ...(m as unknown as ReqTemplate), match: new RegExp(m.match) });
  }
  return { recipes, missing };
}

export const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export interface Understanding { title: string; mission: string; reqs: ReqTemplate[]; commands: string[]; simulation: boolean; generic: boolean }

export function understand(prompt: string, catalog?: CatalogServer[]): Understanding {
  const t = norm(prompt);
  const { recipes: all, missing } = packRecipes(catalog);
  const recipes = all.filter((r) => r.match.test(t));
  const reqs: ReqTemplate[] = [];
  for (const r of recipes) for (const q of r.reqs) if (!reqs.some((x) => x.id === q.id)) reqs.push(q); else reqs.push({ ...q, id: `${q.id}_${reqs.length}` });
  for (const m of missing) if (m.match.test(t)) { const { match: _m, ...req } = m; reqs.push(req); }
  const simulation = /(simul|scenario|projection|prevision|et si)/.test(t);
  return {
    title: recipes.length === 1 ? recipes[0].title : recipes.length ? recipes.map((r) => r.title).join(' · ').slice(0, 80) : titleFrom(prompt),
    mission: recipes.length ? recipes.map((r) => r.mission).join(' ') : prompt.slice(0, 300),
    reqs, commands: recipes.flatMap((r) => r.commands).slice(0, 4), simulation, generic: recipes.length === 0,
  };
}

export function titleFrom(prompt: string) {
  const s = prompt.replace(/^(cr[ée]e[rz]?|construis|fais|g[ée]n[èe]re|monte)( moi)?( une| un)?( interface| app(lication)?| console| tableau de bord)?( des| du| de la| de l['’]| de| d['’]| pour| qui)?\s*/i, '')
    .replace(/\s+(depuis|avec|à partir de)\s.*$/i, '').trim();
  return (s.charAt(0).toUpperCase() + s.slice(1)).slice(0, 60) || 'Interface';
}
