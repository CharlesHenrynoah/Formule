/**
 * Moteur AI-first : le LLM construit le contrat ; le code valide et exécute.
 * Les regex ne déterminent plus intentions, entités, mesures ni découpe.
 * Échec LLM → signal explicite, jamais un contrat syntaxique présenté comme équivalent.
 */
import { fenceUntrusted, getCollection, getPath } from '@formule/contracts';
import { z } from 'zod';
import { llm } from '../llm.js';
import type { CatalogServer } from '../discovery/catalog.js';
import { AGGS, VIEW_KINDS, norm, type ClauseFilter, type ReqTemplate, type Understanding, type ViewKind } from './lexicon.js';
import { capRequirements, freezeReqs } from './analytical.js';
import {
  exactFieldMatch, filterForbiddenDrops, LlmBudget, sealContract, separateNonAnalytical,
  type ContractConstraints, type SealedContract,
} from './contract-guard.js';
import type { Dataset } from './resolve.js';
import type { PlannedReq } from './plan.js';

export { LlmBudget, sealContract };
export type { ContractConstraints, SealedContract };

const FilterSchema = z.object({
  field: z.array(z.string().min(1).max(40)).min(1).max(6),
  op: z.enum(['eq', 'neq', 'current_month', 'gt', 'lt', 'gte', 'lte', 'in', 'between']),
  value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()])).max(12)]).optional(),
});

const ReqSchema = z.object({
  id: z.string().min(1).max(40).optional(),
  label: z.string().min(1).max(120),
  kind: z.enum(['analytical', 'note']).default('analytical'),
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
  covers: z.array(z.string().max(120)).max(6).optional(),
});

const AcquisitionGroupSchema = z.object({
  id: z.string().min(1).max(40),
  purpose: z.string().max(160).optional(),
  entity: z.string().max(40).optional(),
  forRequirementIds: z.array(z.string().max(40)).min(1).max(20),
  toolHints: z.array(z.string().min(1).max(60)).max(6).optional(),
  argHints: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  dataNotDocs: z.boolean().default(true),
});

/** Appel 1 — contrat sémantique intégral. */
export const InterpretPlanSchema = z.object({
  title: z.string().min(1).max(80),
  mission: z.string().min(1).max(400),
  /** Points du prompt original qui doivent apparaître dans le contrat (couverture). */
  coverage: z.array(z.string().min(1).max(160)).min(1).max(40),
  constraints: z.object({
    global: z.array(z.string().max(160)).max(20).optional(),
    design: z.array(z.string().max(160)).max(20).optional(),
    interactions: z.array(z.string().max(160)).max(20).optional(),
    reliability: z.array(z.string().max(160)).max(20).optional(),
  }).optional(),
  requirements: z.array(ReqSchema).min(1).max(40),
  /** Groupes d'acquisition : mutualisation + décomposition multi-entités. */
  acquisitions: z.array(AcquisitionGroupSchema).max(40).optional(),
});
export type InterpretPlan = z.infer<typeof InterpretPlanSchema>;
export type AcquisitionGroup = z.infer<typeof AcquisitionGroupSchema>;

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

/** Appel 3 — correction de contrat (avant nouvelles acquisitions) ou rebind. */
export const CorrectionSchema = z.object({
  dropRequirementIds: z.array(z.string().max(40)).max(20).optional(),
  rebind: z.array(z.object({
    requirementId: z.string().max(40),
    queryId: z.string().max(40).optional(),
    measure: z.string().max(80).optional(),
    operation: z.enum(AGGS).optional(),
    reason: z.string().max(200).optional(),
  })).max(20).optional(),
  patchRequirements: z.array(ReqSchema).max(20).optional(),
  note: z.string().max(300).optional(),
});
export type Correction = z.infer<typeof CorrectionSchema>;

export type DraftSource = 'llm' | 'demo_pack' | 'unavailable';

export interface HybridPlan {
  ok: boolean;
  u: Understanding;
  toolHints: Map<string, string[]>;
  argHints: Map<string, Record<string, unknown>>;
  acquisitions: AcquisitionGroup[];
  coverage: string[];
  constraints: ContractConstraints;
  source: DraftSource;
  reason?: string;
  sealed?: SealedContract;
}

const CALL_A_SYSTEM = `Tu es le moteur d'interprétation Formule (AI-first). Tu produis le contrat analytique COMPLET depuis le prompt original.
Tu es la seule source d'intentions. Aucune regex ne t'a précédé.

Distingue clairement :
- requirements (analytiques / note)
- constraints.global (périmètre, population partagée, période globale)
- constraints.design (couleurs, layout, thème)
- constraints.interactions (onglets, curseurs, boutons)
- constraints.reliability (rafraîchissement, sources, avertissements)
- coverage : chaque intention du prompt (une ligne courte), y compris apostrophes et demandes composées
- acquisitions : groupes mutualisés ; décompose multi-entités si un outil ne prend qu'une entité à la fois ; dataNotDocs=true pour les données

Règles :
1. title = marque / titre explicite (guillemets, Title:, markdown). Pas la première phrase tronquée.
2. Une exigence atomique = une visualisation + une opération. Ne fusionne pas classements distincts.
3. entities = noms propres courts. Jamais une phrase.
4. measures = concepts métier, jamais des mots grammaticaux.
5. Populations partagées → constraints.global + population sur chaque exigence concernée.
6. Comparaison multi-entités / base 100 → transform=base100, entities listées, acquisitions décomposées si besoin.
7. toolHints = outils de DONNÉES. search_docs / documentation uniquement si demandé.
8. covers[] sur chaque exigence pointe vers des entrées de coverage.
9. JSON uniquement. Tu n'exécutes rien.`;

function emptyConstraints() {
  return { global: [] as string[], design: [] as string[], interactions: [] as string[], reliability: [] as string[] };
}

function unavailable(reason: string, base: Understanding): HybridPlan {
  return {
    ok: false, u: base, toolHints: new Map(), argHints: new Map(), acquisitions: [],
    coverage: [], constraints: emptyConstraints(), source: 'unavailable', reason,
  };
}

/** Appel 1 : contrat depuis le prompt. Pas de repli syntaxique équivalent. */
export async function interpretAndPlan(prompt: string, catalog: CatalogServer[], base: Understanding): Promise<HybridPlan> {
  // Mode démo sans LLM : packs explicites seulement, jamais readContract présenté comme succès.
  if (llm.name === 'mock') {
    if (!base.generic && base.reqs.length) {
      const reqs = freezeReqs(capRequirements(base.reqs));
      const coverage = reqs.map((r) => r.label);
      const constraints = emptyConstraints();
      const sealed = sealContract(prompt, reqs, coverage, constraints);
      return {
        ok: true,
        u: { ...base, reqs: sealed.reqs },
        toolHints: new Map(), argHints: new Map(), acquisitions: [],
        coverage: sealed.coverage,
        constraints: sealed.constraints,
        source: 'demo_pack',
        reason: 'mode démo : contrat pack, pas d’interprétation sémantique LLM',
        sealed,
      };
    }
    return unavailable('Interprétation sémantique indisponible (aucun LLM configuré). Le moteur syntaxique n’est plus utilisé comme équivalent.', base);
  }

  const tools = catalog.flatMap((s) => s.tools.filter((t) => t.permission === 'read').map((t) => ({
    server: s.name, tool: t.name, description: (t.description ?? '').slice(0, 160),
    required: t.inputSchema?.required ?? [],
    kind: /search_docs|documentation|readme|^docs?$/i.test(t.name) ? 'docs' : 'data',
  }))).slice(0, 48);

  const raw = await llm.json<unknown>([
    { role: 'system', content: CALL_A_SYSTEM },
    { role: 'user', content: `Consigne originale (ne la découpe pas lexicalement) :\n${fenceUntrusted('demande', prompt, 7000)}\n\nCatalogue (kind=docs | data) :\n${fenceUntrusted('outils', JSON.stringify(tools), 5000)}\n\nSchéma : {"title","mission","coverage":[str],"constraints?":{"global?","design?","interactions?","reliability?"},"requirements":[{...}],"acquisitions?":[{"id","purpose?","entity?","forRequirementIds","toolHints?","argHints?","dataNotDocs?"}]}` },
  ], 60_000).catch(() => null);

  const parsed = InterpretPlanSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.requirements.length) {
    const detail = parsed.success ? 'contrat vide' : parsed.error.issues.slice(0, 3).map((i) => i.message).join(' ; ');
    return unavailable(`Échec d’interprétation LLM : ${detail}. Aucun contrat syntaxique de substitution.`, base);
  }

  const designNote = [
    ...(parsed.data.constraints?.design ?? []),
    ...(parsed.data.constraints?.interactions ?? []),
  ].join(' | ').slice(0, 200) || undefined;

  const reqs = freezeReqs(capRequirements(parsed.data.requirements.map((r, i) => aiReqToTpl(r, i, designNote))));
  // Stabiliser les ids pour acquisitions.forRequirementIds (index → id généré).
  const idByIndex = new Map(parsed.data.requirements.map((r, i) => [r.id ?? `i${i}`, reqs[i]!.id]));
  parsed.data.requirements.forEach((r, i) => { if (r.id) idByIndex.set(r.id, reqs[i]!.id); idByIndex.set(String(i), reqs[i]!.id); });

  const toolHints = new Map<string, string[]>();
  const argHints = new Map<string, Record<string, unknown>>();
  parsed.data.requirements.forEach((r, i) => {
    const id = reqs[i]?.id;
    if (!id) return;
    const hints = (r.toolHints ?? []).map(norm).filter((h) => !/search_docs|documentation|readme/.test(h));
    if (hints.length) toolHints.set(id, hints);
    if (r.argHints && Object.keys(r.argHints).length) argHints.set(id, r.argHints);
  });

  const acquisitions = (parsed.data.acquisitions ?? []).map((g) => ({
    ...g,
    forRequirementIds: g.forRequirementIds.map((rid) => idByIndex.get(rid) ?? rid).filter((id) => reqs.some((r) => r.id === id)),
  })).filter((g) => g.forRequirementIds.length);

  for (const g of acquisitions) {
    for (const rid of g.forRequirementIds) {
      if (g.toolHints?.length && !toolHints.has(rid)) toolHints.set(rid, g.toolHints.map(norm).filter((h) => !/search_docs|documentation|readme/.test(h)));
      if (g.argHints && Object.keys(g.argHints).length) {
        const merged = { ...(argHints.get(rid) ?? {}), ...g.argHints };
        if (g.entity) {
          for (const [k, v] of Object.entries(merged)) {
            if (typeof v === 'string' && /\$entity|\{entity\}/i.test(v)) merged[k] = v.replace(/\$entity|\{entity\}/gi, g.entity);
          }
          const hasId = Object.keys(merged).some((k) => /id|coin|symbol|asset|slug|name/i.test(k));
          if (!hasId) merged.id = g.entity;
        }
        argHints.set(rid, merged);
      }
    }
  }

  const rawConstraints: ContractConstraints = {
    global: parsed.data.constraints?.global ?? [],
    design: parsed.data.constraints?.design ?? [],
    interactions: parsed.data.constraints?.interactions ?? [],
    reliability: parsed.data.constraints?.reliability ?? [],
  };
  // Séparation stricte : design / interactions / tech ne restent pas des vues analytiques.
  const separated = separateNonAnalytical(reqs, rawConstraints);
  const sealed = sealContract(prompt, separated.reqs, parsed.data.coverage, {
    global: rawConstraints.global,
    design: [...rawConstraints.design, ...separated.movedDesign],
    interactions: [...rawConstraints.interactions, ...separated.movedInteractions],
    reliability: [...rawConstraints.reliability, ...separated.movedTech],
  });

  return {
    ok: true,
    u: {
      title: parsed.data.title.slice(0, 80),
      mission: parsed.data.mission.slice(0, 400),
      reqs: sealed.reqs,
      commands: base.commands,
      simulation: sealed.reqs.some((r) => r.view === 'simulation') || base.simulation,
      generic: false,
    },
    toolHints,
    argHints,
    acquisitions,
    coverage: sealed.coverage,
    constraints: sealed.constraints,
    source: 'llm',
    sealed,
  };
}

function aiReqToTpl(r: z.infer<typeof ReqSchema>, index: number, design?: string): ReqTemplate {
  const view = (r.kind === 'note' ? 'note' : (r.visualization ?? 'kpi')) as ViewKind;
  const agg = r.operation;
  const filters = r.filters as ClauseFilter[] | undefined;
  const id = (r.id?.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40))
    || `${norm(r.label).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 28) || 'req'}_${index + 1}`.slice(0, 40);
  const measures = r.measures?.map(norm).filter((m) => m.length > 1);
  const entities = r.entities?.map((e) => e.trim()).filter((e) => e.length >= 2 && e.length <= 40 && e.split(/\s+/).length <= 3);
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
      entities?.length ? `entite:${entities.join(',')}` : null,
      r.population ? `pop:${r.population}` : null, r.period ? `periode:${r.period}` : null,
      r.limit != null ? `limit:${r.limit}` : null,
      r.covers?.length ? `covers:${r.covers.join('|')}` : null,
    ].filter(Boolean).join(' · ').slice(0, 300),
  };
}

/**
 * Vérifie que chaque point de coverage est porté par au moins une exigence (label / acceptance / covers).
 * Déterministe — ne « invente » pas d'exigences.
 */
export function coverageGaps(coverage: string[], reqs: ReqTemplate[]): string[] {
  if (!coverage.length) return ['coverage vide : le contrat ne déclare aucune intention à couvrir'];
  const blob = (r: ReqTemplate) => norm(`${r.label} ${r.title} ${r.acceptance ?? ''} ${(r.entities ?? []).join(' ')} ${r.population ?? ''} ${r.period ?? ''} ${r.design ?? ''} ${r.transform ?? ''}`);
  return coverage.filter((c) => {
    const n = norm(c);
    const words = n.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
    return !reqs.some((r) => {
      const b = blob(r);
      if (b.includes(n)) return true;
      return words.length > 0 && words.filter((w) => b.includes(w)).length >= Math.min(2, words.length);
    });
  });
}

/** Appel 2 : liaison sémantique proposée ; le moteur valide ensuite (intentions scellées immuables). */
export async function bindAndCompose(
  prompt: string,
  reqs: ReqTemplate[],
  datasets: Map<string, Dataset>,
  opts?: { budget?: LlmBudget; sealed?: SealedContract },
): Promise<{ reqs: ReqTemplate[]; source: 'llm' | 'skipped'; reason?: string }> {
  if (llm.name === 'mock' || !reqs.length || !datasets.size) {
    return { reqs, source: 'skipped', reason: 'liaison IA non disponible — validation déterministe seule' };
  }
  if (opts?.budget && !opts.budget.take()) {
    return { reqs, source: 'skipped', reason: 'budget LLM épuisé — liaison déterministe seule' };
  }

  const catalogue = [...datasets.entries()].flatMap(([qid, ds]) => {
    if (ds.acq.envelope.status === 'error' || ds.docOnly) return [];
    const rows = ds.collection ? (getCollection(ds.acq.raw, ds.collection) ?? []).slice(0, 8) : [ds.acq.raw];
    const fields = ds.fields.slice(0, 24).map((f) => {
      const samples = rows.map((r) => getPath(r, f.rel)).filter((v) => v !== null && v !== undefined && v !== '').slice(0, 3).map((v) => String(v).slice(0, 40));
      return { path: f.rel, role: f.role, unit: f.unit, samples };
    });
    return [{ queryId: qid, tool: ds.acq.ref.tool.name, server: ds.acq.ref.serverName, kind: ds.docOnly ? 'docs' : 'data', rowCount: ds.collection ? (getCollection(ds.acq.raw, ds.collection) ?? []).length : 1, fields }];
  });
  if (!catalogue.length) return { reqs, source: 'skipped', reason: 'aucune donnée exploitable pour liaison' };

  const raw = await llm.json<unknown>([
    { role: 'system', content: `Tu liais un contrat analytique à des données MCP déjà lues.
Sens métier des champs, pas ressemblance lexicale. Respecte entities, population, period, limit, transform.
Ne change PAS visualization/operation/entities/period/population/transform — seulement queryId + measure exacte.
Aucune substitution silencieuse. unsatisfied=true + reason si impossible. JSON uniquement.` },
    { role: 'user', content: `Consigne : ${fenceUntrusted('demande', prompt, 3000)}
Exigences : ${JSON.stringify(reqs.map((r) => ({ id: r.id, label: r.label, view: r.view, operation: r.operation ?? r.agg, measures: r.measures ?? r.measure, entities: r.entities, population: r.population, period: r.period, unit: r.unit, transform: r.transform, limit: r.limit, filters: r.filters ?? r.where })))}
Données : ${fenceUntrusted('donnees', JSON.stringify(catalogue), 8000)}
Schéma : {"bindings":[...],"layout?":[...]}` },
  ], 60_000).catch(() => null);

  const parsed = BindComposeSchema.safeParse(raw);
  if (!parsed.success) return { reqs, source: 'skipped', reason: 'liaison IA invalide — validation déterministe seule' };

  const byId = new Map(parsed.data.bindings.map((b) => [b.requirementId, b]));
  const layout = new Map((parsed.data.layout ?? []).map((l) => [l.requirementId, l]));
  const knownQ = new Set(datasets.keys());

  const next = reqs.map((r) => {
    const b = byId.get(r.id);
    if (!b) return r;
    if (b.unsatisfied) return { ...r, acceptance: `${r.acceptance ?? ''} · IA: ${b.reason ?? 'insatisfaite'}`.slice(0, 300) };
    const ds = b.queryId && knownQ.has(b.queryId) ? datasets.get(b.queryId) : undefined;
    // Liaison exacte : path égal ou suffixe `.field` — jamais includes flou / pop stem.
    const measureOk = b.measure && ds
      ? ds.fields.some((f) => exactFieldMatch(f.rel, b.measure!))
      : false;
    const measures = measureOk && b.measure
      ? [...new Set([b.measure, ...(r.measures ?? r.measure ?? [])])]
      : r.measures ?? r.measure;
    // Intentions scellées : view / op / transform / limit restent ceux du contrat.
    const section = layout.get(r.id)?.section ?? b.section ?? r.section;
    const tool = b.queryId && ds ? [ds.acq.queryId, norm(ds.acq.ref.tool.name)] : r.tool;
    const filters = (b.filters as ClauseFilter[] | undefined) ?? r.filters ?? r.where;
    return Object.freeze({
      ...r,
      view: r.visualization ?? r.view,
      visualization: r.visualization ?? r.view,
      operation: r.operation ?? r.agg,
      agg: r.operation ?? r.agg,
      measure: measures, measures, filters, where: filters, tool, section,
      transform: r.transform,
      limit: r.limit,
      entities: r.entities,
      population: r.population,
      period: r.period,
      label_: b.label && measureOk ? [norm(b.label)] : r.label_,
    }) as ReqTemplate;
  });

  void opts?.sealed; // empreinte consultée côté orchestrateur via assertIntentIntact
  return { reqs: freezeReqs(next), source: 'llm' };
}

/** Correction ciblée : prioritairement le contrat, pas de nouvel MCP ici. */
export async function diagnoseCorrection(
  prompt: string,
  planned: PlannedReq[],
  divergences: string[],
  opts?: { budget?: LlmBudget },
): Promise<Correction | null> {
  if (llm.name === 'mock' || !divergences.length) return null;
  if (opts?.budget && !opts.budget.take()) return null;
  const raw = await llm.json<unknown>([
    { role: 'system', content: `Tu corriges un contrat Formule incorrect AVANT de multiplier les acquisitions.
Priorité : patchRequirements (mesures / filters) — JAMAIS supprimer une exigence obligatoire (mandatory).
Ne change pas visualization/entities/period/population d'une exigence obligatoire.
rebind seulement si les datasets déjà lus suffisent. Pas de nouvel appel MCP. JSON uniquement.` },
    { role: 'user', content: `Consigne : ${fenceUntrusted('demande', prompt, 2000)}
Exigences : ${JSON.stringify(planned.map((p) => ({ id: p.tpl.id, label: p.tpl.label, mandatory: p.tpl.mandatory, status: p.status, reason: p.reason, view: p.tpl.view, op: p.tpl.operation ?? p.tpl.agg, entities: p.tpl.entities, population: p.tpl.population })))}
Divergences : ${fenceUntrusted('divergences', divergences.join('\n'), 2000)}
Schéma : {"dropRequirementIds?","rebind?","patchRequirements?","note?"}` },
  ], 45_000).catch(() => null);
  const parsed = CorrectionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Applique une correction en protégeant les exigences obligatoires :
 * - drop interdit si mandatory
 * - patch ne peut pas altérer view / entities / period / population / transform / operation d'une mandatory
 */
export function applyCorrection(reqs: ReqTemplate[], correction: Correction, allowedQueryIds: Set<string>): ReqTemplate[] {
  const { allowed: dropAllowed } = filterForbiddenDrops(reqs, correction.dropRequirementIds);
  const drop = new Set(dropAllowed);
  const rebind = new Map((correction.rebind ?? []).map((r) => [r.requirementId, r]));
  const patches = new Map((correction.patchRequirements ?? []).map((p, i) => {
    const tpl = aiReqToTpl(p, i, undefined);
    return [p.id && reqs.some((r) => r.id === p.id) ? p.id : tpl.id, { ...tpl, id: p.id && reqs.some((r) => r.id === p.id) ? p.id : tpl.id }];
  }));

  let next = reqs.filter((r) => !drop.has(r.id)).map((r) => {
    const patch = patches.get(r.id);
    if (patch) {
      if (!r.mandatory) return patch;
      // Conservation intégrale des intentions analytiques obligatoires.
      return {
        ...r,
        label: patch.label || r.label,
        title: patch.title || r.title,
        measure: patch.measure ?? r.measure,
        measures: patch.measures ?? r.measures,
        filters: patch.filters ?? r.filters,
        where: patch.where ?? r.where,
        tool: patch.tool?.length ? patch.tool : r.tool,
        acceptance: `${r.acceptance ?? ''} · patch:mesures`.slice(0, 300),
      };
    }
    const b = rebind.get(r.id);
    if (!b) return r;
    if (b.queryId && !allowedQueryIds.has(b.queryId)) return r;
    return {
      ...r,
      measure: b.measure ? [norm(b.measure)] : r.measure,
      measures: b.measure ? [norm(b.measure)] : r.measures,
      // operation figée si mandatory
      operation: r.mandatory ? r.operation : (b.operation ?? r.operation),
      agg: r.mandatory ? r.agg : (b.operation ?? r.agg),
      acceptance: `${r.acceptance ?? ''} · corr:${b.reason ?? 'rebind'}`.slice(0, 300),
    };
  });

  for (const [id, tpl] of patches) {
    if (!next.some((r) => r.id === id) && !drop.has(id)) next.push(tpl);
  }
  return freezeReqs(capRequirements(next));
}
