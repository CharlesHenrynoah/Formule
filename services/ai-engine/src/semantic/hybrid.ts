/**
 * Moteur hybride : l'IA comprend et propose ; le code valide et exécute.
 * Deux appels principaux + une correction optionnelle. Repli déterministe si mock / JSON invalide.
 */
import { fenceUntrusted, getCollection, getPath } from '@formule/contracts';
import { z } from 'zod';
import { llm } from '../llm.js';
import type { CatalogServer } from '../discovery/catalog.js';
import { AGGS, VIEW_KINDS, norm, titleFrom, type ClauseFilter, type ReqTemplate, type Understanding, type ViewKind } from './lexicon.js';
import { capRequirements, freezeReqs, readContract } from './analytical.js';
import type { Dataset } from './resolve.js';
import type { PlannedReq } from './plan.js';

const FilterSchema = z.object({
  field: z.array(z.string().min(1).max(40)).min(1).max(6),
  op: z.enum(['eq', 'neq', 'current_month', 'gt', 'lt', 'gte', 'lte', 'in', 'between']),
  value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()])).max(12)]).optional(),
});

/** Appel 1 — interprétation + planification. */
export const InterpretPlanSchema = z.object({
  title: z.string().min(1).max(80),
  mission: z.string().min(1).max(400),
  design: z.array(z.string().max(120)).max(12).optional(),
  requirements: z.array(z.object({
    label: z.string().min(1).max(120),
    visualization: z.enum(VIEW_KINDS).optional(),
    operation: z.enum(AGGS).optional(),
    measures: z.array(z.string().min(1).max(40)).max(6).optional(),
    entities: z.array(z.string().min(1).max(40)).max(12).optional(),
    population: z.string().max(120).optional(),
    period: z.string().max(40).optional(),
    grain: z.string().max(20).optional(),
    unit: z.string().max(20).optional(),
    transform: z.enum(['base100']).optional(),
    filters: z.array(FilterSchema).max(4).optional(),
    toolHints: z.array(z.string().min(1).max(60)).max(6).optional(),
    argHints: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    certainty: z.enum(['certain', 'hypothesis']).optional(),
    section: z.string().max(40).optional(),
    limit: z.number().int().min(1).max(50).optional(),
    order: z.enum(['asc', 'desc']).optional(),
  })).min(1).max(40),
});
export type InterpretPlan = z.infer<typeof InterpretPlanSchema>;

/** Appel 2 — données + liaison + composition. */
export const BindComposeSchema = z.object({
  bindings: z.array(z.object({
    requirementId: z.string().min(1).max(40),
    queryId: z.string().max(40).optional(),
    measure: z.string().max(80).optional(),
    label: z.string().max(80).optional(),
    operation: z.enum(AGGS).optional(),
    visualization: z.enum(VIEW_KINDS).optional(),
    transform: z.enum(['base100']).optional(),
    filters: z.array(FilterSchema).max(4).optional(),
    unsatisfied: z.boolean().optional(),
    reason: z.string().max(200).optional(),
    section: z.string().max(40).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })).max(40),
  layout: z.array(z.object({
    requirementId: z.string().max(40),
    section: z.string().max(40).optional(),
    order: z.number().int().min(0).max(100).optional(),
  })).max(40).optional(),
});
export type BindCompose = z.infer<typeof BindComposeSchema>;

/** Appel 3 — correction ciblée. */
export const CorrectionSchema = z.object({
  dropRequirementIds: z.array(z.string().max(40)).max(20).optional(),
  rebind: z.array(z.object({
    requirementId: z.string().max(40),
    queryId: z.string().max(40).optional(),
    measure: z.string().max(80).optional(),
    operation: z.enum(AGGS).optional(),
    reason: z.string().max(200).optional(),
  })).max(20).optional(),
  note: z.string().max(300).optional(),
});
export type Correction = z.infer<typeof CorrectionSchema>;

export interface HybridPlan {
  u: Understanding;
  toolHints: Map<string, string[]>;
  argHints: Map<string, Record<string, unknown>>;
  source: 'llm' | 'deterministic';
}

const CALL_A_SYSTEM = `Tu es le moteur d'interprétation Formule. Tu CONSTRUIS le contrat analytique intégral à partir du prompt.
Tu ne corriges pas un contrat préexistant : tu es la source de vérité sémantique.

Règles strictes :
1. title = nom de marque / titre explicite s'il est entre guillemets, après « Title: » / « Titre: », ou en titre markdown. Jamais la première phrase tronquée du prompt.
2. Une exigence = une intention atomique (une visualisation + une opération). Ne fusionne pas deux classements, un tableau et une courbe.
3. entities = noms propres courts uniquement (ex. Bitcoin, Ethereum). Jamais une phrase, jamais une clause entière.
4. measures = concepts de champ métier (market_cap, price, volume, supply…). Jamais des mots grammaticaux français (permets, avec, pour, montre, crée…).
5. Si le prompt demande N éléments (« trois », « 3 », « top 5 ») : limit=N et filtre entities si listées.
6. Comparaison « base 100 » / « rebase » / « indexé » → transform=base100 sur la/les courbes concernées.
7. Classements (meilleures / pires performances) → visualization=ranking, order desc/asc, limit explicite.
8. toolHints = outils de DONNÉES du catalogue. Évite search_docs / documentation sauf si la consigne demande explicitement de la doc.
9. certainty=hypothesis pour toute hypothèse. Tu n'exécutes rien. JSON uniquement.`;

/** Appel 1 : interprétation sémantique + plan d'outils. Repli = readContract. */
export async function interpretAndPlan(prompt: string, catalog: CatalogServer[], base: Understanding): Promise<HybridPlan> {
  const fallback = (): HybridPlan => {
    const reqs = !base.generic && base.reqs.length ? freezeReqs(capRequirements(base.reqs)) : readContract(prompt);
    const u: Understanding = reqs.length
      ? { ...base, title: titleFrom(prompt) || base.title, mission: prompt.slice(0, 300), reqs, generic: false, simulation: reqs.some((r) => r.view === 'simulation') || base.simulation }
      : base;
    return { u, toolHints: new Map(), argHints: new Map(), source: 'deterministic' };
  };
  if (llm.name === 'mock') return fallback();

  const tools = catalog.flatMap((s) => s.tools.filter((t) => t.permission === 'read').map((t) => ({
    server: s.name, tool: t.name, description: (t.description ?? '').slice(0, 160),
    required: t.inputSchema?.required ?? [],
    docs: /search_docs|documentation|readme/i.test(t.name),
  }))).slice(0, 40);

  const raw = await llm.json<unknown>([
    { role: 'system', content: CALL_A_SYSTEM },
    { role: 'user', content: `Consigne :\n${fenceUntrusted('demande', prompt, 6000)}\n\nCatalogue lecture (docs=true = documentation, à éviter pour les données) :\n${fenceUntrusted('outils', JSON.stringify(tools), 5000)}\n\nSchéma : {"title","mission","design?","requirements":[{"label","visualization?","operation?","measures?","entities?","population?","period?","grain?","unit?","transform?","filters?","toolHints?","argHints?","certainty?","section?","limit?","order?"}]}` },
  ], 60_000).catch(() => null);

  const parsed = InterpretPlanSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.requirements.length) return fallback();

  const design = parsed.data.design?.join(' | ').slice(0, 200);
  const reqs = freezeReqs(capRequirements(parsed.data.requirements.map((r, i) => aiReqToTpl(r, i, design))));
  const toolHints = new Map<string, string[]>();
  const argHints = new Map<string, Record<string, unknown>>();
  parsed.data.requirements.forEach((r, i) => {
    const id = reqs[i]?.id;
    if (!id) return;
    const hints = (r.toolHints ?? []).map(norm).filter((h) => !/search_docs|documentation|readme/.test(h));
    if (hints.length) toolHints.set(id, hints);
    else if (r.toolHints?.length) toolHints.set(id, r.toolHints.map(norm));
    if (r.argHints && Object.keys(r.argHints).length) argHints.set(id, r.argHints);
  });

  return {
    u: {
      title: parsed.data.title.slice(0, 80),
      mission: parsed.data.mission.slice(0, 400),
      reqs,
      commands: base.commands,
      simulation: reqs.some((r) => r.view === 'simulation') || base.simulation,
      generic: false,
    },
    toolHints,
    argHints,
    source: 'llm',
  };
}

function aiReqToTpl(r: InterpretPlan['requirements'][number], index: number, design?: string): ReqTemplate {
  const view = (r.visualization ?? 'kpi') as ViewKind;
  const agg = r.operation;
  const filters = r.filters as ClauseFilter[] | undefined;
  const id = `${norm(r.label).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 28) || 'req'}_${index + 1}`.slice(0, 40);
  const measures = r.measures?.map(norm).filter((m) => m.length > 1 && !/^(permets?|montre|creer?|avec|pour|dans|cette|tout)$/.test(m));
  // Entités : max 40 car., pas de phrase.
  const entities = r.entities?.map((e) => e.trim()).filter((e) => e.length >= 2 && e.length <= 40 && !/\s{2,}/.test(e) && e.split(/\s+/).length <= 3);
  return {
    id, label: r.label.slice(0, 120), mandatory: r.certainty !== 'hypothesis', tool: r.toolHints?.length ? r.toolHints.map(norm) : ['*'],
    title: r.label.slice(0, 80), view, visualization: view,
    measure: measures, measures, agg, operation: agg,
    where: filters, filters,
    denWhere: agg === 'ratio' ? [] : undefined,
    percent: agg === 'ratio',
    entities, population: r.population, period: r.period, grain: r.grain, unit: r.unit,
    transform: r.transform, limit: r.limit, order: r.order, section: r.section, design,
    label_: view === 'ranking' || view === 'donut' || view === 'bars' || view === 'table' ? ['nom', 'name', 'libelle', 'categorie', 'symbol', 'id'] : undefined,
    dimensions: view === 'ranking' || view === 'donut' || view === 'bars' || view === 'table' ? ['nom', 'name', 'libelle', 'categorie', 'symbol'] : undefined,
    acceptance: [
      view, agg ? `op:${agg}` : null, r.transform ? `transform:${r.transform}` : null,
      r.certainty === 'hypothesis' ? 'hypothèse' : null,
      filters?.length ? `filtre:${filters.map((f) => f.op).join(',')}` : null,
      entities?.length ? `entite:${entities.join(',')}` : null,
      r.population ? `pop:${r.population}` : null, r.period ? `periode:${r.period}` : null,
      r.limit != null ? `limit:${r.limit}` : null,
    ].filter(Boolean).join(' · ').slice(0, 300),
  };
}

/** Appel 2 : comprendre les données lues, proposer liaisons et composition. */
export async function bindAndCompose(
  prompt: string,
  reqs: ReqTemplate[],
  datasets: Map<string, Dataset>,
): Promise<{ reqs: ReqTemplate[]; source: 'llm' | 'deterministic' }> {
  if (llm.name === 'mock' || !reqs.length || !datasets.size) return { reqs, source: 'deterministic' };

  const catalogue = [...datasets.entries()].flatMap(([qid, ds]) => {
    if (ds.acq.envelope.status === 'error' || ds.docOnly) return [];
    const rows = ds.collection ? (getCollection(ds.acq.raw, ds.collection) ?? []).slice(0, 8) : [ds.acq.raw];
    const fields = ds.fields.slice(0, 24).map((f) => {
      const samples = rows.map((r) => getPath(r, f.rel)).filter((v) => v !== null && v !== undefined && v !== '').slice(0, 3).map((v) => String(v).slice(0, 40));
      return { path: f.rel, role: f.role, unit: f.unit, samples };
    });
    return [{ queryId: qid, tool: ds.acq.ref.tool.name, server: ds.acq.ref.serverName, rowCount: ds.collection ? (getCollection(ds.acq.raw, ds.collection) ?? []).length : 1, fields }];
  });
  if (!catalogue.length) return { reqs, source: 'deterministic' };

  const raw = await llm.json<unknown>([
    { role: 'system', content: `Tu liais un contrat analytique à des données MCP déjà lues.
Tu identifies le sens métier des champs (pas seulement les noms), la mesure, les filtres, l'opération et le dataset.
Respecte limit et entities du contrat. Si « trois cryptos » → filtre in à 3 entités, pas un top 20.
transform=base100 si le contrat le demande. Aucune substitution silencieuse. unsatisfied=true + reason si impossible.
JSON uniquement.` },
    { role: 'user', content: `Consigne : ${fenceUntrusted('demande', prompt, 3000)}
Exigences : ${JSON.stringify(reqs.map((r) => ({ id: r.id, label: r.label, view: r.view, operation: r.operation ?? r.agg, measures: r.measures ?? r.measure, entities: r.entities, population: r.population, period: r.period, unit: r.unit, transform: r.transform, limit: r.limit, filters: r.filters ?? r.where })))}
Données (échantillons) : ${fenceUntrusted('donnees', JSON.stringify(catalogue), 8000)}
Schéma : {"bindings":[{"requirementId","queryId?","measure?","label?","operation?","visualization?","transform?","filters?","limit?","unsatisfied?","reason?","section?"}],"layout?":[{"requirementId","section?","order?"}]}` },
  ], 60_000).catch(() => null);

  const parsed = BindComposeSchema.safeParse(raw);
  if (!parsed.success) return { reqs, source: 'deterministic' };

  const byId = new Map(parsed.data.bindings.map((b) => [b.requirementId, b]));
  const layout = new Map((parsed.data.layout ?? []).map((l) => [l.requirementId, l]));
  const knownQ = new Set(datasets.keys());

  const next = reqs.map((r) => {
    const b = byId.get(r.id);
    if (!b) return r;
    if (b.unsatisfied) return { ...r, acceptance: `${r.acceptance ?? ''} · IA: ${b.reason ?? 'insatisfaite'}`.slice(0, 300) };
    const ds = b.queryId && knownQ.has(b.queryId) ? datasets.get(b.queryId) : undefined;
    const measureOk = b.measure && ds ? ds.fields.some((f) => {
      const rel = norm(f.rel);
      const m = norm(b.measure!);
      return rel === m || rel.endsWith('.' + m) || rel.split(/[._]/).pop() === m;
    }) : false;
    const measures = measureOk && b.measure ? [...new Set([b.measure, ...(r.measures ?? r.measure ?? [])].map(norm))] : r.measures ?? r.measure;
    const view = (b.visualization && VIEW_KINDS.includes(b.visualization) ? b.visualization : r.visualization ?? r.view) as ViewKind;
    const op = b.operation ?? r.operation ?? r.agg;
    const filters = (b.filters as ClauseFilter[] | undefined) ?? r.filters ?? r.where;
    const section = layout.get(r.id)?.section ?? b.section ?? r.section;
    const tool = b.queryId && ds ? [norm(ds.acq.ref.tool.name)] : r.tool;
    const transform = b.transform ?? r.transform;
    const limit = b.limit ?? r.limit;
    return freezeOne({
      ...r, view, visualization: view, operation: op, agg: op,
      measure: measures, measures, filters, where: filters, tool, section, transform, limit,
      label_: b.label ? [norm(b.label)] : r.label_,
      acceptance: r.acceptance,
    });
  });

  return { reqs: freezeReqs(next), source: 'llm' };
}

function freezeOne(r: ReqTemplate): ReqTemplate {
  return Object.freeze({ ...r }) as ReqTemplate;
}

/** Appel 3 : diagnostic ciblé après divergence. Une seule tentative côté orchestrateur. */
export async function diagnoseCorrection(
  prompt: string,
  planned: PlannedReq[],
  divergences: string[],
): Promise<Correction | null> {
  if (llm.name === 'mock' || !divergences.length) return null;
  const raw = await llm.json<unknown>([
    { role: 'system', content: 'Tu diagnostiques une divergence Formule. Propose une correction minimale (dropRequirementIds ou rebind). Pas de nouvel appel MCP. JSON uniquement.' },
    { role: 'user', content: `Consigne : ${fenceUntrusted('demande', prompt, 2000)}
Exigences : ${JSON.stringify(planned.map((p) => ({ id: p.tpl.id, label: p.tpl.label, status: p.status, reason: p.reason, view: p.tpl.view, op: p.tpl.operation ?? p.tpl.agg })))}
Divergences : ${fenceUntrusted('divergences', divergences.join('\n'), 2000)}
Schéma : {"dropRequirementIds?":[str],"rebind?":[{"requirementId","queryId?","measure?","operation?","reason?"}],"note?"}` },
  ], 45_000).catch(() => null);
  const parsed = CorrectionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Applique une correction validée sur les exigences, sans toucher aux serveurs limités. */
export function applyCorrection(reqs: ReqTemplate[], correction: Correction, allowedQueryIds: Set<string>): ReqTemplate[] {
  const drop = new Set(correction.dropRequirementIds ?? []);
  const rebind = new Map((correction.rebind ?? []).map((r) => [r.requirementId, r]));
  return freezeReqs(reqs.filter((r) => !drop.has(r.id)).map((r) => {
    const b = rebind.get(r.id);
    if (!b) return r;
    if (b.queryId && !allowedQueryIds.has(b.queryId)) return r;
    return {
      ...r,
      measure: b.measure ? [norm(b.measure)] : r.measure,
      measures: b.measure ? [norm(b.measure)] : r.measures,
      operation: b.operation ?? r.operation,
      agg: b.operation ?? r.agg,
      acceptance: `${r.acceptance ?? ''} · corr:${b.reason ?? 'rebind'}`.slice(0, 300),
    };
  }));
}
