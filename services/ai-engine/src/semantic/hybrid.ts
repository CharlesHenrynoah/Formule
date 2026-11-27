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
import { capRequirements, freezeReqs, normalizePeriod } from './analytical.js';
import {
  exactFieldMatch, filterForbiddenDrops, LlmBudget, sealContract, separateNonAnalytical,
  structuredCoverageGaps,
  type ContractConstraints, type SealedContract,
} from './contract-guard.js';
import { createRuntimeBudgets, McpBudget } from './budgets.js';
import type { Dataset } from './resolve.js';
import type { PlannedReq } from './plan.js';

export { LlmBudget, McpBudget, createRuntimeBudgets, sealContract, structuredCoverageGaps };
export type { ContractConstraints, SealedContract };

/** Tolère un singleton LLM (objet / string) → tableau. */
const asStringArray = (max: number, itemMax: number) => z.preprocess((v) => {
  if (v == null) return undefined;
  if (typeof v === 'string') return [v.slice(0, itemMax)];
  if (Array.isArray(v)) return v.map((x) => String(x).slice(0, itemMax)).slice(0, max);
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).map((x) => String(x).slice(0, itemMax)).slice(0, max);
  return [String(v).slice(0, itemMax)];
}, z.array(z.string().min(1).max(itemMax)).max(max).optional());

// Normalise uniquement des variantes de représentation connues, jamais une intention inconnue.
const absent = (v: unknown) => v == null || v === '' ? undefined : v;
const TransformEnum = z.preprocess((v) => {
  if (v == null || v === '' || v === false) return undefined;
  if (typeof v !== 'string') return v;
  const s = norm(v).replace(/[\s_-]/g, '');
  if (['none','raw','identity','aucune','notransform','notransformation'].includes(s)) return undefined;
  if (['base100','index100','rebased100','rebase100','normalizebase100','normalisationbase100'].includes(s)) return 'base100';
  return v; // Une transformation inconnue nécessite réparation, pas suppression.
}, z.enum(['base100']).optional());

const OrderEnum = z.preprocess((v) => {
  if (absent(v) === undefined) return undefined;
  if (typeof v !== 'string') return v;
  const s = norm(v).trim();
  if (['asc','ascending','croissant','croissante'].includes(s)) return 'asc';
  if (['desc','descending','decroissant','decroissante'].includes(s)) return 'desc';
  return v;
}, z.enum(['asc', 'desc']).optional());

const FilterOp = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const s = v.trim().toLowerCase();
  const aliases: Record<string, string> = { '=': 'eq', '==': 'eq', '!=': 'neq', '<>': 'neq', '>': 'gt', '<': 'lt', '>=': 'gte', '<=': 'lte' };
  return aliases[s] ?? s;
}, z.enum(['eq', 'neq', 'current_month', 'gt', 'lt', 'gte', 'lte', 'in', 'between']));

const FilterSchema = z.object({
  field: z.preprocess((v) => {
    if (typeof v === 'string') return [v.slice(0, 40)];
    if (Array.isArray(v)) return v.map((x) => String(x).slice(0, 40)).slice(0, 6);
    if (v && typeof v === 'object') return Object.values(v as object).map((x) => String(x).slice(0, 40)).slice(0, 6);
    return ['id'];
  }, z.array(z.string().min(1).max(40)).min(1).max(6)),
  op: FilterOp,
  value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()])).max(12)]).optional(),
});

const ViewEnum = z.preprocess((v) => {
  if (v == null || v === '') return undefined;
  const s = String(v).toLowerCase();
  if ((VIEW_KINDS as readonly string[]).includes(s)) return s;
  if (/courbe|line|serie|time/.test(s)) return 'line';
  if (/tableau|table|liste/.test(s)) return 'table';
  if (/classement|rank|top/.test(s)) return 'ranking';
  if (/donut|camembert|part/.test(s)) return 'donut';
  if (/barre|bar/.test(s)) return 'bars';
  if (/note|design|texte/.test(s)) return 'note';
  if (/kpi|indicateur|nombre|somme|total/.test(s)) return 'kpi';
  return undefined;
}, z.enum(VIEW_KINDS).optional());

const AggEnum = z.preprocess((v) => {
  if (v == null || v === '') return undefined;
  const s = String(v).toLowerCase();
  if ((AGGS as readonly string[]).includes(s)) return s;
  if (/somme|sum/.test(s)) return 'sum';
  if (/compte|count|nombre/.test(s)) return 'count';
  if (/moyenne|avg|average/.test(s)) return 'avg';
  if (/dernier|last/.test(s)) return 'last';
  if (/ratio|part|pourcent/.test(s)) return 'ratio';
  if (/identit/.test(s)) return 'identity';
  return undefined;
}, z.enum(AGGS).optional());

const ReqSchema = z.object({
  id: z.preprocess((v) => typeof v === 'number' ? String(v) : absent(v), z.string().min(1).max(40).optional()),
  label: z.preprocess((v) => (v == null ? 'Exigence' : String(v).slice(0, 120)), z.string().min(1).max(120)),
  kind: z.preprocess(absent, z.enum(['analytical', 'note']).default('analytical')),
  visualization: ViewEnum,
  operation: AggEnum,
  measures: asStringArray(6, 40),
  entities: asStringArray(12, 40),
  population: z.preprocess((v) => (v == null ? undefined : String(v).slice(0, 120)), z.string().max(120).optional()),
  period: z.preprocess((v) => (v == null ? undefined : String(v).slice(0, 40)), z.string().max(40).optional()),
  grain: z.preprocess((v) => (v == null ? undefined : String(v).slice(0, 20)), z.string().max(20).optional()),
  unit: z.preprocess((v) => (v == null ? undefined : String(v).slice(0, 20)), z.string().max(20).optional()),
  transform: TransformEnum,
  filters: z.preprocess((v) => (v == null ? undefined : Array.isArray(v) ? v : [v]), z.array(FilterSchema).max(4).optional()),
  toolHints: asStringArray(6, 60),
  argHints: z.preprocess((v) => {
    if (v == null || Array.isArray(v)) return undefined;
    if (typeof v === 'object') return v;
    return undefined;
  }, z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()),
  certainty: z.preprocess(absent, z.enum(['certain', 'hypothesis']).optional()),
  section: z.preprocess((v) => (v == null ? undefined : String(v).slice(0, 40)), z.string().max(40).optional()),
  limit: z.preprocess((v) => {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(50, Math.max(1, Math.trunc(n))) : undefined;
  }, z.number().int().min(1).max(50).optional()),
  order: OrderEnum,
  covers: asStringArray(6, 120),
});

const AcquisitionGroupSchema = z.object({
  id: z.preprocess((v) => (v == null ? 'g' : String(v).slice(0, 40)), z.string().min(1).max(40)),
  purpose: z.preprocess((v) => (v == null ? undefined : String(v).slice(0, 160)), z.string().max(160).optional()),
  entity: z.preprocess((v) => (v == null ? undefined : String(v).slice(0, 40)), z.string().max(40).optional()),
  forRequirementIds: z.preprocess((v) => {
    if (typeof v === 'string' || typeof v === 'number') return [String(v)];
    if (Array.isArray(v)) return v.map(String).slice(0, 20);
    if (v && typeof v === 'object') return Object.values(v as object).map(String).slice(0, 20);
    return ['0'];
  }, z.array(z.string().max(40)).min(1).max(20)),
  toolHints: asStringArray(6, 60),
  argHints: z.preprocess((v) => {
    if (v == null || Array.isArray(v)) return undefined;
    if (typeof v === 'object') return v;
    return undefined;
  }, z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()),
  dataNotDocs: z.preprocess((v) => v == null ? undefined : v, z.boolean().default(true)),
});

const strList = (max: number) => z.preprocess((v) => {
  if (v == null) return [];
  if (typeof v === 'string') return v.trim() ? [v.slice(0, 160)] : [];
  if (Array.isArray(v)) return v.map((x) => String(x).slice(0, 160)).filter(Boolean).slice(0, max);
  if (typeof v === 'object') return Object.values(v as object).map((x) => String(x).slice(0, 160)).filter(Boolean).slice(0, max);
  return [];
}, z.array(z.string().min(1).max(160)).max(max));

/** Appel 1 — contrat sémantique intégral. */
export const InterpretPlanSchema = z.object({
  title: z.preprocess((v) => (v == null || v === '' ? 'Application' : String(v).slice(0, 80)), z.string().min(1).max(80)),
  mission: z.preprocess((v) => (v == null || v === '' ? 'Analyse' : String(v).slice(0, 400)), z.string().min(1).max(400)),
  /** Points du prompt original qui doivent apparaître dans le contrat (couverture). */
  coverage: strList(40).pipe(z.array(z.string().min(1).max(160)).min(1).max(40)),
  constraints: z.preprocess(absent, z.object({
    global: strList(20).optional(),
    design: strList(20).optional(),
    interactions: strList(20).optional(),
    reliability: strList(20).optional(),
  }).optional()),
  requirements: z.preprocess((v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v as object) : []), z.array(ReqSchema).min(1).max(40)),
  /** Groupes d'acquisition : mutualisation + décomposition multi-entités. */
  acquisitions: z.preprocess((v) => (v == null ? undefined : Array.isArray(v) ? v : [v]), z.array(AcquisitionGroupSchema).max(40).optional()),
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
    transform: TransformEnum,
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
- requirements (analytiques / note) — KPI, tableaux, graphiques, mesures, entités
- constraints.global (périmètre MCP, population partagée, période globale, titre déjà dans title)
- constraints.design (couleurs, layout haut/milieu/bas, thème sombre, accents vert/rouge)
- constraints.interactions (onglets, curseurs, boutons, actualisation)
- constraints.reliability (provenance, fraîcheur, mutualisation, pas d'invention)
- coverage : UNIQUEMENT les intentions ANALYTIQUES (données / vues). Jamais le titre, le layout, ni un bouton.
- acquisitions : groupes mutualisés ; décompose multi-entités si un outil ne prend qu'une entité à la fois ; dataNotDocs=true pour les données

Règles :
1. title = marque / titre explicite (guillemets, Title:, markdown). Ne le répète PAS dans coverage.
2. Une exigence atomique = une visualisation + une opération. Ne fusionne pas classements distincts.
3. entities = noms propres courts. Jamais une phrase.
4. measures = concepts métier, jamais des mots grammaticaux.
5. Populations partagées → constraints.global + population sur chaque exigence concernée.
6. Comparaison multi-entités : entities listées, acquisitions décomposées si besoin. transform=base100 uniquement si la normalisation en base 100 est demandée ; sinon omets transform.
7. toolHints = outils de DONNÉES. search_docs / documentation uniquement si demandé.
8. covers[] sur chaque exigence = copie exacte d'une entrée de coverage analytique.
9. Layout / refresh / design → constraints, pas requirements ni coverage.
10. JSON uniquement. Tu n'exécutes rien. Omettre les propriétés facultatives non pertinentes ; ne pas émettre null, des objets fictifs ou des valeurs hors enum.`;

// Schéma de communication concret : les champs facultatifs de cet exemple ne doivent
// être émis que lorsqu'ils correspondent au prompt. Les exemples ne sont pas des données.
const INTERPRET_FORMAT = `Objet JSON : title (string, <=80), mission (string, <=400), coverage (string[] non vide).
constraints facultatif : {global?:string[], design?:string[], interactions?:string[], reliability?:string[]}.
requirements (1..40 objets) : {id?:string, label:string, kind?:"analytical"|"note",
visualization?:${VIEW_KINDS.join('|')}, operation?:${AGGS.join('|')}, measures?:string[], entities?:string[],
population?:string, period?:string, grain?:string, unit?:string, transform?:"base100",
filters?:[{field:string[],op:"eq"|"neq"|"current_month"|"gt"|"lt"|"gte"|"lte"|"in"|"between",value?:string|number|array de strings/nombres}],
toolHints?:string[], argHints?:objet de valeurs string/number/boolean, certainty?:"certain"|"hypothesis",
section?:string, limit?:entier 1..50, order?:"asc"|"desc", covers?:string[]}.
acquisitions facultatif (0..40 objets) : {id:string, purpose?:string, entity?:string, forRequirementIds:string[] non vide,
toolHints?:string[], argHints?:objet de valeurs string/number/boolean, dataNotDocs?:boolean}.
Tip : coverage[] = intentions analytiques uniquement (KPI, tableaux, courbes, mesures). Titre / design / layout / refresh / chrome UI → constraints (global|design|interactions), jamais coverage ni gaps MCP.
Respecte les types et valeurs exacts. Omettre les champs facultatifs sans valeur. Pas de null. Ne pas inventer d'exigence.`;

/** Chemins Zod explicites, sans valeur brute ni données sensibles. */
export function interpretationIssues(error: z.ZodError): string {
  return error.issues.slice(0, 12).map((i) => {
    const path = i.path.map(String).join('.') || 'racine';
    return path + ': ' + i.message;
  }).join(' ; ');
}

/** Une seule réparation de format, avant toute lecture MCP. Jamais de repli syntaxique. */
export async function validateInterpretation(raw: unknown, repair?: (issues: string) => Promise<unknown>) {
  const first = InterpretPlanSchema.safeParse(raw);
  if (first.success || raw == null || !repair) return first;
  const fixed = await repair(interpretationIssues(first.error));
  if (fixed == null) return first;
  return InterpretPlanSchema.safeParse(fixed);
}

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
export async function interpretAndPlan(prompt: string, catalog: CatalogServer[], base: Understanding, options?: { budget?: LlmBudget }): Promise<HybridPlan> {
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

  const messages = [
    { role: 'system' as const, content: CALL_A_SYSTEM + '\n\n' + INTERPRET_FORMAT },
    { role: 'user' as const, content: `Consigne originale (ne la découpe pas lexicalement) :\n${fenceUntrusted('demande', prompt, 7000)}\n\nCatalogue (kind=docs | data) :\n${fenceUntrusted('outils', JSON.stringify(tools), 5000)}` },
  ];
  const raw = await llm.json<unknown>(messages, 60_000).catch(() => null);
  if (raw == null) return unavailable('Aucune réponse JSON exploitable du LLM (disponibilité, quota ou format à vérifier).', base);

  const parsed = await validateInterpretation(raw, async (issues) => {
    if (options?.budget && !options.budget.take()) return null;
    return llm.json<unknown>([
      ...messages,
      { role: 'user', content: `La réponse précédente est rejetée par le schéma. Répare uniquement le format JSON et les types, en préservant toutes les intentions explicites de la consigne originale. Renvoie le contrat complet.\nErreurs : ${issues}\nContrat à réparer : ${fenceUntrusted('contrat', JSON.stringify(raw), 12000)}` },
    ], 30_000).catch(() => null);
  });
  if (!parsed.success) {
    return unavailable(`Contrat JSON LLM non conforme : ${interpretationIssues(parsed.error)}. Aucun contrat syntaxique de substitution.`, base);
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
  // Séparation stricte : titre / design / interactions / tech → constraints, pas des vues.
  const separated = separateNonAnalytical(reqs, rawConstraints);
  const sealed = sealContract(prompt, separated.reqs, parsed.data.coverage, {
    global: [...rawConstraints.global, ...separated.movedGlobal],
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
  // Mesures = tokens déclarés par le LLM uniquement (pas de synonymes métier injectés).
  const measures = r.measures?.map(norm).filter((m) => m.length > 1).slice(0, 8);
  const entities = r.entities?.map((e) => e.trim()).filter((e) => e.length >= 2 && e.length <= 40 && e.split(/\s+/).length <= 3);
  const covers = r.covers?.map((c) => c.slice(0, 120));
  const period = normalizePeriod(r.period) ?? r.period;
  return {
    id, label: r.label.slice(0, 120), mandatory: r.certainty !== 'hypothesis', tool: r.toolHints?.length ? r.toolHints.map(norm) : ['*'],
    title: r.label.slice(0, 80), view, visualization: view,
    measure: measures, measures, agg, operation: agg,
    where: filters, filters,
    denWhere: agg === 'ratio' ? [] : undefined,
    percent: agg === 'ratio',
    entities, population: r.population, period, grain: r.grain, unit: r.unit,
    transform: r.transform, limit: r.limit, order: r.order, section: r.section, design, covers,
    label_: view === 'ranking' || view === 'donut' || view === 'bars' || view === 'table' ? ['nom', 'name', 'libelle', 'categorie', 'symbol', 'id'] : undefined,
    dimensions: view === 'ranking' || view === 'donut' || view === 'bars' || view === 'table' ? ['nom', 'name', 'libelle', 'categorie', 'symbol'] : undefined,
    acceptance: [
      view, agg ? `op:${agg}` : null, r.transform ? `transform:${r.transform}` : null,
      r.certainty === 'hypothesis' ? 'hypothèse' : null,
      entities?.length ? `entite:${entities.join(',')}` : null,
      r.population ? `pop:${r.population}` : null, period ? `periode:${period}` : null,
      r.limit != null ? `limit:${r.limit}` : null,
      covers?.length ? `covers:${covers.join('|')}` : null,
    ].filter(Boolean).join(' · ').slice(0, 300),
  };
}

/**
 * Couverture structurée : chaque point doit être porté par covers[] ou label exact.
 * Plus de matching par présence de mots.
 */
export function coverageGaps(coverage: string[], reqs: ReqTemplate[], constraints?: ContractConstraints): string[] {
  return structuredCoverageGaps(coverage, reqs, constraints);
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
      // Conservation intégrale des intentions analytiques obligatoires (covers/transform/unit figés).
      return {
        ...r,
        label: patch.label || r.label,
        title: patch.title || r.title,
        measure: patch.measure ?? r.measure,
        measures: patch.measures ?? r.measures,
        filters: patch.filters ?? r.filters,
        where: patch.where ?? r.where,
        tool: patch.tool?.length ? patch.tool : r.tool,
        covers: r.covers,
        transform: r.transform,
        unit: r.unit,
        inputUnit: r.inputUnit,
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
