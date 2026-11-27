/**
 * Garde-fous déterministes du contrat sémantique (PR #6).
 * L'IA propose ; ce module valide l'immuabilité, la couverture et la séparation des intentions.
 */
import { createHash } from 'node:crypto';
import { norm, type ReqTemplate, type ViewKind } from './lexicon.js';
import type { PlannedReq } from './plan.js';

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
  /** Empreinte des intentions analytiques (ids + view + op + entities + period + population). */
  intentLock: Map<string, string>;
};

const DESIGN_RE = /(design|theme|th[eè]me|couleur|color|sombre|dark|clair|layout|typograph|police|font|style|minimaliste|professionnel|vert pour|rouge pour)/i;
const INTERACT_RE = /(onglet|tab\b|curseur|slider|bouton|button|rafra[iî]ch|refresh|reset|clic|hover|drag)/i;
const TECH_RE = /(optimise|mcp|quota|cache|latence|budget|appel|rate.?limit|permission|s[eé]curit)/i;

export function promptHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex').slice(0, 16);
}

function intentKey(r: ReqTemplate): string {
  return [
    r.visualization ?? r.view,
    r.operation ?? r.agg ?? '',
    (r.entities ?? []).map(norm).sort().join(','),
    r.population ?? '',
    r.period ?? '',
    r.transform ?? '',
    r.limit ?? '',
    r.unit ?? '',
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
  const intentLock = new Map(analytical.reqs.map((r) => [r.id, intentKey(r)]));
  const fingerprint = createHash('sha256')
    .update(analytical.reqs.map((r) => `${r.id}:${intentLock.get(r.id)}`).join(';'))
    .digest('hex')
    .slice(0, 16);
  const mergedConstraints = {
    global: [...constraints.global],
    design: [...new Set([...constraints.design, ...analytical.movedDesign])],
    interactions: [...new Set([...constraints.interactions, ...analytical.movedInteractions])],
    reliability: [...new Set([...constraints.reliability, ...analytical.movedTech])],
  };
  // Les points de coverage design/interactions/tech sont portés par constraints, pas par reqs.
  const constraintBlob = norm([
    ...mergedConstraints.global, ...mergedConstraints.design,
    ...mergedConstraints.interactions, ...mergedConstraints.reliability,
  ].join(' '));
  const keptCoverage = coverage.filter((c) => {
    const n = norm(c);
    if ((DESIGN_RE.test(c) || INTERACT_RE.test(c) || TECH_RE.test(c)) && !hasAnalyticSignal(c)) {
      return constraintBlob.includes(n) || n.split(/[^a-z0-9]+/).filter((w) => w.length > 2).some((w) => constraintBlob.includes(w));
    }
    return true;
  });
  // Si un point design est dans coverage mais déjà dans constraints, on le retire de la checklist analytique.
  const analyticalCoverage = keptCoverage.filter((c) => {
    if ((DESIGN_RE.test(c) || INTERACT_RE.test(c) || TECH_RE.test(c)) && !hasAnalyticSignal(c)) return false;
    return true;
  });
  return {
    fingerprint,
    promptHash: promptHash(prompt),
    reqs: analytical.reqs,
    coverage: analyticalCoverage.length ? analyticalCoverage : keptCoverage,
    constraints: mergedConstraints,
    intentLock,
  };
}

/** Exigences design/interactions/tech → contraintes ; pas de visualisation. */
export function separateNonAnalytical(reqs: ReqTemplate[], constraints: ContractConstraints): {
  reqs: ReqTemplate[];
  movedDesign: string[];
  movedInteractions: string[];
  movedTech: string[];
} {
  const kept: ReqTemplate[] = [];
  const movedDesign: string[] = [];
  const movedInteractions: string[] = [];
  const movedTech: string[] = [];
  for (const r of reqs) {
    const text = `${r.label} ${r.title} ${r.acceptance ?? ''}`;
    if (r.view === 'note') { kept.push(r); continue; }
    if (DESIGN_RE.test(text) && !/(kpi|capitalisation|volume|prix|classement|courbe|tableau|graphique|ratio|somme|nombre)/i.test(text)) {
      movedDesign.push(r.label); continue;
    }
    if (INTERACT_RE.test(text) && !/(kpi|capitalisation|volume|prix|classement|courbe|tableau)/i.test(text)) {
      movedInteractions.push(r.label); continue;
    }
    if (TECH_RE.test(text) && !/(kpi|capitalisation|volume|prix|classement|courbe|tableau)/i.test(text)) {
      movedTech.push(r.label); continue;
    }
    kept.push(r);
  }
  return { reqs: kept, movedDesign, movedInteractions, movedTech };
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
 * Couverture sémantique indépendante du tableau `coverage` LLM.
 * Détecte : design devenu vue analytique ; intentions analytiques du prompt absentes.
 */
export function independentPromptAudit(prompt: string, reqs: ReqTemplate[], constraints: ContractConstraints): string[] {
  const gaps: string[] = [];
  const p = norm(prompt);
  const analyticalReqs = reqs.filter((r) => r.view !== 'note');

  // Design / interactions / tech ne doivent pas être des vues data.
  for (const r of analyticalReqs) {
    const text = `${r.label} ${r.title}`;
    if (DESIGN_RE.test(text) && !hasAnalyticSignal(text)) gaps.push(`design promu en vue : « ${r.label} »`);
    if (INTERACT_RE.test(text) && !hasAnalyticSignal(text)) gaps.push(`interaction promue en vue : « ${r.label} »`);
    if (TECH_RE.test(text) && !hasAnalyticSignal(text)) gaps.push(`contrainte technique promue en vue : « ${r.label} »`);
  }

  // Signaux analytiques explicites du prompt doivent avoir une exigence.
  const checks: { re: RegExp; label: string }[] = [
    { re: /base\s*100|rebase|normalis/, label: 'comparaison base 100' },
    { re: /classement|palmares|top\s*\d|meilleur|pire/, label: 'classement' },
    { re: /tableau/, label: 'tableau' },
    { re: /courbe|evolution|historique/, label: 'série temporelle' },
    { re: /capitalisation|market\s*cap|taille.*(march|market)/, label: 'capitalisation / taille de marché' },
  ];
  const blob = analyticalReqs.map((r) => norm([
    r.label, r.acceptance ?? '', r.transform ?? '', r.view,
    ...(r.measures ?? r.measure ?? []), ...(r.entities ?? []),
  ].join(' '))).join(' ');
  for (const c of checks) {
    if (!c.re.test(p)) continue;
    const covered = c.re.test(blob)
      || (c.label.includes('base') && analyticalReqs.some((r) => r.transform === 'base100'))
      || (c.label.includes('capitalisation') && analyticalReqs.some((r) => (r.measures ?? r.measure ?? []).some((m) => /market_?cap|capitalisation|total_market/i.test(m))))
      || (c.label.includes('série') && analyticalReqs.some((r) => (r.visualization ?? r.view) === 'line'))
      || (c.label.includes('classement') && analyticalReqs.some((r) => (r.visualization ?? r.view) === 'ranking'))
      || (c.label.includes('tableau') && analyticalReqs.some((r) => (r.visualization ?? r.view) === 'table'));
    if (!covered) gaps.push(`intention « ${c.label} » absente du contrat`);
  }

  // Contraintes design présentes dans le prompt doivent être capturées.
  if (DESIGN_RE.test(prompt) && !constraints.design.length && !analyticalReqs.some((r) => DESIGN_RE.test(r.label))) {
    // soft: only if prompt clearly asks design
    if (/(adopte|utilise|applique).{0,40}(design|th[eè]me|sombre)/i.test(prompt)) {
      gaps.push('contrainte de design absente des constraints.design');
    }
  }

  return gaps;
}

function hasAnalyticSignal(text: string): boolean {
  return /(kpi|capitalisation|volume|prix|classement|courbe|tableau|graphique|ratio|somme|nombre|part\b|donut|histogram)/i.test(text);
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

/** Budget LLM : 2 appels principaux + 1 correction max. */
export class LlmBudget {
  constructor(public readonly max = 3, public used = 0) {}
  take(n = 1): boolean {
    if (this.used + n > this.max) return false;
    this.used += n;
    return true;
  }
  get remaining() { return this.max - this.used; }
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
