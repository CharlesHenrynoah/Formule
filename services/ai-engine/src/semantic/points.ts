import { getCollection, getPath, parseTime } from '@formule/contracts';
import { contradicts } from '../evaluation/oracle.js';
import { periodInterval } from './analytical.js';
import { norm, type ReqTemplate } from './lexicon.js';
import type { PlannedReq } from './plan.js';
import { resolveRequirement, type Dataset } from './resolve.js';

/**
 * Lie un contrat déjà figé aux champs réellement lus.
 * Contraintes d'entité, population, période, grain et unité = éliminatoires.
 * Le score ne départage que les datasets déjà compatibles.
 */
export function bindClauses(reqs: ReqTemplate[], datasets: Map<string, Dataset>): PlannedReq[] {
  const used = new Set<string>();
  return reqs.map((tpl) => {
    if ((tpl.visualization ?? tpl.view) === 'note' || tpl.view === 'note') {
      return { tpl, status: 'unavailable' as const, reason: tpl.acceptance ?? 'note' };
    }
    const candidates = rankDatasets(tpl, datasets);
    if (!candidates.length) {
      const why = [...datasets.values()].map((ds) => eliminate(tpl, ds)).find(Boolean);
      return { tpl, status: 'unavailable' as const, reason: why ?? 'aucune donnée lue ne porte cette exigence' };
    }
    const viewId = unique(used, `v_${tpl.id}`.slice(0, 40));
    const reasons: string[] = [];
    for (const { ds } of candidates) {
      const resolved = resolveRequirement(tpl, ds, viewId, ds.acq.queryId);
      if (!resolved.ok) { reasons.push(`${ds.acq.queryId}: ${resolved.reason}`); continue; }
      const clash = contradicts(tpl, resolved.view);
      if (clash) { reasons.push(`${ds.acq.queryId}: ${clash}`); continue; }
      return { tpl, status: 'covered' as const, queryId: ds.acq.queryId, view: resolved.view, evidencePath: resolved.evidencePath, envelopeId: ds.acq.envelope.id };
    }
    const fail = candidates[0].ds.acq.envelope.status === 'error' ? 'unavailable' as const : 'missing' as const;
    return { tpl, status: fail, reason: reasons[0] ?? 'aucune acquisition compatible' };
  });
}

/** Survivants des contraintes dures, puis score décroissant. */
export function rankDatasets(req: ReqTemplate, datasets: Map<string, Dataset>): { ds: Dataset; score: number }[] {
  const usable = [...datasets.values()].filter((d) => d.acq.envelope.status !== 'error' && !d.docOnly);
  const survivors = usable.filter((ds) => !eliminate(req, ds));
  const scored = survivors.map((ds) => ({ ds, score: scoreDataset(req, ds) }));
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/** Conditions éliminatoires : false = compatible, string = motif d'élimination. */
export function eliminate(req: ReqTemplate, ds: Dataset): string | null {
  const rows = ds.collection ? (getCollection(ds.acq.raw, ds.collection) ?? []) : [];
  const labelFields = ds.fields.filter((f) => f.role === 'dimension' || f.role === 'text' || f.role === 'identifier');

  for (const entity of req.entities ?? []) {
    const hit = rows.some((r) => labelFields.some((f) => hitValue(getPath(r, f.rel), entity)));
    if (!hit) return `entité « ${entity} » absente`;
  }

  if (req.population) {
    const pop = norm(req.population);
    const words = pop.split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    const blob = norm(`${ds.acq.ref.serverName} ${ds.acq.ref.tool.name} ${ds.acq.ref.tool.description ?? ''} ${JSON.stringify(ds.acq.args ?? {})} ${rows.slice(0, 5).map((r) => JSON.stringify(r)).join(' ')}`);
    if (words.length && !words.some((w) => blob.includes(w))) return `population « ${req.population} » absente`;
  }

  const time = ds.fields.find((f) => f.role === 'time');
  if (req.period) {
    if (!time) return `période « ${req.period} » sans horodatage`;
    const bounds = periodInterval(req.period);
    if (!bounds) return `période « ${req.period} » non interprétable`;
    const ts = rows.map((r) => parseTime(getPath(r, time.rel))).filter((t): t is number => t !== null);
    if (!ts.some((t) => t >= bounds.start && t <= bounds.end)) return `période « ${req.period} » hors intervalle des données`;
  }

  if (req.grain) {
    if (!time) return `granularité « ${req.grain} » sans horodatage`;
    const ts = rows.map((r) => parseTime(getPath(r, time.rel))).filter((t): t is number => t !== null).sort((a, b) => a - b);
    if (ts.length < 3) return `granularité « ${req.grain} » : série trop courte`;
    const steps = ts.slice(1).map((t, i) => t - ts[i]).filter((d) => d > 0).sort((a, b) => a - b);
    const med = steps[Math.floor(steps.length / 2)] ?? 0;
    if (req.grain === 'day' && !(med >= 20 * 3600_000 && med <= 40 * 3600_000)) return `granularité « day » non respectée`;
    if (req.grain === 'hour' && !(med >= 30 * 60_000 && med <= 2 * 3600_000)) return `granularité « hour » non respectée`;
  }

  if (req.unit) {
    const measureKws = [...(req.measures ?? []), ...(req.measure ?? [])].map(norm);
    const hits = ds.fields.filter((f) => f.role === 'measure' && measureKws.some((k) => k.length > 2 && norm(f.rel).includes(k)));
    const unitOk = hits.some((f) => f.unit && norm(f.unit) === norm(req.unit!))
      || hits.some((f) => norm(f.rel).includes(norm(req.unit!)))
      || rows.some((r) => hits.some((f) => {
        const us = ds.fields.find((x) => x.rel.startsWith(f.rel.split('.')[0]) && /devise|unite|unit|currency/.test(norm(x.rel)));
        return us && norm(String(getPath(r, us.rel) ?? '')) === norm(req.unit!);
      }));
    // Si aucune mesure n'expose d'unité, le suffixe du champ (prix_eur) peut suffire.
    const suffixOk = hits.some((f) => norm(f.rel).endsWith(`_${norm(req.unit!)}`) || norm(f.rel).includes(norm(req.unit!)));
    if (!unitOk && !suffixOk) return `unité « ${req.unit} » absente`;
  }

  return null;
}

function scoreDataset(req: ReqTemplate, ds: Dataset): number {
  let score = 0;
  const tools = req.tool.map(norm).filter((t) => t && t !== '*');
  if (tools.some((t) => norm(ds.acq.ref.tool.name).includes(t) || t.includes(norm(ds.acq.ref.tool.name)))) score += 4;

  const measureKws = [...(req.measures ?? []), ...(req.measure ?? [])].map(norm);
  const measureHits = ds.fields.filter((f) => f.role === 'measure' && measureKws.some((k) => k.length > 2 && norm(f.rel).includes(k)));
  score += measureHits.length * 3;
  if (req.operation === 'count' || req.agg === 'count') score += ds.collection ? 1 : 0;
  for (const f of measureHits) if (f.unit) score += 1;

  const rows = ds.collection ? (getCollection(ds.acq.raw, ds.collection) ?? []) : [];
  if (req.entities?.length) score += 5;
  if (req.population) score += 3 + Math.min(2, Math.floor(Math.log10(rows.length + 1)));
  if (req.period || req.grain) score += 3;
  for (const w of req.filters ?? req.where ?? []) {
    if (ds.fields.some((f) => w.field.some((k) => k.length > 2 && norm(f.rel).includes(norm(k))))) score += 1;
  }
  return score;
}

function hitValue(v: unknown, entity: string) {
  if (v === null || v === undefined) return false;
  const a = norm(String(v)), b = norm(entity);
  return a.length > 1 && b.length > 1 && (a === b || a.includes(b) || b.includes(a));
}

function unique(used: Set<string>, base: string) {
  let id = base || 'vue';
  let n = 2;
  while (used.has(id)) id = `${base.slice(0, 28)}_${n++}`;
  used.add(id);
  return id;
}
