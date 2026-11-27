import { contradicts } from '../evaluation/oracle.js';
import { norm, type ReqTemplate } from './lexicon.js';
import type { PlannedReq } from './plan.js';
import { resolveRequirement, type Dataset } from './resolve.js';

/**
 * Lie un contrat déjà figé aux champs réellement lus.
 * La vue, l'opération et les filtres ne sont pas réécrits à partir de la forme des données.
 */
export function bindClauses(reqs: ReqTemplate[], datasets: Map<string, Dataset>): PlannedReq[] {
  const used = new Set<string>();
  return reqs.map((tpl) => {
    if (tpl.view === 'note') return { tpl, status: 'unavailable' as const, reason: tpl.acceptance ?? 'note' };
    const ds = pickDataset(tpl, datasets);
    if (!ds) return { tpl, status: 'unavailable' as const, reason: 'aucune donnée lue ne porte cette exigence' };
    const viewId = unique(used, `v_${tpl.id}`.slice(0, 40));
    const resolved = resolveRequirement(tpl, ds, viewId, ds.acq.queryId);
    if (!resolved.ok) return { tpl, status: ds.acq.envelope.status === 'error' ? 'unavailable' as const : 'missing' as const, reason: resolved.reason };
    const clash = contradicts(tpl, resolved.view);
    if (clash) return { tpl, status: 'missing' as const, reason: clash };
    return { tpl, status: 'covered' as const, queryId: ds.acq.queryId, view: resolved.view, evidencePath: resolved.evidencePath, envelopeId: ds.acq.envelope.id };
  });
}

function pickDataset(req: ReqTemplate, datasets: Map<string, Dataset>): Dataset | undefined {
  const usable = [...datasets.values()].filter((d) => d.acq.envelope.status !== 'error' && !d.docOnly);
  const tools = req.tool.map(norm).filter((t) => t && t !== '*');
  const byTool = usable.find((d) => tools.some((t) => norm(d.acq.ref.tool.name).includes(t) || t.includes(norm(d.acq.ref.tool.name))));
  if (byTool) return byTool;
  const kws = [...(req.measure ?? []), ...(req.label_ ?? []), ...(req.where ?? []).flatMap((w) => w.field)];
  let best: { ds: Dataset; score: number } | null = null;
  for (const ds of usable) {
    const score = ds.fields.filter((f) => kws.some((k) => k.length > 2 && norm(f.rel).includes(norm(k)))).length;
    if (score > (best?.score ?? 0)) best = { ds, score };
  }
  if (best && best.score > 0) return best.ds;
  return usable.length === 1 ? usable[0] : undefined;
}

function unique(used: Set<string>, base: string) {
  let id = base || 'vue';
  let n = 2;
  while (used.has(id)) id = `${base.slice(0, 28)}_${n++}`;
  used.add(id);
  return id;
}
