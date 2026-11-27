import { fenceUntrusted, getCollection, getPath } from '@formule/contracts';
import { llm } from '../llm.js';
import { norm, type ReqTemplate, type Understanding } from './lexicon.js';
import type { PlannedReq } from './plan.js';
import { isSeries, resolveRequirement, type Dataset } from './resolve.js';

/** Un point proposé par le modèle. Il ne devient un lien d'application que s'il touche une donnée lue. */
export interface PromptPoint { text: string; lookFor: string[]; confidence: number }

const SYSTEM = `Tu décomposes une consigne en points. Tu ne décides pas des permissions et tu n'inventes aucune donnée.
Chaque point est une phrase courte de la demande.
lookFor : 1 à 6 mots copiés depuis les champs ou les valeurs réelles fournis, jamais un champ absent.
confidence : ta certitude entre 0 et 1 que ce point parle de ces données.
Réponds en JSON : {"title": str, "points": [{"text": str, "lookFor": [str], "confidence": number}]}`;

function hit(hay: string, needle: string) {
  const h = norm(hay);
  const n = norm(needle);
  return n.length > 2 && h.length > 2 && (h.includes(n) || n.includes(h));
}

/** Le modèle propose les points. Sans modèle, ou sans données, rien n'est inventé. */
export async function draftPoints(prompt: string, datasets: Map<string, Dataset>): Promise<{ title: string; points: PromptPoint[] } | null> {
  if (llm.name === 'mock') return null;
  const catalogue = [...datasets.entries()].flatMap(([qid, ds]) => {
    if (ds.acq.envelope.status === 'error' || ds.docOnly) return [];
    const rows = ds.collection ? (getCollection(ds.acq.raw, ds.collection) ?? []).slice(0, 12) : [ds.acq.raw];
    return ds.fields.slice(0, 24).map((f) => {
      const samples = rows.map((r) => getPath(r, f.rel)).filter((v) => v !== null && v !== undefined && v !== '').slice(0, 4).map((v) => String(v).slice(0, 40));
      return `${qid} · ${f.rel} (${f.role}${f.unit ? `, ${f.unit}` : ''}) : ${samples.join(', ')}`;
    });
  });
  if (!catalogue.length) return null;
  const out = await llm.json<{ title?: string; points?: { text?: string; lookFor?: unknown; confidence?: number }[] }>([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Consigne : ${prompt}\n\nDonnées lues :\n${fenceUntrusted('champs', catalogue.join('\n'))}` },
  ]);
  const points = (out?.points ?? []).flatMap((p) => {
    const text = String(p.text ?? '').trim();
    const lookFor = (Array.isArray(p.lookFor) ? p.lookFor : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 6);
    if (!text || !lookFor.length) return [];
    const confidence = typeof p.confidence === 'number' && p.confidence >= 0 && p.confidence <= 1 ? p.confidence : 0.5;
    return [{ text: text.slice(0, 180), lookFor, confidence }];
  }).slice(0, 12);
  if (!points.length) return null;
  return { title: String(out?.title ?? '').slice(0, 80), points };
}

/**
 * Chaque point n'est lié que s'il rencontre un champ ou une valeur réellement lus.
 * La liste liée est le contrat de l'application : un point sans donnée reste non couvert, sans vue inventée.
 */
export function matchPoints(points: PromptPoint[], datasets: Map<string, Dataset>): PlannedReq[] {
  const out: PlannedReq[] = [];
  const used = new Set<string>();
  points.forEach((point, i) => {
    const id = unique(used, norm(point.text).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 32) || `point_${i + 1}`);
    const best = bestLink(point, datasets);
    const base = { id, label: point.text.slice(0, 120), mandatory: true as const, title: point.text.slice(0, 80) };
    if (!best) {
      out.push({ tpl: { ...base, tool: ['*'], view: 'table' }, status: 'unavailable', reason: `aucune donnée lue ne correspond à ce point (certitude ${Math.round(point.confidence * 100)} %)` });
      return;
    }
    const tpl: ReqTemplate = { ...base, ...best.tpl, id, label: base.label, title: base.title, mandatory: true };
    const viewId = unique(used, `v_${id}`.slice(0, 40));
    const resolved = resolveRequirement(tpl, best.ds, viewId, best.qid);
    if (!resolved.ok) {
      out.push({ tpl, status: best.ds.acq.envelope.status === 'error' ? 'unavailable' : 'missing', reason: resolved.reason });
      return;
    }
    out.push({ tpl, status: 'covered', queryId: best.qid, view: resolved.view, evidencePath: resolved.evidencePath, envelopeId: best.ds.acq.envelope.id });
  });
  return out;
}

/** Propose les points puis ne garde un lien que là où les données confirment. */
export async function linkPrompt(prompt: string, datasets: Map<string, Dataset>): Promise<{ u: Understanding; planned: PlannedReq[] } | null> {
  const draft = await draftPoints(prompt, datasets);
  if (!draft) return null;
  const planned = matchPoints(draft.points, datasets);
  if (!planned.length) return null;
  const u: Understanding = {
    title: draft.title || prompt.slice(0, 60),
    mission: prompt.slice(0, 300),
    reqs: planned.map((p) => p.tpl),
    commands: [],
    simulation: false,
    generic: false,
  };
  return { u, planned };
}

function bestLink(point: PromptPoint, datasets: Map<string, Dataset>): { qid: string; ds: Dataset; tpl: Omit<ReqTemplate, 'id' | 'label' | 'mandatory' | 'title'> } | null {
  let found: { qid: string; ds: Dataset; score: number; measure?: Dataset['fields'][number]; label?: Dataset['fields'][number]; entities: string[] } | null = null;
  for (const [qid, ds] of datasets) {
    if (ds.acq.envelope.status === 'error' || ds.docOnly || !ds.fields.length) continue;
    const rows = ds.collection ? (getCollection(ds.acq.raw, ds.collection) ?? []) : [];
    let measure: Dataset['fields'][number] | undefined;
    let measureScore = 0;
    let label: Dataset['fields'][number] | undefined;
    let labelScore = 0;
    const entities = new Set<string>();
    for (const f of ds.fields) {
      const fieldHits = point.lookFor.filter((w) => hit(f.rel, w)).length;
      if (f.role === 'measure' && fieldHits > measureScore) { measure = f; measureScore = fieldHits; }
      if ((f.role === 'dimension' || f.role === 'text' || f.role === 'identifier') && fieldHits > labelScore) { label = f; labelScore = fieldHits; }
      if (f.role !== 'measure' && f.role !== 'time') {
        for (const row of rows.slice(0, 40)) {
          const v = getPath(row, f.rel);
          if (typeof v !== 'string') continue;
          for (const w of point.lookFor) if (hit(v, w)) entities.add(v);
        }
      }
    }
    const score = measureScore * 3 + labelScore * 2 + Math.min(entities.size, 3);
    if (score > 0 && (!found || score > found.score)) found = { qid, ds, score, measure, label, entities: [...entities].slice(0, 8) };
  }
  if (!found) return null;
  if (!found.label && found.entities.length) {
    const rows = found.ds.collection ? (getCollection(found.ds.acq.raw, found.ds.collection) ?? []) : [];
    found.label = found.ds.fields.find((f) => f.role !== 'measure' && f.role !== 'time' && rows.some((r) => found!.entities.includes(String(getPath(r, f.rel)))));
  }
  const tool = [norm(found.ds.acq.ref.tool.name)];
  const series = isSeries(found.ds);
  const measureKw = found.measure ? [norm(found.measure.rel.split('.').pop() ?? found.measure.rel)] : undefined;
  const labelKw = found.label ? [norm(found.label.rel.split('.').pop() ?? found.label.rel)] : undefined;
  if (series && found.measure) {
    return { qid: found.qid, ds: found.ds, tpl: { tool, view: 'line', measure: measureKw, time: [norm(series.time.rel.split('.').pop() ?? series.time.rel)], series: [measureKw!] } };
  }
  const rows = found.ds.collection ? (getCollection(found.ds.acq.raw, found.ds.collection) ?? []).length : 0;
  if (rows > 1 && (found.label || found.entities.length) && found.measure) {
    return { qid: found.qid, ds: found.ds, tpl: { tool, view: 'ranking', measure: measureKw, label_: labelKw ?? [norm(found.label?.rel.split('.').pop() ?? 'nom')], agg: 'sum' } };
  }
  const where = found.entities.length === 1 && found.label ? [{ field: labelKw ?? [norm(found.label.rel)], op: 'eq' as const, value: found.entities[0] }] : undefined;
  if (found.measure) return { qid: found.qid, ds: found.ds, tpl: { tool, view: 'kpi', measure: measureKw, agg: series ? 'last' : 'sum', where } };
  if (found.ds.collection) return { qid: found.qid, ds: found.ds, tpl: { tool, view: 'table' } };
  return null;
}

function unique(used: Set<string>, base: string) {
  let id = base || 'point';
  let n = 2;
  while (used.has(id)) id = `${base.slice(0, 28)}_${n++}`;
  used.add(id);
  return id;
}
