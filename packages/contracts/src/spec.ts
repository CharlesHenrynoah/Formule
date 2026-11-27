import { z } from 'zod';

/**
 * Spécification d'application (contrat écrit AVANT le code).
 * Le modèle propose une spec ; elle est validée ici, puis compilée par le runtime.
 * Aucun code arbitraire du modèle n'est injecté dans le DOM.
 */
const FilterLite = z.object({
  field: z.array(z.string()).optional(),
  path: z.string().optional(),
  op: z.string(),
  value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]).optional(),
});
export const RequirementSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  label: z.string().min(1).max(120),
  mandatory: z.boolean(),
  status: z.enum(['covered', 'missing', 'unavailable']).default('missing'),
  reason: z.string().max(300).optional(),
  evidence: z.object({ envelopeId: z.string(), path: z.string(), viewId: z.string() }).nullable().optional(),
  // Contrat analytique conservé jusqu'à la certification.
  visualization: z.string().max(40).optional(),
  operation: z.string().max(40).optional(),
  filters: z.array(FilterLite).max(4).optional(),
  entities: z.array(z.string().max(80)).max(12).optional(),
  population: z.string().max(120).optional(),
  period: z.string().max(40).optional(),
  measureWindow: z.string().max(40).optional(),
  inputUnit: z.string().max(20).optional(),
  scopeSize: z.number().int().min(1).optional(),
  grain: z.string().max(20).optional(),
  columns: z.array(z.string().max(40)).max(12).optional(),
  unit: z.string().max(20).optional(),
  section: z.string().max(40).optional(),
  parentId: z.string().max(40).optional(),
  acceptance: z.string().max(300).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export const QuerySchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  serverId: z.string().min(1).max(60),
  tool: z.string().min(1).max(120),
  args: z.record(z.string(), z.unknown()).default({}),
  refresh: z.object({ mode: z.enum(['once', 'poll']), intervalSec: z.number().int().min(15).max(86400).optional() }).default({ mode: 'once' }),
  envelopeId: z.string().optional(),
  paginate: z.object({ cursorArg: z.string(), nextPath: z.string(), itemsPath: z.string(), maxPages: z.number().int().min(1).max(50) }).optional(),
});

// Les colonnes réelles contiennent des espaces, parenthèses, % ou / (« adjusted CO2 »). Pas de chevrons ni guillemets.
const Path = z.string().max(200).regex(/^[A-Za-z0-9_$\[\]. ()%/À-ſ-]*$/);

const Scalar = z.union([z.string().max(80), z.number()]);
const Where = z.object({
  path: Path,
  op: z.enum(['eq', 'neq', 'current_month', 'gt', 'lt', 'gte', 'lte', 'in', 'between']),
  value: z.union([Scalar, z.array(Scalar).min(1).max(12)]).optional(),
});
export const AggregateSchema = z.object({
  collection: Path, agg: z.enum(['sum', 'count', 'avg', 'last', 'ratio', 'top', 'identity']),
  labelPath: Path.optional(), // agg « top » : libellé de l'élément au maximum de la mesure
  measure: Path.optional(), den: Path.optional(), unitPath: Path.optional(), where: z.array(Where).max(4).default([]),
  denWhere: z.array(Where).max(4).optional(), // population du dénominateur, distincte du filtre du numérateur
  percent: z.boolean().default(false),
});
export type Aggregate = z.infer<typeof AggregateSchema>;

export const KpiView = z.object({
  kind: z.literal('kpi'), id: z.string(), title: z.string().max(80), queryId: z.string(),
  bindings: z.object({
    value: Path.optional(), aggregate: AggregateSchema.optional(),
    unit: z.string().max(20).nullable(), unitPath: Path.optional(), observedAt: Path.optional(),
    spark: z.object({ collection: Path, t: Path, v: Path }).optional(),
  }).refine((b) => !!b.value !== !!b.aggregate, 'value XOR aggregate'),
  requirementIds: z.array(z.string()).default([]),
  section: z.string().max(40).optional(),
});
export const LineView = z.object({
  kind: z.literal('line'), id: z.string(), title: z.string().max(80), queryId: z.string(),
  bindings: z.object({
    collection: Path, t: Path,
    series: z.array(z.object({ path: Path, label: z.string().max(40), unit: z.string().max(20).nullable() })).min(1).max(4),
    /** Transformation déclarative appliquée au rendu (jamais une substitution de mesure). */
    normalize: z.enum(['none', 'base100']).default('none'),
  }),
  requirementIds: z.array(z.string()).default([]),
  section: z.string().max(40).optional(),
});
export const TableView = z.object({
  kind: z.literal('table'), id: z.string(), title: z.string().max(80), queryId: z.string(),
  bindings: z.object({ collection: Path, where: z.array(Where).max(4).optional(), columns: z.array(z.object({ path: Path, label: z.string().max(40), unit: z.string().max(20).nullable(), type: z.enum(['number', 'string', 'time', 'boolean', 'link']) })).min(1).max(12),
    facets: z.object({ path: Path, groups: z.record(z.string(), z.array(z.string())).optional() }).optional() }),
  requirementIds: z.array(z.string()).default([]),
  section: z.string().max(40).optional(),
});
export const RankingView = z.object({
  kind: z.literal('ranking'), id: z.string(), title: z.string().max(80), queryId: z.string(),
  bindings: z.object({
    collection: Path, label: Path, metric: Path, den: Path.optional(), groupBy: z.boolean().default(false),
    agg: z.enum(['sum', 'count', 'ratio']).default('sum'), unit: z.string().max(20).nullable(), unitPath: Path.optional(),
    population: z.string().max(80), order: z.enum(['desc', 'asc']).default('desc'), limit: z.number().int().min(1).max(50).default(10),
  }),
  requirementIds: z.array(z.string()).default([]),
  section: z.string().max(40).optional(),
});
export const SimulationView = z.object({
  kind: z.literal('simulation'), id: z.string(), title: z.string().max(80), queryId: z.string(),
  bindings: z.object({ collection: Path, t: Path, v: Path, unit: z.string().max(20).nullable() }),
  model: z.object({
    name: z.literal('derive_lineaire'),
    params: z.array(z.object({ id: z.string(), label: z.string(), min: z.number(), max: z.number(), step: z.number(), default: z.number(), unit: z.string().max(10) })),
    assumptions: z.array(z.string().max(200)).min(1),
  }),
  requirementIds: z.array(z.string()).default([]),
  section: z.string().max(40).optional(),
});
export const NoteView = z.object({
  kind: z.literal('note'), id: z.string(), title: z.string().max(80), text: z.string().max(1000),
  requirementIds: z.array(z.string()).default([]),
  section: z.string().max(40).optional(),
});

const GroupBindings = z.object({ collection: Path, where: z.array(Where).max(4).optional(), label: Path, metric: Path.optional(), agg: z.enum(['sum', 'count', 'avg', 'identity']).default('count'), unit: z.string().max(20).nullable(), limit: z.number().int().min(2).max(24).default(8) });
export const BarsView = z.object({ kind: z.literal('bars'), id: z.string(), title: z.string().max(80), queryId: z.string(), bindings: GroupBindings, requirementIds: z.array(z.string()).default([]), section: z.string().max(40).optional() });
export const DonutView = z.object({ kind: z.literal('donut'), id: z.string(), title: z.string().max(80), queryId: z.string(), bindings: GroupBindings, requirementIds: z.array(z.string()).default([]), section: z.string().max(40).optional() });
export const HistogramView = z.object({
  kind: z.literal('histogram'), id: z.string(), title: z.string().max(80), queryId: z.string(),
  bindings: z.object({ collection: Path, v: Path, bins: z.number().int().min(4).max(40).default(16), unit: z.string().max(20).nullable() }),
  requirementIds: z.array(z.string()).default([]),
  section: z.string().max(40).optional(),
});
export const ScatterView = z.object({
  kind: z.literal('scatter'), id: z.string(), title: z.string().max(80), queryId: z.string(),
  bindings: z.object({ collection: Path, x: Path, y: Path, xLabel: z.string().max(40), yLabel: z.string().max(40), xUnit: z.string().max(20).nullable(), yUnit: z.string().max(20).nullable(), color: Path.optional() }),
  requirementIds: z.array(z.string()).default([]),
  section: z.string().max(40).optional(),
});
export const HeatmapView = z.object({
  kind: z.literal('heatmap'), id: z.string(), title: z.string().max(80), queryId: z.string(),
  bindings: z.object({ collection: Path, t: Path, v: Path, agg: z.enum(['sum', 'avg']).default('avg'), unit: z.string().max(20).nullable() }),
  requirementIds: z.array(z.string()).default([]),
  section: z.string().max(40).optional(),
});

export const ViewSchema = z.discriminatedUnion('kind', [KpiView, LineView, TableView, RankingView, SimulationView, NoteView, BarsView, DonutView, HistogramView, ScatterView, HeatmapView]);

export const ActionSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,40}$/),
  label: z.string().max(60),
  serverId: z.string(),
  tool: z.string(),
  effect: z.string().max(200),
  fields: z.array(z.object({
    name: z.string().regex(/^[a-z_][a-z0-9_]{0,40}$/), label: z.string().max(40),
    type: z.enum(['number', 'string', 'enum']), required: z.boolean(),
    min: z.number().optional(), max: z.number().optional(), options: z.array(z.string()).optional(), default: z.union([z.string(), z.number()]).optional(),
  })).max(8),
  fixedArgs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export const AppSpecSchema = z.object({
  specVersion: z.literal(1),
  title: z.string().min(1).max(80),
  mission: z.string().max(400),
  demo: z.boolean(),
  requirements: z.array(RequirementSchema).max(40),
  queries: z.array(QuerySchema).max(12),
  views: z.array(ViewSchema).max(28),
  actions: z.array(ActionSchema).max(6).default([]),
  commands: z.array(z.string().max(60)).max(6).default([]),
  style: z.object({
    density: z.enum(['compact', 'confortable']).default('confortable'),
    accent: z.enum(['bleu', 'vert', 'sable', 'violet', 'orange', 'rouge', 'cyan', 'mono']).default('mono'),
    font: z.enum(['system', 'mono']).default('system'),
    nav: z.enum(['top', 'sidebar']).default('top'),
    theme: z.enum(['noir', 'graphite']).default('noir'),
  }).default({ density: 'confortable', accent: 'mono', font: 'system', nav: 'top', theme: 'noir' }),
});

export type AppSpec = z.infer<typeof AppSpecSchema>;
export type ViewSpec = z.infer<typeof ViewSchema>;
export type QuerySpec = z.infer<typeof QuerySchema>;
export type ActionSpec = z.infer<typeof ActionSchema>;
export type Requirement = z.infer<typeof RequirementSchema>;

/** Données embarquées dans l'app : bruts liés aux requêtes + résumé d'enveloppe. */
export interface AppDataBundle {
  builtAt: string;
  queries: Record<string, { envelope: { id: string; status: string; observedAt: string | null; fetchedAt: string; coverage: { complete: boolean; pages: number; note?: string }; source: { serverName: string; demo: boolean }; hash: string | null }; raw: unknown }>;
  certification: { certified: boolean; message: string; label: 'certifiée' | 'partielle' | 'non certifiée' | 'aperçu' };
}

export { SERIES_COLORS, toolKey, splitToolKey } from './consts.js';
