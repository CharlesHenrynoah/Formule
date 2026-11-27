/**
 * Couche de transformation déclarative.
 * Sépare : source → transforms → computed → visualisation.
 * L’IA émet un plan typé ; le moteur valide et exécute de façon déterministe.
 * Réutilise filterRows / aggregate / groupAgg / toBase100 / toSeries.
 */
import { z } from 'zod';
import { aggregate, filterRows, NON_ADDITIVE } from './aggregate.js';
import { groupAgg } from './shapes.js';
import { toBase100, toSeries, type Point } from './series.js';
import { getCollection, getPath } from './values.js';

const Path = z.string().max(200).regex(/^[A-Za-z0-9_$\[\]. ()%/À-ſ-]*$/);
const Scalar = z.union([z.string().max(80), z.number()]);
const Where = z.object({
  path: Path,
  op: z.enum(['eq', 'neq', 'current_month', 'gt', 'lt', 'gte', 'lte', 'in', 'between']),
  value: z.union([Scalar, z.array(Scalar).min(1).max(12)]).optional(),
});
export type TransformWhere = z.infer<typeof Where>;

export const TRANSFORM_OPS = [
  'FILTER', 'COUNT', 'SUM', 'AVG', 'RATIO', 'SORT', 'LIMIT', 'GROUP', 'JOIN', 'NORMALIZE',
] as const;
export type TransformOpName = (typeof TRANSFORM_OPS)[number];

export const TransformStepSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('FILTER'), where: z.array(Where).min(1).max(4) }),
  z.object({ op: z.literal('COUNT') }),
  z.object({ op: z.literal('SUM'), measure: Path }),
  z.object({ op: z.literal('AVG'), measure: Path }),
  z.object({
    op: z.literal('RATIO'),
    numeratorWhere: z.array(Where).max(4).optional(),
    denominatorWhere: z.array(Where).max(4).optional(),
    measure: Path.optional(),
    den: Path.optional(),
    percent: z.boolean().optional(),
  }),
  z.object({
    op: z.literal('SORT'),
    by: Path,
    order: z.enum(['asc', 'desc']).default('desc'),
  }),
  z.object({ op: z.literal('LIMIT'), n: z.number().int().min(1).max(50) }),
  z.object({
    op: z.literal('GROUP'),
    by: Path,
    agg: z.enum(['sum', 'count', 'avg', 'identity']).default('count'),
    measure: Path.optional(),
    limit: z.number().int().min(1).max(50).default(24),
  }),
  z.object({
    op: z.literal('JOIN'),
    leftKey: Path,
    rightCollection: Path,
    rightKey: Path,
    as: z.string().max(40).optional(),
  }),
  z.object({
    op: z.literal('NORMALIZE'),
    mode: z.enum(['base100']).default('base100'),
    t: Path.optional(),
    v: Path.optional(),
  }),
]);
export type TransformStep = z.infer<typeof TransformStepSchema>;

export const TransformPlanSchema = z.object({
  source: z.object({ collection: Path }),
  /** Au moins un opérateur : un plan vide n’est pas une transformation. */
  steps: z.array(TransformStepSchema).min(1).max(12),
});
export type TransformPlan = z.infer<typeof TransformPlanSchema>;

export type TransformResult =
  | { kind: 'rows'; rows: unknown[]; partial?: boolean }
  | { kind: 'scalar'; value: number | null; unit: string | null; count: number; state: string; reason?: string }
  | { kind: 'groups'; groups: { label: string; value: number; count: number }[]; total: number }
  | { kind: 'series'; points: Point[]; normalized: boolean };

export type ValidateTransformPlan =
  | { ok: true; plan: TransformPlan }
  | { ok: false; errors: string[] };

/** Validation structurelle + garde-fous (SUM non-additif, classement sans SUM implicite). */
export function validateTransformPlan(raw: unknown): ValidateTransformPlan {
  const parsed = TransformPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`) };
  }
  const plan = parsed.data;
  const errors: string[] = [];
  const ops = plan.steps.map((s) => s.op);

  for (const step of plan.steps) {
    if (step.op === 'SUM' && NON_ADDITIVE.test(step.measure.toLowerCase())) {
      errors.push(`SUM interdit sur mesure non additive « ${step.measure} » — utiliser SORT+LIMIT`);
    }
    if (step.op === 'SUM' && ops.includes('LIMIT') && !ops.includes('SORT') && !ops.includes('GROUP')) {
      errors.push('SUM+LIMIT sans SORT ni GROUP : classement ambigu — préférer SORT+LIMIT');
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, plan };
}

function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * Exécute un plan validé.
 * RATIO sans mesure = ratio de comptages (lignes courantes / population source).
 * Classement = SORT+LIMIT (pas de SUM implicite).
 */
export function executeTransformPlan(raw: unknown, plan: TransformPlan, refTime = Date.now()): TransformResult {
  const v = validateTransformPlan(plan);
  if (!v.ok) {
    return { kind: 'scalar', value: null, unit: null, count: 0, state: 'invalid', reason: v.errors[0] };
  }
  const parsed = v.plan;
  const sourceRows = [...(getCollection(raw, parsed.source.collection) ?? [])];
  let rows: unknown[] = [...sourceRows];
  let series: Point[] | null = null;

  for (const step of parsed.steps) {
    if (step.op === 'FILTER') {
      rows = filterRows(rows, step.where, refTime);
      continue;
    }
    if (step.op === 'COUNT') {
      return { kind: 'scalar', value: rows.length, unit: null, count: rows.length, state: 'available' };
    }
    if (step.op === 'SUM' || step.op === 'AVG') {
      if (NON_ADDITIVE.test(step.measure.toLowerCase()) && step.op === 'SUM') {
        return { kind: 'scalar', value: null, unit: null, count: rows.length, state: 'invalid', reason: `somme interdite sur « ${step.measure} »` };
      }
      const r = aggregate(
        { __t: rows },
        { collection: '__t', agg: step.op === 'SUM' ? 'sum' : 'avg', measure: step.measure, where: [], percent: false },
        null,
        refTime,
      );
      return { kind: 'scalar', value: r.value, unit: r.unit, count: r.count, state: r.state, reason: r.reason };
    }
    if (step.op === 'RATIO') {
      // Comptage conditionnel : numérateur = lignes courantes (± numeratorWhere), dénominateur = source (± denWhere).
      if (!step.measure && !step.den) {
        const numRows = step.numeratorWhere?.length ? filterRows(rows, step.numeratorWhere, refTime) : rows;
        const denRows = filterRows(sourceRows, step.denominatorWhere ?? [], refTime);
        if (!denRows.length) {
          return { kind: 'scalar', value: null, unit: null, count: 0, state: 'invalid', reason: 'population de référence vide' };
        }
        const ratio = numRows.length / denRows.length;
        const percent = step.percent !== false; // défaut % pour parts
        return {
          kind: 'scalar',
          value: Math.round((percent ? ratio * 100 : ratio) * 100) / 100,
          unit: percent ? '%' : null,
          count: numRows.length,
          state: 'available',
        };
      }
      const r = aggregate(
        { __t: rows },
        {
          collection: '__t',
          agg: 'ratio',
          measure: step.measure,
          den: step.den,
          where: step.numeratorWhere ?? [],
          denWhere: step.denominatorWhere ?? [],
          percent: step.percent !== false,
        },
        null,
        refTime,
      );
      return { kind: 'scalar', value: r.value, unit: r.unit, count: r.count, state: r.state, reason: r.reason };
    }
    if (step.op === 'SORT') {
      const order = step.order === 'asc' ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const av = asNum(getPath(a, step.by));
        const bv = asNum(getPath(b, step.by));
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        return (av - bv) * order;
      });
      continue;
    }
    if (step.op === 'LIMIT') {
      rows = rows.slice(0, step.n);
      continue;
    }
    if (step.op === 'GROUP') {
      const g = groupAgg(
        { __t: rows },
        {
          collection: '__t',
          label: step.by,
          metric: step.measure,
          agg: step.agg,
          limit: step.limit,
          refTime,
        },
      );
      return { kind: 'groups', groups: g.groups, total: g.total };
    }
    if (step.op === 'JOIN') {
      const right = getCollection(raw, step.rightCollection) ?? [];
      const byRight = new Map<string, unknown>();
      for (const r of right) {
        const k = getPath(r, step.rightKey);
        if (k !== null && k !== undefined) byRight.set(String(k), r);
      }
      const prefix = step.as ? `${step.as}.` : '';
      rows = rows.map((left) => {
        const k = getPath(left, step.leftKey);
        const hit = k === null || k === undefined ? undefined : byRight.get(String(k));
        if (!hit || typeof hit !== 'object') return left;
        const merged: Record<string, unknown> = { ...(left as Record<string, unknown>) };
        for (const [fk, fv] of Object.entries(hit as Record<string, unknown>)) {
          if (fk === step.rightKey) continue;
          merged[prefix + fk] = fv;
        }
        return merged;
      });
      continue;
    }
    if (step.op === 'NORMALIZE') {
      const tKey = step.t ?? 't';
      const vKey = step.v ?? '__value';
      const { points } = series ? { points: series } : toSeries(rows, tKey, vKey, getPath);
      const normalized = step.mode === 'base100' ? toBase100(points) : points;
      if (!normalized) return { kind: 'series', points, normalized: false };
      series = normalized;
      rows = normalized.map((p) => ({ [tKey]: new Date(p.t).toISOString(), [vKey]: p.v }));
      continue;
    }
  }

  if (series) return { kind: 'series', points: series, normalized: parsed.steps.some((s) => s.op === 'NORMALIZE') };
  return { kind: 'rows', rows };
}

export interface PlanIntent {
  collection: string;
  view?: string;
  operation?: string;
  measure?: string;
  den?: string;
  where?: TransformWhere[];
  denWhere?: TransformWhere[];
  order?: 'asc' | 'desc';
  limit?: number;
  /** Chemin de regroupement (GROUP) ; booléen true côté legacy → ignorer sans chemin. */
  groupBy?: string | boolean;
  percent?: boolean;
  normalize?: 'base100';
  time?: string;
  /** Classement : force SORT+LIMIT sans SUM. */
  ranking?: boolean;
}

/**
 * Synthèse déterministe d’un plan depuis les intentions scellées.
 * Classement sans SUM explicite → SORT + LIMIT.
 * Ratio → FILTER? + RATIO (comptage conditionnel si pas de mesure).
 */
export function planFromIntent(intent: PlanIntent): TransformPlan {
  const steps: TransformStep[] = [];
  if (intent.where?.length) steps.push({ op: 'FILTER', where: intent.where });

  const op = intent.operation;
  if (op === 'ratio') {
    steps.push({
      op: 'RATIO',
      denominatorWhere: intent.denWhere ?? [],
      measure: intent.measure,
      den: intent.den,
      percent: intent.percent ?? true,
    });
    return { source: { collection: intent.collection }, steps };
  }
  if (op === 'count' && !intent.ranking) {
    steps.push({ op: 'COUNT' });
    return { source: { collection: intent.collection }, steps };
  }
  if (op === 'sum' && intent.measure && !intent.ranking) {
    steps.push({ op: 'SUM', measure: intent.measure });
    return { source: { collection: intent.collection }, steps };
  }
  if (op === 'avg' && intent.measure && !intent.ranking) {
    steps.push({ op: 'AVG', measure: intent.measure });
    return { source: { collection: intent.collection }, steps };
  }

  const groupPath = typeof intent.groupBy === 'string' ? intent.groupBy : undefined;
  if (groupPath && (intent.ranking || intent.view === 'ranking' || intent.view === 'bars' || intent.view === 'donut')) {
    const agg = op === 'sum' ? 'sum' : op === 'avg' ? 'avg' : op === 'count' || !intent.measure ? 'count' : 'identity';
    steps.push({
      op: 'GROUP',
      by: groupPath,
      agg,
      measure: intent.measure,
      limit: intent.limit ?? 10,
    });
    return { source: { collection: intent.collection }, steps };
  }

  // Classement / identity : SORT + LIMIT, jamais SUM implicite.
  if (intent.ranking || intent.view === 'ranking' || op === 'identity' || (!op && intent.limit != null && intent.measure)) {
    if (intent.measure) steps.push({ op: 'SORT', by: intent.measure, order: intent.order ?? 'desc' });
    steps.push({ op: 'LIMIT', n: intent.limit ?? 10 });
    return { source: { collection: intent.collection }, steps };
  }

  if (intent.normalize === 'base100') {
    steps.push({ op: 'NORMALIZE', mode: 'base100', t: intent.time, v: intent.measure });
  }
  // Plan vide autorisé en synthèse ; buildPipeline / validate le rejettent (min 1 step).
  return { source: { collection: intent.collection }, steps };
}

/** Alias historique. */
export const synthesizeTransformPlan = planFromIntent;
