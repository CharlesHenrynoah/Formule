import { getCollection, getPath, parseTime } from '@formule/contracts';
import { contradicts } from '../evaluation/oracle.js';
import { norm, type ReqTemplate } from './lexicon.js';
import type { PlannedReq } from './plan.js';
import { resolveRequirement, type Dataset } from './resolve.js';

/**
 * Lie un contrat déjà figé aux champs réellement lus.
 * La vue, l'opération et les filtres ne sont pas réécrits à partir de la forme des données.
 * En cas d'échec, on tente une autre acquisition compatible avant de déclarer l'indisponibilité.
 */
export function bindClauses(reqs: ReqTemplate[], datasets: Map<string, Dataset>): PlannedReq[] {
  const used = new Set<string>();
  return reqs.map((tpl) => {
    if ((tpl.visualization ?? tpl.view) === 'note' || tpl.view === 'note') {
      return { tpl, status: 'unavailable' as const, reason: tpl.acceptance ?? 'note' };
    }
    const candidates = rankDatasets(tpl, datasets);
    if (!candidates.length) return { tpl, status: 'unavailable' as const, reason: 'aucune donnée lue ne porte cette exigence' };
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

/** Score sémantique : entités, population, granularité, période, mesure, unité — pas seulement les mots. */
export function rankDatasets(req: ReqTemplate, datasets: Map<string, Dataset>): { ds: Dataset; score: number }[] {
  const usable = [...datasets.values()].filter((d) => d.acq.envelope.status !== 'error' && !d.docOnly);
  const scored = usable.map((ds) => ({ ds, score: scoreDataset(req, ds) })).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  if (scored.length) return scored;
  // Dernier recours : un seul dataset utilisable, score nul mais tentable.
  return usable.length === 1 ? [{ ds: usable[0], score: 0 }] : [];
}

function scoreDataset(req: ReqTemplate, ds: Dataset): number {
  let score = 0;
  const tools = req.tool.map(norm).filter((t) => t && t !== '*');
  if (tools.some((t) => norm(ds.acq.ref.tool.name).includes(t) || t.includes(norm(ds.acq.ref.tool.name)))) score += 4;

  const measureKws = [...(req.measures ?? []), ...(req.measure ?? [])].map(norm);
  const measureHits = ds.fields.filter((f) => f.role === 'measure' && measureKws.some((k) => k.length > 2 && norm(f.rel).includes(k)));
  score += measureHits.length * 3;
  if (req.operation === 'count' || req.agg === 'count') score += ds.collection ? 1 : 0;

  // Unité : si une mesure demandée porte une unité, favoriser le dataset qui l'a.
  for (const f of measureHits) if (f.unit) score += 1;

  const rows = ds.collection ? (getCollection(ds.acq.raw, ds.collection) ?? []) : [];
  const labelFields = ds.fields.filter((f) => f.role === 'dimension' || f.role === 'text' || f.role === 'identifier');

  // Entités : valeurs réellement présentes.
  for (const entity of req.entities ?? []) {
    const hit = rows.some((r) => labelFields.some((f) => hitValue(getPath(r, f.rel), entity)));
    if (hit) score += 5;
    else score -= 3;
  }

  // Population : mot présent dans l'outil, le titre, ou densite de lignes.
  if (req.population) {
    const pop = norm(req.population);
    const blob = norm(`${ds.acq.ref.serverName} ${ds.acq.ref.tool.name} ${ds.acq.ref.tool.description ?? ''} ${JSON.stringify(ds.acq.args ?? {})}`);
    if (pop.split(/[^a-z0-9]+/).filter((w) => w.length > 3).some((w) => blob.includes(w))) score += 3;
    if (rows.length > 0) score += Math.min(2, Math.floor(Math.log10(rows.length + 1)));
  }

  // Période / grain : horodatages réellement lus.
  const time = ds.fields.find((f) => f.role === 'time');
  if ((req.period || req.grain || req.view === 'line' || req.visualization === 'line') && time) {
    const ts = rows.map((r) => parseTime(getPath(r, time.rel))).filter((t): t is number => t !== null);
    if (ts.length >= 2) score += 3;
    if (req.period) {
      const p = norm(req.period);
      const labels = ts.map((t) => new Date(t).toISOString());
      if (p.length >= 4 && labels.some((l) => l.includes(p) || norm(l).includes(p))) score += 2;
    }
    if (req.grain && ts.length >= 3) {
      const steps = ts.slice().sort((a, b) => a - b).slice(1).map((t, i) => t - ts.sort((a, b) => a - b)[i]).filter((d) => d > 0);
      const med = steps.sort((a, b) => a - b)[Math.floor(steps.length / 2)] ?? 0;
      if (req.grain === 'day' && med >= 20 * 3600_000 && med <= 40 * 3600_000) score += 2;
      if (req.grain === 'hour' && med >= 30 * 60_000 && med <= 2 * 3600_000) score += 2;
    }
  } else if ((req.period || req.grain) && !time) {
    score -= 2;
  }

  // Filtres : champs ciblés présents.
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
