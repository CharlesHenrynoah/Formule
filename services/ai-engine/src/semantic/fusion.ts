/**
 * Fusion déterministe de plusieurs datasets (multi-entités / multi-sources).
 * Aucune invention de valeurs : concaténation puis pivot ordonné des observations déjà lues.
 */
import { getCollection, getPath, parseTime } from '@formule/contracts';
import type { Acquired } from '../discovery/catalog.js';
import { norm, type ReqTemplate } from './lexicon.js';
import { datasetOf, type Dataset } from './resolve.js';

function hitValue(v: unknown, entity: string) {
  if (v === null || v === undefined) return false;
  const a = norm(String(v)), b = norm(entity);
  return a === b && a.length > 0;
}

function argsCarryEntity(ds: Dataset, entity: string): boolean {
  return norm(JSON.stringify(ds.acq.args ?? {})).includes(norm(entity));
}

function extractSeries(ds: Dataset, entityHint: string): { t: string | number; v: number }[] | null {
  if (ds.acq.envelope.status === 'error' || ds.docOnly) return null;
  const time = ds.fields.find((f) => f.role === 'time');
  const measure = ds.fields.find((f) => f.role === 'measure');
  const rows = ds.collection ? (getCollection(ds.acq.raw, ds.collection) ?? []) : [];

  if (!rows.length) {
    const raw = ds.acq.raw as Record<string, unknown>;
    for (const [, val] of Object.entries(raw ?? {})) {
      if (!Array.isArray(val) || !val.length || !Array.isArray(val[0])) continue;
      const pts = (val as unknown[][])
        .filter((p) => p.length >= 2 && Number.isFinite(Number(p[1])))
        .map((p) => ({ t: p[0] as string | number, v: Number(p[1]) }));
      if (pts.length >= 2) return pts;
    }
    return null;
  }
  if (!time || !measure) return null;
  const labelFields = ds.fields.filter((f) => f.role === 'dimension' || f.role === 'text' || f.role === 'identifier');
  const hasLabels = labelFields.some((f) => rows.some((r) => typeof getPath(r, f.rel) === 'string'));
  const out: { t: string | number; v: number }[] = [];
  for (const r of rows) {
    if (hasLabels) {
      const ok = labelFields.some((f) => hitValue(getPath(r, f.rel), entityHint));
      if (!ok) continue;
    } else if (!argsCarryEntity(ds, entityHint) && !norm(ds.acq.ref.tool.name).includes(norm(entityHint).slice(0, 4))) {
      // Dataset sans label ni args : on prend la série entière (mono-source dédiée).
    }
    const ts = getPath(r, time.rel);
    const val = getPath(r, measure.rel);
    const n = typeof val === 'number' ? val : Number(val);
    if (!Number.isFinite(n)) continue;
    const parsed = parseTime(ts);
    out.push({ t: parsed != null ? new Date(parsed).toISOString() : String(ts), v: n });
  }
  return out.length >= 2 ? out : null;
}

function pickDatasetForEntity(entity: string, datasets: Map<string, Dataset>): Dataset | null {
  const usable = [...datasets.values()].filter((d) => d.acq.envelope.status !== 'error' && !d.docOnly);
  const scored = usable.map((ds) => {
    let score = 0;
    if (argsCarryEntity(ds, entity)) score += 10;
    if (norm(ds.acq.ref.tool.name).includes(norm(entity).slice(0, 4))) score += 3;
    if (extractSeries(ds, entity)) score += 5;
    return { ds, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  return scored[0]?.ds ?? null;
}

/**
 * Fusionne plusieurs historiques mono-entité en un dataset pivoté :
 * `{ points: [{ t, EntityA, EntityB, ... }] }` — colonnes stables, ordre du contrat.
 */
export function fuseMultiEntitySeries(req: ReqTemplate, datasets: Map<string, Dataset>): Dataset | null {
  const entities = req.entities ?? [];
  if ((req.visualization ?? req.view) !== 'line' || entities.length < 2) return null;

  const byEntity = new Map<string, { t: string | number; v: number }[]>();
  const sources: string[] = [];
  const sourceDs: Dataset[] = [];
  let first: Dataset | null = null;
  for (const entity of entities) {
    const ds = pickDatasetForEntity(entity, datasets);
    if (!ds) return null;
    const series = extractSeries(ds, entity);
    if (!series) return null;
    byEntity.set(entity, series);
    sources.push(ds.acq.queryId);
    sourceDs.push(ds);
    first ??= ds;
  }
  if (!first) return null;

  // Union des horodatages, tri lexicographique stable.
  const times = [...new Set([...byEntity.values()].flatMap((s) => s.map((p) => String(p.t))))].sort();
  const col = (entity: string) => entity.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40) || 'entity';
  const points = times.map((t) => {
    const row: Record<string, string | number | null> = { t };
    for (const entity of entities) {
      const hit = byEntity.get(entity)!.find((p) => String(p.t) === t);
      row[col(entity)] = hit ? hit.v : null;
    }
    return row;
  }).filter((row) => entities.some((e) => row[col(e)] != null));

  if (points.length < 2) return null;

  const identityErrs = fusionIdentityErrors(req, sourceDs);
  if (identityErrs.length) return null;

  const queryId = `fuse_${norm(req.id)}`.replace(/[^a-z0-9_]/g, '_').slice(0, 40);
  const measures = [...new Set(sourceDs.flatMap((ds) => {
    const m = ds.fields.find((f) => f.role === 'measure');
    return m ? [m.rel] : [];
  }))];
  const units = [...new Set(sourceDs.flatMap((ds) => {
    const m = ds.fields.find((f) => f.role === 'measure');
    return m?.unit ? [String(m.unit)] : [];
  }))];
  const periods = req.period ? [req.period] : [];
  const acq: Acquired = {
    queryId,
    ref: {
      ...first.acq.ref,
      // Marqueur dérivé : jamais un outil MCP réel.
      tool: {
        ...first.acq.ref.tool,
        name: `derived:fuse`,
        description: 'Dataset dérivé local (fusion) — recalculé à l’actualisation, hors catalogue MCP',
      },
    },
    args: {
      derived: true,
      kind: 'fusion',
      requirementId: req.id,
      entities,
      sources,
      measures,
      units,
      periods,
      transform: req.transform ?? null,
    },
    envelope: {
      ...first.acq.envelope,
      id: `env_${queryId}`,
      coverage: {
        complete: true,
        note: `fusion déterministe · entités=${entities.join(',')} · sources=${sources.join('+')} · mesures=${measures.join(',') || '—'} · unités=${units.join(',') || '—'}`,
      },
    },
    raw: { points, _meta: { entities, sources, measures, units, periods } },
  };
  return datasetOf(acq);
}

/** True si le dataset est dérivé (fusion) et ne doit jamais être relu via MCP. */
export function isDerivedDataset(ds: Dataset | { acq: { queryId: string; args?: Record<string, unknown>; ref: { tool: { name: string } } } }): boolean {
  return ds.acq.queryId.startsWith('fuse_')
    || ds.acq.args?.derived === true
    || /^derived:|^fuse:/.test(ds.acq.ref.tool.name);
}

/** Recalcule toutes les fusions à partir des sources MCP déjà présentes. */
export function recomputeDerivedDatasets(reqs: ReqTemplate[], datasets: Map<string, Dataset>): Map<string, Dataset> {
  const base = new Map([...datasets.entries()].filter(([, ds]) => !isDerivedDataset(ds)));
  // Exigences explicites + contrats dérivés déjà matérialisés (refresh sans replanifier).
  const fromDerived: ReqTemplate[] = [...datasets.values()]
    .filter(isDerivedDataset)
    .map((ds) => {
      const a = ds.acq.args ?? {};
      const entities = Array.isArray(a.entities) ? a.entities.map(String) : [];
      const id = typeof a.requirementId === 'string' ? a.requirementId : ds.acq.queryId.replace(/^fuse_/, 'r_');
      return {
        id, label: id, mandatory: true, tool: ['*'], view: 'line' as const, visualization: 'line' as const,
        title: id, entities, period: Array.isArray(a.periods) ? String(a.periods[0] ?? '') || undefined : undefined,
        transform: a.transform === 'base100' ? 'base100' as const : undefined,
        measures: Array.isArray(a.measures) ? a.measures.map(String) : undefined,
      };
    })
    .filter((r) => (r.entities?.length ?? 0) >= 2);
  const merged = [...reqs];
  for (const d of fromDerived) if (!merged.some((r) => r.id === d.id)) merged.push(d);
  return prepareDatasetsForBinding(merged, base);
}

/** Refuse une fusion si unités ou périodes source divergent sans déclaration commune. */
export function fusionIdentityErrors(req: ReqTemplate, sourceDs: Dataset[]): string[] {
  const errs: string[] = [];
  const units = sourceDs.map((ds) => ds.fields.find((f) => f.role === 'measure')?.unit).filter(Boolean).map(String);
  if (units.length >= 2 && new Set(units.map(norm)).size > 1) {
    errs.push(`unités incompatibles pour fusion « ${req.label} » : ${[...new Set(units)].join(' vs ')}`);
  }
  return errs;
}

/** Prépare la map : injecte les fusions nécessaires sans supprimer les sources. */
export function prepareDatasetsForBinding(reqs: ReqTemplate[], datasets: Map<string, Dataset>): Map<string, Dataset> {
  const next = new Map(datasets);
  for (const req of reqs) {
    if ((req.visualization ?? req.view) !== 'line' || (req.entities?.length ?? 0) < 2) continue;
    // Attache les series[] attendues par resolveRequirement (colonnes pivot).
    const fused = fuseMultiEntitySeries(req, next);
    if (fused) next.set(fused.acq.queryId, fused);
  }
  return next;
}

/** Enrichit une exigence line multi-entité pour cibler le dataset fusionné. */
export function attachFusedSeries(req: ReqTemplate, datasets: Map<string, Dataset>): ReqTemplate {
  const entities = req.entities ?? [];
  if ((req.visualization ?? req.view) !== 'line' || entities.length < 2) return req;
  const qid = `fuse_${norm(req.id)}`.replace(/[^a-z0-9_]/g, '_').slice(0, 40);
  if (!datasets.has(qid)) return req;
  const series = entities.map((e) => [e.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 40) || 'entity']);
  return { ...req, series, tool: [qid, ...req.tool], time: ['t'] };
}
