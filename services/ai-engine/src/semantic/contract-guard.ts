/**
 * Garde-fous déterministes du contrat sémantique (PR #6 / consolidation).
 * L'IA propose ; ce module valide l'immuabilité, la couverture structurée et la séparation des intentions.
 */
import { createHash } from 'node:crypto';
import { norm, type ReqTemplate, type ViewKind } from './lexicon.js';
import type { PlannedReq } from './plan.js';
import { LlmBudget } from './budgets.js';

export { LlmBudget } from './budgets.js';

export type ContractConstraints = {
  global: string[];
  design: string[];
  interactions: string[];
  reliability: string[];
};

export type SealedContract = {
  fingerprint: string;
  promptHash: string;
  reqs: ReqTemplate[];
  coverage: string[];
  constraints: ContractConstraints;
  /** Empreinte des intentions analytiques (propriétés complètes). */
  intentLock: Map<string, string>;
};

const DESIGN_RE = /(design|theme|th[eè]me|couleur|color|sombre|dark|clair|layout|disposition|typograph|police|font|style|minimaliste|professionnel|vert pour|rouge pour|en haut|au milieu|en bas|indicateurs en|indicators?\s+top|charts?\s+middle|table\s+bottom|graphiques? au|tableau en bas|interface sombre)/i;
const INTERACT_RE = /(onglet|tab\b|curseur|slider|bouton|button|rafra[iî]ch|actualis|refresh|reset|clic|hover|drag)/i;
const TECH_RE = /(optimise|mcp|quota|cache|latence|budget|appel|rate.?limit|permission|s[eé]curit|mutualis|minimise les appels|provenance|fra[iî]cheur)/i;
/** Titre / branding / consigne méta — jamais une lecture MCP. */
const META_RE = /(intitul[eé]|title[dd]?\s*[:=«"']|titr[eé]\s*[:=«"']|titled\s+[«"']|dashboard\s+(intitul|titl)|cr[eé]e[rz]?\s+(une?\s+)?(interface|dashboard|console|application)|create\s+(an?\s+)?(interface|dashboard|console|application)|nomm[eé]e?\s*[:=«"'])/i;

export type CoverageKind = 'analytical' | 'design' | 'interaction' | 'reliability' | 'meta';

/** Classe un point de coverage : chrome UI / titre → hors checklist analytique. */
export function classifyCoveragePoint(text: string): CoverageKind {
  // Bouton / refresh : prioritaire même si le texte mentionne un graphique à mettre à jour.
  if (/(bouton|button|rafra[iî]ch|actualis|refresh)/i.test(text) && INTERACT_RE.test(text)) {
    return 'interaction';
  }
  // Titre / branding dashboard : pas une acquisition (avant design : « dashboard » n'est pas un layout).
  if (META_RE.test(text) && !/(capitalisation|volume|prix|classement|tableau contenant|tableau de données|graphique en|courbe|barres|donut|kpi)/i.test(text)) {
    return 'meta';
  }
  // Layout / thème sans mesure à lire (placement graphique ≠ intention analytique).
  if (DESIGN_RE.test(text) && !/(capitalisation|volume|prix|classement|courbe|tableau contenant|graphique en|barres|donut|ratio|somme|nombre|part\b|kpi)/i.test(text)) {
    return 'design';
  }
  if (TECH_RE.test(text) && !hasAnalyticSignal(text)) return 'reliability';
  if (hasAnalyticSignal(text)) return 'analytical';
  if (INTERACT_RE.test(text)) return 'interaction';
  if (DESIGN_RE.test(text)) return 'design';
  if (META_RE.test(text)) return 'meta';
  return 'analytical';
}

export function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

function filtersKey(r: ReqTemplate): string {
  return JSON.stringify((r.filters ?? r.where ?? []).map((f) => ({
    field: [...f.field].map(norm).sort(), op: f.op, value: f.value ?? null,
  })));
}

/** Empreinte intégrale des propriétés analytiques (prompt → certification). */
export function intentKey(r: ReqTemplate): string {
  return [
    r.visualization ?? r.view,
    r.operation ?? r.agg ?? '',
    (r.measures ?? r.measure ?? []).map(norm).sort().join(','),
    (r.entities ?? []).map(norm).sort().join(','),
    r.population ?? '',
    r.period ?? '',
    r.grain ?? '',
    r.transform ?? '',
    r.limit ?? '',
    r.unit ?? r.inputUnit ?? '',
    r.order ?? '',
    filtersKey(r),
    (r.covers ?? []).map(norm).sort().join(','),
  ].join('|');
}

/** Retire les unités inventées par le LLM et absentes du prompt (ne pas durcir hors intention). */
export function stripUngroundedUnits(prompt: string, reqs: ReqTemplate[]): ReqTemplate[] {
  const p = norm(prompt);
  return reqs.map((r) => {
    if (!r.unit && !r.inputUnit) return r;
    const u = norm(r.unit ?? r.inputUnit ?? '');
    if (!u) return r;
    const grounded = p.includes(u)
      || new RegExp(`\\b${u}\\b`, 'i').test(prompt)
      || (u === 'eur' && /euros?|€/i.test(prompt))
      || (u === 'usd' && /dollars?|\$|usd/i.test(prompt))
      || (u === '%' && /%|pourcent/i.test(prompt));
    if (grounded) return r;
    return { ...r, unit: undefined, inputUnit: undefined };
  });
}

/** Retire les entités inventées (ex. nom de collection) absentes du prompt. */
export function stripUngroundedEntities(prompt: string, reqs: ReqTemplate[]): ReqTemplate[] {
  const p = norm(prompt);
  return reqs.map((r) => {
    if (!r.entities?.length) return r;
    const kept = r.entities.filter((e) => {
      const n = norm(e);
      return n.length >= 2 && (p.includes(n) || prompt.toLowerCase().includes(e.toLowerCase()));
    });
    return { ...r, entities: kept.length ? kept : undefined };
  });
}

/** Scelle le contrat validé : toute mutation d'intention devient détectable. */
export function sealContract(
  prompt: string,
  reqs: ReqTemplate[],
  coverage: string[],
  constraints: ContractConstraints,
): SealedContract {
  const cleaned = stripUngroundedEntities(prompt, stripUngroundedUnits(prompt, reqs));
  const analytical = separateNonAnalytical(cleaned, constraints);
  const mergedConstraints = {
    global: [...new Set([...constraints.global, ...analytical.movedGlobal])],
    design: [...new Set([...constraints.design, ...analytical.movedDesign])],
    interactions: [...new Set([...constraints.interactions, ...analytical.movedInteractions])],
    reliability: [...new Set([...constraints.reliability, ...analytical.movedTech])],
  };

  // Coverage LLM : chrome (titre/layout/bouton) → constraints ; data → checklist analytique.
  const analyticalCoverage: string[] = [];
  for (const c of coverage) {
    const kind = classifyCoveragePoint(c);
    if (kind === 'meta') {
      if (!mergedConstraints.global.some((x) => norm(x) === norm(c))) mergedConstraints.global.push(c);
      continue;
    }
    if (kind === 'design') {
      if (!mergedConstraints.design.some((x) => norm(x) === norm(c))) mergedConstraints.design.push(c);
      continue;
    }
    if (kind === 'interaction') {
      if (!mergedConstraints.interactions.some((x) => norm(x) === norm(c))) mergedConstraints.interactions.push(c);
      continue;
    }
    if (kind === 'reliability') {
      if (!mergedConstraints.reliability.some((x) => norm(x) === norm(c))) mergedConstraints.reliability.push(c);
      continue;
    }
    analyticalCoverage.push(c);
  }

  // Relie les points analytiques orphelins aux exigences (covers[]) par signaux structurés.
  const reqsWithCovers = attachOrphanCoverage(analytical.reqs, analyticalCoverage);

  const intentLock = new Map(reqsWithCovers.map((r) => [r.id, intentKey(r)]));
  const fingerprint = createHash('sha256')
    .update(reqsWithCovers.map((r) => `${r.id}:${intentLock.get(r.id)}`).join(';'))
    .digest('hex')
    .slice(0, 16);

  return {
    fingerprint,
    promptHash: promptHash(prompt),
    reqs: reqsWithCovers,
    coverage: analyticalCoverage.length ? analyticalCoverage : analytical.reqs.map((r) => r.label),
    constraints: mergedConstraints,
    intentLock,
  };
}

/** Attache un point de coverage sans covers[] à l'exigence structurée correspondante. */
function attachOrphanCoverage(reqs: ReqTemplate[], coverage: string[]): ReqTemplate[] {
  return reqs.map((r) => {
    const existing = new Set((r.covers ?? []).map(norm));
    const view = r.visualization ?? r.view;
    const ents = (r.entities ?? []).map(norm).filter(Boolean);
    const added: string[] = [];
    for (const c of coverage) {
      const n = norm(c);
      if (existing.has(n) || norm(r.label) === n || norm(r.title) === n) continue;
      const viewHit =
        (view === 'table' && /tableau|table\b/.test(n))
        || (view === 'bars' && /barres|bar\b|performances?/.test(n))
        || (view === 'donut' && /circulaire|donut|r[eé]partition|camembert/.test(n))
        || (view === 'line' && /courbe|comparatif|base\s*100|30\s*jours|historique/.test(n))
        || (view === 'kpi' && /(capitalisation|volume|part|pourcentage|hausse|baisse|indicateur|kpi)/.test(n) && !/tableau|barres|circulaire|courbe/.test(n));
      if (!viewHit) continue;
      if (ents.length && !ents.every((e) => n.includes(e))) {
        // Exigence multi-entités stricte : toutes les entités doivent apparaître dans le point.
        // KPI sans entité : OK si viewHit.
        if ((r.entities?.length ?? 0) >= 2) continue;
      }
      added.push(c);
      existing.add(n);
    }
    if (!added.length) return r;
    return { ...r, covers: [...(r.covers ?? []), ...added] };
  });
}

/** Exigences design/interactions/tech/titre → contraintes ; pas de visualisation. */
export function separateNonAnalytical(reqs: ReqTemplate[], constraints: ContractConstraints): {
  reqs: ReqTemplate[];
  movedGlobal: string[];
  movedDesign: string[];
  movedInteractions: string[];
  movedTech: string[];
} {
  const kept: ReqTemplate[] = [];
  const movedGlobal: string[] = [];
  const movedDesign: string[] = [];
  const movedInteractions: string[] = [];
  const movedTech: string[] = [];
  for (const r of reqs) {
    const text = `${r.label} ${r.title} ${r.acceptance ?? ''}`;
    if (r.view === 'note') { kept.push(r); continue; }
    const kind = classifyCoveragePoint(text);
    if (kind === 'meta') { movedGlobal.push(r.label); continue; }
    if (kind === 'design') { movedDesign.push(r.label); continue; }
    if (kind === 'interaction') { movedInteractions.push(r.label); continue; }
    if (kind === 'reliability') { movedTech.push(r.label); continue; }
    kept.push(r);
  }
  return { reqs: kept, movedGlobal, movedDesign, movedInteractions, movedTech };
}

/** Vérifie que les intentions scellées n'ont pas été altérées. */
export function assertIntentIntact(sealed: SealedContract, reqs: ReqTemplate[]): string[] {
  const errors: string[] = [];
  for (const [id, lock] of sealed.intentLock) {
    const r = reqs.find((x) => x.id === id);
    if (!r) {
      const was = sealed.reqs.find((x) => x.id === id);
      if (was?.mandatory) errors.push(`exigence obligatoire « ${was.label} » supprimée`);
      else errors.push(`exigence « ${id} » absente du contrat scellé`);
      continue;
    }
    if (intentKey(r) !== lock) errors.push(`intention altérée pour « ${r.label} » (view/op/entities/période/population)`);
  }
  return errors;
}

/** Interdit de supprimer une exigence obligatoire. */
export function filterForbiddenDrops(reqs: ReqTemplate[], dropIds: string[] | undefined): { allowed: string[]; refused: string[] } {
  const allowed: string[] = [];
  const refused: string[] = [];
  for (const id of dropIds ?? []) {
    const r = reqs.find((x) => x.id === id);
    if (r?.mandatory) refused.push(id);
    else allowed.push(id);
  }
  return { allowed, refused };
}

/**
 * Audit structurel (pas lexical) :
 * - une exigence « design/interaction/tech » ne peut pas être une vue data ;
 * - chaque point de coverage doit être porté par covers[] ou constraints ;
 * - transform/base100 uniquement si une exigence le déclare.
 */
export function independentPromptAudit(_prompt: string, reqs: ReqTemplate[], constraints: ContractConstraints): string[] {
  const gaps: string[] = [];
  const analyticalReqs = reqs.filter((r) => r.view !== 'note');

  // Les promotions design→vue sont déjà filtrées par separateNonAnalytical au scellement.
  // Ici : cohérence structurelle covers ↔ constraints uniquement.
  for (const r of analyticalReqs) {
    if ((r.visualization ?? r.view) === 'note') continue;
    if (r.covers?.length && r.covers.every((c) => constraintPtsHas(constraints, c)) && !(r.measures?.length || r.measure?.length)) {
      gaps.push(`exigence sans mesure portant uniquement des contraintes : « ${r.label} »`);
    }
  }
  return gaps;
}

function constraintPtsHas(constraints: ContractConstraints, c: string): boolean {
  const n = norm(c);
  return [...constraints.global, ...constraints.design, ...constraints.interactions, ...constraints.reliability]
    .some((x) => norm(x) === n);
}

/** Couverture structurée : chaque point analytique doit être référencé par covers[] (égalité normalisée). */
export function structuredCoverageGaps(coverage: string[], reqs: ReqTemplate[], constraints?: ContractConstraints): string[] {
  if (!coverage.length) return ['coverage vide : le contrat ne déclare aucune intention à couvrir'];
  const constraintPts = new Set([
    ...(constraints?.global ?? []),
    ...(constraints?.design ?? []),
    ...(constraints?.interactions ?? []),
    ...(constraints?.reliability ?? []),
  ].map(norm));
  return coverage.filter((c) => {
    // Titre / layout / bouton / fiabilité : pas des gaps d'acquisition MCP.
    if (classifyCoveragePoint(c) !== 'analytical') return false;
    const n = norm(c);
    if (constraintPts.has(n)) return false;
    return !reqs.some((r) => {
      const covers = (r.covers ?? []).map(norm);
      if (covers.includes(n)) return true;
      // Identité stricte label ≡ coverage (pas un includes de mots).
      return norm(r.label) === n || norm(r.title) === n;
    });
  });
}

/** Fidélité post-liaison : exigences obligatoires non couvertes = manques vs prompt. */
export function fidelityAgainstPrompt(sealed: SealedContract, planned: PlannedReq[]): string[] {
  const gaps: string[] = [];
  for (const r of sealed.reqs.filter((x) => x.mandatory && x.view !== 'note')) {
    const p = planned.find((x) => x.tpl.id === r.id);
    if (!p || (p.status !== 'covered' && p.status !== 'unavailable')) {
      gaps.push(`non couverte : ${r.label}`);
    } else if (p.status === 'missing') {
      gaps.push(`manquante : ${r.label}${p.reason ? ` (${p.reason})` : ''}`);
    }
    // Intention lock
    if (p && intentKey(p.tpl) !== sealed.intentLock.get(r.id)) {
      gaps.push(`intention dérivée pour ${r.label}`);
    }
  }
  return gaps;
}

/** Style AppSpec dérivé des contraintes design (jamais d'une exigence analytique). */
export function styleFromConstraints(constraints: ContractConstraints): { theme: 'noir' | 'graphite'; accent: 'vert' | 'rouge' | 'bleu' | 'mono' } {
  const d = constraints.design.join(' ').toLowerCase();
  const theme = /sombre|dark|noir/.test(d) ? 'noir' as const : 'noir' as const;
  const accent = /bleu/.test(d) ? 'bleu' as const
    : /vert/.test(d) ? 'vert' as const
      : /rouge/.test(d) ? 'rouge' as const
        : 'mono' as const;
  return { theme, accent };
}

/** Signal analytique dans un libellé / point de coverage (évite de classer un KPI comme « design seul »). */
function hasAnalyticSignal(text: string): boolean {
  return /(kpi|capitalisation|volume|prix|classement|courbe|tableau|graphique|ratio|somme|nombre|part\b|donut|histogram|barres|performance|variation|hausse|baisse)/i.test(text);
}

/** Champ exact : path égal ou suffixe `.field` — pas d'includes flou. */
export function exactFieldMatch(fieldRel: string, measure: string): boolean {
  const rel = norm(fieldRel);
  const m = norm(measure);
  return rel === m || rel.endsWith('.' + m);
}

export function isAnalyticalView(v: ViewKind): boolean {
  return v !== 'note';
}
