import {
  collectionFields, inferContract, getCollection, getPath, parseTime, NON_ADDITIVE, type DataContract, type FieldContract, type ViewSpec,
} from '@formule/contracts';
import type { Acquired } from '../discovery/catalog.js';
import { norm, type ClauseFilter, type ReqTemplate } from './lexicon.js';

export { NON_ADDITIVE };

export interface Dataset { acq: Acquired; contract: DataContract; collection: string | null; fields: (FieldContract & { rel: string })[]; docOnly: boolean }

export function datasetOf(acq: Acquired): Dataset {
  const contract = inferContract(acq.raw, { envelopeId: acq.envelope.id, serverId: acq.ref.serverId, tool: acq.ref.tool.name });
  // la plus grande collection d'objets, y compris imbriquée (ex. results[].result.entries[])
  const objColls = contract.collections.filter((c) => contract.fields.some((f) => f.path.startsWith(c.path + '.') && !f.path.slice(c.path.length + 1).includes('[]')));
  const top = objColls.sort((a, b) => b.count - a.count || a.path.length - b.path.length)[0];
  const collection = top ? top.path.slice(0, -2) : null;
  const fields = collection ? collectionFields(contract, top.path) : contract.fields.filter((f) => !f.path.includes('[]')).map((f) => ({ ...f, rel: f.path }));
  const docOnly = contract.fields.length === 1 && contract.fields[0].path === 'texte';
  return { acq, contract, collection, fields, docOnly };
}

const stem = (k: string) => (k.length > 4 && k.endsWith('s') ? k.slice(0, -1) : k);
const fieldHit = (rel: string, k: string) => {
  const head = stem(norm(rel).split('.')[0]);
  const needle = stem(norm(k));
  return needle.length > 2 && (head.includes(needle) || needle.includes(head) || norm(rel).includes(needle));
};
const matchField = (fields: Dataset['fields'], kws: string[] | undefined, roles: FieldContract['role'][]) => {
  if (!kws) return undefined;
  for (const k of kws) {
    const f = fields.find((x) => roles.includes(x.role) && fieldHit(x.rel, k));
    if (f) return f;
  }
  return undefined;
};

const unitSibling = (fields: Dataset['fields'], rel: string) => {
  const parent = rel.includes('.') ? rel.slice(0, rel.lastIndexOf('.')) : null;
  if (!parent) return undefined;
  return fields.find((f) => f.rel.startsWith(parent + '.') && /\.(devise|unite|unité|unit|currency)$/.test(f.rel));
};

export type Resolution =
  | { ok: true; view: ViewSpec; evidencePath: string }
  | { ok: false; reason: string };

/** Lie une exigence aux champs RÉELLEMENT présents dans le brut. Aucune mesure inventée. */
export function resolveRequirement(req: ReqTemplate, ds: Dataset, viewId: string, queryId: string): Resolution {
  const src = `${ds.acq.ref.serverName} · ${ds.acq.ref.tool.name}`;
  if (ds.acq.envelope.status === 'error') return { ok: false, reason: `lecture en échec sur ${src} (${ds.acq.envelope.error?.message ?? 'erreur'})` };
  if (ds.docOnly) return { ok: false, reason: `seule une documentation textuelle est disponible sur ${src} : aucune mesure` };
  const F = ds.fields;
  if (!ds.collection && req.view === 'kpi') {
    // Objet imbriqué sans collection : lecture directe du chemin, unité conservée.
    const m = matchField(F, req.measure, ['measure']);
    if (!m) return { ok: false, reason: `champ « ${req.measure?.[0]} » absent des données lues (${src})` };
    const us = unitSibling(F, m.rel);
    const t = F.find((f) => f.role === 'time');
    return { ok: true, evidencePath: m.rel, view: { kind: 'kpi', id: viewId, title: req.title, queryId, requirementIds: [req.id], bindings: { value: m.rel, unit: m.unit ?? null, unitPath: us?.rel, observedAt: t?.rel } } };
  }
  if (!ds.collection) return { ok: false, reason: `aucune collection exploitable dans ${src}` };
  const coll = ds.collection;
  const need = (f: FieldContract | undefined, what: string) => (f ? null : `champ « ${what} » absent des données lues (${src})`);

  if (req.view === 'kpi') {
    const op = req.operation ?? req.agg;
    const measureKws = req.measures ?? req.measure;
    const wantsMeasure = !!measureKws?.length && op !== 'count';
    const measure = wantsMeasure ? matchField(F, measureKws, ['measure']) : undefined;
    const den = req.den ? matchField(F, req.den, ['measure']) : undefined;
    const miss = (wantsMeasure && need(measure, measureKws![0])) || (req.den && need(den, req.den[0])) || null;
    if (miss) return { ok: false, reason: miss };
    // Une mesure demandée absente ne devient jamais un comptage silencieux.
    if (wantsMeasure && !measure) return { ok: false, reason: `mesure « ${measureKws![0]} » absente — pas de substitution par un comptage (${src})` };
    const where = bindFilters(F, req.filters ?? req.where, src);
    if (!where.ok) return where;
    const denWhere = req.denWhere ? bindFilters(F, req.denWhere, src) : undefined;
    if (denWhere && !denWhere.ok) return denWhere;
    const agg = op ?? (measure && NON_ADDITIVE.test(norm(measure.rel)) ? 'last' : !measure ? 'count' : 'sum');
    if ((agg === 'sum' || (agg === 'ratio' && !den && req.denWhere === undefined)) && measure && NON_ADDITIVE.test(norm(measure.rel)) && agg !== 'last' && agg !== 'identity') {
      return { ok: false, reason: `somme interdite sur « ${measure.rel} » : mesure non additive (${src})` };
    }
    if (agg === 'identity' && !measure) return { ok: false, reason: `identité sans mesure (${src})` };
    if (measure && (measure.units?.length ?? 0) > 1 && !unitSibling(F, measure.rel)) return { ok: false, reason: `unités multiples pour « ${measure.rel} » : pas de fusion implicite` };
    const us = measure ? unitSibling(F, measure.rel) : undefined;
    return {
      ok: true, evidencePath: `${coll}[].${measure?.rel ?? '*'}`,
      view: {
        kind: 'kpi', id: viewId, title: req.title, queryId, requirementIds: [req.id],
        bindings: {
          unit: agg === 'count' ? null : req.percent ? '%' : agg === 'ratio' ? null : measure?.unit ?? null,
          aggregate: { collection: coll, agg, measure: measure?.rel, den: den?.rel, unitPath: agg === 'ratio' ? undefined : us?.rel, where: where.filters, ...(denWhere?.ok ? { denWhere: denWhere.filters } : {}), percent: !!req.percent },
        },
      },
    };
  }
  if (req.view === 'line' || req.view === 'simulation') {
    const t = matchField(F, req.time ?? ['date', 'horodatage', 'time', 'jour'], ['time']) ?? F.find((f) => f.role === 'time');
    if (!t) return { ok: false, reason: `aucun horodatage dans les données lues (${src})` };
    const series = [];
    for (const kws of req.series ?? [req.measures ?? req.measure ?? []]) {
      const m = matchField(F, kws, ['measure']);
      if (!m) return { ok: false, reason: `série « ${kws[0]} » absente des données lues (${src})` };
      series.push({ path: m.rel, label: m.rel.split('.')[0].replace(/_/g, ' '), unit: m.unit ?? null });
    }
    if (req.view === 'simulation') {
      return { ok: true, evidencePath: `${coll}[].${series[0].path}`, view: {
        kind: 'simulation', id: viewId, title: req.title, queryId, requirementIds: [req.id],
        bindings: { collection: coll, t: t.rel, v: series[0].path, unit: series[0].unit },
        model: { name: 'derive_lineaire', params: [
          { id: 'variation_pct', label: 'Variation par période', min: -20, max: 20, step: 0.5, default: 0, unit: '%' },
          { id: 'horizon', label: 'Horizon', min: 1, max: 30, step: 1, default: 7, unit: 'pér.' },
        ], assumptions: ['scénario calculé localement, distinct des données observées'] },
      } };
    }
    return { ok: true, evidencePath: `${coll}[].${series[0].path}`, view: { kind: 'line', id: viewId, title: req.title, queryId, requirementIds: [req.id], bindings: { collection: coll, t: t.rel, series } } };
  }
  if (req.view === 'ranking') {
    const measureKws = req.measures ?? req.measure;
    const op = req.operation ?? req.agg;
    const metric = matchField(F, measureKws, ['measure']);
    const den = req.den ? matchField(F, req.den, ['measure']) : undefined;
    const label = matchField(F, req.label_ ?? req.dimensions, ['dimension', 'text', 'identifier', 'state']);
    const miss = need(metric, measureKws?.[0] ?? 'mesure') || (req.den && need(den, req.den[0])) || need(label, req.label_?.[0] ?? 'libellé');
    if (miss) return { ok: false, reason: miss };
    // Somme explicite ou regroupement : jamais sur une mesure non additive. Un classement ligne à ligne reste permis.
    if ((op === 'sum' || !!req.groupBy) && (op ?? 'sum') === 'sum' && NON_ADDITIVE.test(norm(metric!.rel))) {
      return { ok: false, reason: `somme interdite sur « ${metric!.rel} » : mesure non additive (${src})` };
    }
    const us = unitSibling(F, metric!.rel);
    const agg = op === 'ratio' ? 'ratio' : op === 'count' ? 'count' : 'sum';
    return { ok: true, evidencePath: `${coll}[].${metric!.rel}`, view: {
      kind: 'ranking', id: viewId, title: req.title, queryId, requirementIds: [req.id],
      bindings: {
        collection: coll, label: label!.rel, metric: metric!.rel, den: den?.rel, groupBy: !!req.groupBy, agg,
        unit: agg === 'ratio' ? null : metric!.unit ?? null, unitPath: us?.rel,
        population: req.population ?? `${getCollection(ds.acq.raw, coll)?.length ?? 0} lignes de ${ds.acq.ref.tool.name}`,
        order: req.order ?? 'desc', limit: req.limit ?? 10,
      },
    } };
  }
  if (req.view === 'bars' || req.view === 'donut') {
    const label = matchField(F, req.label_ ?? req.dimensions ?? ['nom', 'name', 'libelle', 'categorie', 'famille', 'type'], ['dimension', 'text', 'identifier', 'state']);
    const measureKws = req.measures ?? req.measure;
    const op = req.operation ?? req.agg;
    const metric = op === 'count' ? undefined : matchField(F, measureKws, ['measure']);
    if (!label) return { ok: false, reason: `champ « ${req.label_?.[0] ?? 'libellé'} » absent des données lues (${src})` };
    if (measureKws?.length && op !== 'count' && !metric) return { ok: false, reason: `champ « ${measureKws[0]} » absent — pas de substitution par un comptage (${src})` };
    // identity : mesure brute par entité, sans somme/comptage artificiel.
    if (op === 'identity') {
      if (!metric) return { ok: false, reason: `identité graphique sans mesure (${src})` };
      const where = bindFilters(F, req.filters ?? req.where, src);
      if (!where.ok) return where;
      return { ok: true, evidencePath: `${coll}[].${metric.rel}`, view: {
        kind: req.view, id: viewId, title: req.title, queryId, requirementIds: [req.id],
        bindings: { collection: coll, label: label.rel, metric: metric.rel, agg: 'identity', unit: metric.unit ?? req.unit ?? null, limit: req.limit ?? Math.max(2, req.entities?.length ?? 8) },
      } };
    }
    if (metric && (op === 'sum' || op === undefined) && NON_ADDITIVE.test(norm(metric.rel))) {
      return { ok: false, reason: `somme interdite sur « ${metric.rel} » : mesure non additive (${src})` };
    }
    const agg = op === 'avg' ? 'avg' : op === 'count' || !metric ? 'count' : 'sum';
    return { ok: true, evidencePath: `${coll}[].${metric?.rel ?? label.rel}`, view: {
      kind: req.view, id: viewId, title: req.title, queryId, requirementIds: [req.id],
      bindings: { collection: coll, label: label.rel, ...(metric && agg !== 'count' ? { metric: metric.rel } : {}), agg, unit: metric?.unit ?? req.unit ?? null, limit: req.limit ?? 8 },
    } };
  }
  if (req.view === 'histogram') {
    const metric = matchField(F, req.measure, ['measure']);
    if (!metric) return { ok: false, reason: `champ « ${req.measure?.[0] ?? 'mesure'} » absent des données lues (${src})` };
    return { ok: true, evidencePath: `${coll}[].${metric.rel}`, view: { kind: 'histogram', id: viewId, title: req.title, queryId, requirementIds: [req.id], bindings: { collection: coll, v: metric.rel, bins: 12, unit: metric.unit ?? null } } };
  }
  if (req.view === 'scatter') {
    const x = matchField(F, req.measure, ['measure']);
    const y = matchField(F, req.den ?? req.series?.[1], ['measure']);
    if (!x || !y || x.rel === y.rel) return { ok: false, reason: `deux mesures distinctes sont requises pour le nuage (${src})` };
    return { ok: true, evidencePath: `${coll}[].${x.rel}`, view: { kind: 'scatter', id: viewId, title: req.title, queryId, requirementIds: [req.id], bindings: { collection: coll, x: x.rel, y: y.rel, xLabel: x.rel.split('.')[0].replace(/_/g, ' '), yLabel: y.rel.split('.')[0].replace(/_/g, ' '), xUnit: x.unit ?? null, yUnit: y.unit ?? null } } };
  }
  if (req.view === 'heatmap') {
    const t = matchField(F, req.time ?? ['date', 'horodatage', 'time', 'jour'], ['time']) ?? F.find((f) => f.role === 'time');
    const metric = matchField(F, req.measure, ['measure']);
    if (!t || !metric) return { ok: false, reason: `horodatage ou mesure absent pour la carte (${src})` };
    const agg = req.agg === 'sum' && !NON_ADDITIVE.test(norm(metric.rel)) ? 'sum' : 'avg';
    if (req.agg === 'sum' && NON_ADDITIVE.test(norm(metric.rel))) return { ok: false, reason: `somme interdite sur « ${metric.rel} » : mesure non additive (${src})` };
    return { ok: true, evidencePath: `${coll}[].${metric.rel}`, view: { kind: 'heatmap', id: viewId, title: req.title, queryId, requirementIds: [req.id], bindings: { collection: coll, t: t.rel, v: metric.rel, agg, unit: metric.unit ?? null } } };
  }
  if (req.view === 'note') return { ok: false, reason: req.acceptance ?? 'note sans donnée' };
  if (req.view !== 'table') return { ok: false, reason: `visualisation « ${req.view} » non résolue (${src})` };
  // table
  const pick = [
    ...F.filter((f) => f.role === 'identifier').slice(0, 1),
    ...F.filter((f) => f.role === 'dimension' || f.role === 'state').slice(0, 3),
    ...F.filter((f) => f.role === 'time').slice(0, 1),
    ...F.filter((f) => f.role === 'measure').slice(0, 4),
  ].slice(0, 9);
  if (!pick.length) return { ok: false, reason: `aucune colonne exploitable (${src})` };
  return { ok: true, evidencePath: `${coll}[]`, view: {
    kind: 'table', id: viewId, title: req.title, queryId, requirementIds: [req.id],
    bindings: { collection: coll, columns: pick.map((f) => ({ path: f.rel, label: f.rel.split('.')[0].replace(/_/g, ' '), unit: f.unit ?? null, type: f.type === 'time' ? 'time' : f.type === 'number' ? 'number' : f.type === 'boolean' ? 'boolean' : 'string' })) },
  } };
}

function bindFilters(fields: Dataset['fields'], filters: ClauseFilter[] | undefined, src: string): { ok: true; filters: { path: string; op: ClauseFilter['op']; value?: ClauseFilter['value'] }[] } | { ok: false; reason: string } {
  const out = [];
  for (const w of filters ?? []) {
    const numeric = w.op === 'gt' || w.op === 'lt' || w.op === 'gte' || w.op === 'lte' || w.op === 'between';
    const roles: FieldContract['role'][] = w.op === 'current_month' ? ['time'] : numeric ? ['measure', 'dimension', 'state', 'text'] : ['dimension', 'state', 'text', 'identifier', 'measure'];
    const f = matchField(fields, w.field, roles);
    if (!f) return { ok: false, reason: `champ de filtre « ${w.field[0]} » absent (${src})` };
    out.push({ path: f.rel, op: w.op, ...(w.value !== undefined ? { value: w.value } : {}) });
  }
  return { ok: true, filters: out };
}

/** Une collection n'est une SÉRIE TEMPORELLE que si son horodatage varie vraiment (pas un instantané horodaté). */
export function isSeries(ds: Dataset): { time: Dataset['fields'][number] } | null {
  const time = ds.fields.find((f) => f.role === 'time');
  if (!time || !ds.collection) return null;
  const rows = getCollection(ds.acq.raw, ds.collection) ?? [];
  const ts = rows.map((r) => parseTime(getPath(r, time.rel))).filter((t): t is number => t !== null).sort((a, b) => a - b);
  if (ts.length < 3) return null;
  const distinct = new Set(ts).size;
  const steps = ts.slice(1).map((t, i) => t - ts[i]).filter((d) => d > 0).sort((a, b) => a - b);
  const median = steps[Math.floor(steps.length / 2)] ?? 0;
  return distinct / ts.length >= 0.8 && median >= 60_000 ? { time } : null;
}

/** Exigences génériques pour un MCP inédit ou un fichier joint : déduites du contrat, jamais d'un texte. */
export function genericReqs(ds: Dataset): ReqTemplate[] {
  const tool = ds.acq.ref.tool.name;
  const kw = [norm(tool)];
  const out: ReqTemplate[] = [];
  if (ds.docOnly || ds.acq.envelope.status === 'error') return [{ id: `donnees_${out.length}`, label: `données de ${tool}`, mandatory: true, tool: kw, view: 'table', title: tool }];
  const measures = ds.fields.filter((f) => f.role === 'measure' && !/(^|\.)(id|rang|rank)$/.test(norm(f.rel))).slice(0, 4);
  const slug = (s: string) => norm(s).replace(/[^a-z0-9]+/g, '_').slice(0, 30);
  const lbl = (m: { rel: string }) => (ds.collection ? m.rel.split('.')[0] : m.rel.replace(/\.(valeur|value)$/, '')).replace(/_(eur|usd|gbp|chf|jpy)$/, '').replace(/[._]/g, ' ');
  if (!ds.collection) {
    for (const m of measures.slice(0, 3)) out.push({ id: `${slug(m.rel)}_${out.length}`, label: lbl(m), mandatory: true, tool: kw, view: 'kpi', measure: [norm(m.rel)], title: lbl(m) });
    return out;
  }
  const series = isSeries(ds);
  if (series) {
    for (const m of measures.slice(0, 3)) out.push({ id: `${slug(m.rel)}_${out.length}`, label: lbl(m), mandatory: true, tool: kw, view: 'kpi', measure: [norm(m.rel)], agg: 'last', title: `${lbl(m)} (dernière)` });
    if (measures.length) out.push({ id: `courbe_${out.length}`, label: 'évolution dans le temps', mandatory: true, tool: kw, view: 'line', time: [norm(series.time.rel)], series: measures.slice(0, 2).map((m) => [norm(m.rel)]), title: 'Évolution' });
  } else {
    // instantané : nombre d'éléments, totaux des seules mesures additives, classement par la première mesure
    out.push({ id: `elements_${out.length}`, label: 'nombre d’éléments', mandatory: true, tool: kw, view: 'kpi', agg: 'count', title: 'Éléments' });
    const additive = measures.filter((m) => !NON_ADDITIVE.test(norm(m.rel)));
    for (const m of additive.slice(0, 2)) out.push({ id: `${slug(m.rel)}_${out.length}`, label: `total ${lbl(m)}`, mandatory: true, tool: kw, view: 'kpi', measure: [norm(m.rel)], agg: 'sum', title: `Total ${lbl(m)}` });
    const label = ds.fields.find((f) => /^(nom|name|libelle|titre|title)$/.test(norm(f.rel))) ?? ds.fields.find((f) => f.role === 'dimension' || f.role === 'identifier');
    const rankBy = additive[0] ?? measures[0];
    if (label && rankBy) out.push({ id: `classement_${out.length}`, label: `classement par ${lbl(rankBy)}`, mandatory: true, tool: kw, view: 'ranking', measure: [norm(rankBy.rel)], label_: [norm(label.rel)], ...(NON_ADDITIVE.test(norm(rankBy.rel)) ? {} : { agg: 'sum' as const }), title: `Classement · ${lbl(rankBy)}` });
  }
  out.push({ id: `detail_${out.length}`, label: `détail de ${tool}`, mandatory: true, tool: kw, view: 'table', title: 'Détail' });
  return out;
}
