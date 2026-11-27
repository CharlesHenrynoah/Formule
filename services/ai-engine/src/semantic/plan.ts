import { recommend } from './charts.js';
import { getCollection, getPath, type AppSpec, type Requirement, type ViewSpec, type ActionSpec, type QuerySpec } from '@formule/contracts';
import type { CatalogServer } from '../discovery/catalog.js';
import { findTool } from '../discovery/catalog.js';
import { datasetOf, isSeries, NON_ADDITIVE, resolveRequirement, type Dataset } from './resolve.js';
import { norm, type ReqTemplate, type Understanding } from './lexicon.js';

export interface PlannedReq { tpl: ReqTemplate; status: Requirement['status']; reason?: string; queryId?: string; view?: ViewSpec; evidencePath?: string; envelopeId?: string }

/** Associe chaque exigence à un outil réel autorisé, ou la déclare indisponible avec la raison exacte. */
export function bindTools(u: Understanding, catalog: CatalogServer[]) {
  const toolFor = new Map<string, { serverId: string; tool: string; serverName: string; demo: boolean }>();
  const unavailable = new Map<string, string>();
  for (const r of u.reqs) {
    const { ref, blocked } = findTool(catalog, r.tool);
    if (ref) toolFor.set(r.id, { serverId: ref.serverId, tool: ref.tool.name, serverName: ref.serverName, demo: ref.demo });
    else if (blocked) unavailable.set(r.id, `l’outil ${blocked.serverName} · ${blocked.tool.name} existe mais n’est pas autorisé en lecture (coche-le dans MCP)`);
    else unavailable.set(r.id, 'aucune source autorisée ne fournit cette mesure');
  }
  return { toolFor, unavailable };
}

export function planRequirements(u: Understanding, datasets: Map<string, Dataset>, toolFor: Map<string, { serverId: string; tool: string }>, unavailable: Map<string, string>): PlannedReq[] {
  const out: PlannedReq[] = [];
  let i = 0;
  for (const tpl of u.reqs) {
    const reason = unavailable.get(tpl.id);
    if (reason) { out.push({ tpl, status: 'unavailable', reason }); continue; }
    const t = toolFor.get(tpl.id)!;
    const qid = queryIdFor(t.serverId, t.tool);
    const ds = datasets.get(qid);
    if (!ds) { out.push({ tpl, status: 'unavailable', reason: 'lecture non effectuée' }); continue; }
    const r = resolveRequirement(tpl, ds, `v${++i}_${tpl.view}`, qid);
    if (r.ok) out.push({ tpl, status: 'covered', queryId: qid, view: r.view, evidencePath: r.evidencePath, envelopeId: ds.acq.envelope.id });
    else out.push({ tpl, status: ds.acq.envelope.status === 'error' ? 'unavailable' : 'missing', reason: r.reason });
  }
  return out;
}

export const queryIdFor = (serverId: string, tool: string) => norm(`${serverId}_${tool}`).replace(/[^a-z0-9_-]+/g, '_').slice(0, 40);

/** Actions proposées uniquement à partir d'outils d'écriture AUTORISÉS du catalogue. */
export function planActions(catalog: CatalogServer[], usedServers: Set<string>, datasets: Map<string, Dataset>): ActionSpec[] {
  const out: ActionSpec[] = [];
  for (const srv of catalog) {
    if (!usedServers.has(srv.serverId)) continue;
    for (const t of srv.tools) {
      if (t.permission !== 'write') continue;
      const props = (t.inputSchema?.properties ?? {}) as Record<string, { type?: string; enum?: string[] }>;
      const required = new Set(((t.inputSchema as { required?: string[] })?.required) ?? []);
      const fields = Object.entries(props).filter(([k]) => !/idempot/i.test(k)).slice(0, 6).map(([k, p]) => ({
        name: k.replace(/[^a-z0-9_]/gi, '_').toLowerCase(), label: k.replace(/_/g, ' '),
        type: (p.enum ? 'enum' : p.type === 'number' || p.type === 'integer' ? 'number' : 'string') as 'enum' | 'number' | 'string',
        required: required.has(k), ...(p.enum ? { options: p.enum } : {}),
      }));
      // l'action n'apparaît que si elle concerne une entité présente dans les données lues
      const entity = norm(t.name).split('_')[0];
      const relevant = [...datasets.values()].some((d) => norm(d.acq.ref.tool.name).includes(entity.slice(0, 6)));
      if (!relevant) continue;
      out.push({ id: norm(t.name).replace(/[^a-z0-9_-]/g, '_').slice(0, 40), label: t.name.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()).slice(0, 60), serverId: srv.serverId, tool: t.name, effect: (t.description || t.name).replace(/^ÉCRITURE\s*:\s*/i, '').slice(0, 200), fields, fixedArgs: {} });
    }
  }
  return out.slice(0, 4);
}

export function assembleSpec(input: { u: Understanding; planned: PlannedReq[]; datasets: Map<string, Dataset>; actions: ActionSpec[]; demo: boolean; prompt?: string; pointsLocked?: boolean }): AppSpec {
  const { u, planned, datasets } = input;
  const usedQ = new Set(planned.filter((p) => p.queryId).map((p) => p.queryId!));
  const queries: QuerySpec[] = [...usedQ].map((qid) => {
    const ds = datasets.get(qid)!;
    return { id: qid, serverId: ds.acq.ref.serverId, tool: ds.acq.ref.tool.name, args: ds.acq.args, refresh: { mode: 'once' as const }, envelopeId: ds.acq.envelope.id, ...(ds.acq.paginate ? { paginate: ds.acq.paginate } : {}) };
  });
  const views: ViewSpec[] = planned.filter((p) => p.view).map((p) => p.view!);
  if (!input.pointsLocked && u.simulation) {
    const base = planned.find((p) => p.view?.kind === 'line');
    if (base?.view?.kind === 'line') {
      const lv = base.view;
      // la série simulée est celle que la demande désigne (ex. « températures » → temp_max), sinon la première
      const ds = datasets.get(lv.queryId);
      const words = norm(u.mission + ' ' + u.title).split(/[^a-z0-9]+/).filter((w) => w.length > 3);
      const measures = ds?.fields.filter((f) => f.role === 'measure') ?? [];
      const hit = measures.find((f) => words.some((w) => norm(f.rel).includes(w.slice(0, 4))));
      const chosen = hit ? { path: hit.rel, label: hit.rel.split('.')[0].replace(/_/g, ' '), unit: hit.unit ?? null } : lv.bindings.series[0];
      views.push({ kind: 'simulation', id: 'sim', title: `Scénario · ${chosen.label}`, queryId: lv.queryId, requirementIds: [], bindings: { collection: lv.bindings.collection, t: lv.bindings.t, v: chosen.path, unit: chosen.unit },
        model: { name: 'derive_lineaire', params: [
          { id: 'variation_pct', label: 'Variation par période', min: -20, max: 20, step: 0.5, default: 0, unit: '%' },
          { id: 'horizon', label: 'Horizon', min: 1, max: 30, step: 1, default: 7, unit: 'pér.' },
        ], assumptions: ['scénario calculé localement, distinct des données observées'] } });
    }
  }
  if (!input.pointsLocked) recommend(views, datasets, [...usedQ], input.prompt ?? `${input.u.title} ${input.u.mission}`);
  const requirements: Requirement[] = planned.map((p) => ({
    id: p.tpl.id, label: p.tpl.label, mandatory: p.tpl.mandatory, status: p.status,
    ...(p.reason ? { reason: p.reason } : {}),
    evidence: p.view && p.envelopeId ? { envelopeId: p.envelopeId, path: p.evidencePath!, viewId: p.view.id } : null,
  }));
  return {
    specVersion: 1, title: u.title.slice(0, 80), mission: u.mission.slice(0, 400), demo: input.demo,
    requirements, queries, views, actions: input.actions, commands: u.commands, style: { density: 'confortable', accent: 'bleu' },
  };
}

export { datasetOf };

/**
 * Les vues supplémentaires viennent de l'intention (tendance, part, classement, distribution, corrélation, calendrier).
 * Sans cette intention, le contrat reste celui des exigences : pas de tableau de bord générique.
 */
