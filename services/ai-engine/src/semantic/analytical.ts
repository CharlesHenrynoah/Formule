import type { CatalogServer } from '../discovery/catalog.js';
import { NON_ADDITIVE } from './resolve.js';
import { norm, VIEW_KINDS, type ClauseFilter, type OrderDir, type ReqTemplate, type Understanding, type ViewKind } from './lexicon.js';

/** Parse local des sections — évite la dépendance circulaire avec sections.ts. */
function localSections(prompt: string): { title: string; kind: 'kpi' | 'data' | 'acquisition' | 'design' | 'other'; bullets: string[]; body: string }[] {
  const lines = prompt.replace(/\r/g, '').split('\n');
  const sections: { title: string; kind: 'kpi' | 'data' | 'acquisition' | 'design' | 'other'; bullets: string[]; body: string }[] = [];
  let cur: (typeof sections)[number] | null = null;
  for (const raw of lines) {
    const l = raw.trim();
    const h = l.match(/^(?:#{1,4}\s*)?(?:\*\*)?\s*(\d{1,2})\s*[.)]\s*(.+?)\s*(?:\*\*)?\s*$/);
    if (h && !/^[-•*]\s/.test(l)) {
      const title = h[2].replace(/\*\*/g, '').trim();
      const t = norm(title);
      const kind = /indicateurs?|kpi|chiffres? cles?|synthese/.test(t) ? 'kpi' as const
        : /acquisition|sources?|outils?|connexion/.test(t) ? 'acquisition' as const
          : /design|style|apparence|theme|charte/.test(t) ? 'design' as const : 'data' as const;
      cur = { title, kind, bullets: [], body: '' }; sections.push(cur); continue;
    }
    if (!cur) continue;
    if (/^[-•*]\s+/.test(l)) cur.bullets.push(l.replace(/^[-•*]\s+/, '').trim());
    if (l) cur.body += `${l}\n`;
  }
  return sections;
}

/** Plafond du contrat d'application. Au-delà, l'excédent est une exigence explicite, jamais un oubli. */
export const REQ_CAP = 40;

const STOP = new Set(['avec', 'dans', 'pour', 'dans', 'les', 'des', 'une', 'sur', 'par', 'aux', 'que', 'qui', 'est', 'sont', 'cette', 'cette', 'tout', 'tous', 'toute', 'toutes', 'plus', 'moins', 'entre', 'comme', 'depuis', 'vers', 'alors', 'ainsi', 'donc', 'mais', 'dont', 'leur', 'leurs', 'nous', 'vous', 'elle', 'elles', 'ils', 'application', 'interface', 'graphique', 'graphiques', 'section', 'sections', 'demande', 'montre', 'afficher', 'affiche', 'creer', 'cree', 'construis', 'element', 'elements', 'objet', 'objets', 'ligne', 'lignes', 'donnee', 'donnees', 'actif', 'actifs', 'nombre', 'total', 'somme', 'moyenne', 'part', 'parts', 'ratio', 'classement', 'courbe', 'evolution', 'historique', 'liste', 'tableau', 'detail', 'circulaire', 'camembert', 'donut', 'histogramme', 'barres', 'barre', 'nuage', 'correlation', 'calendrier', 'hausse', 'baisse', 'positif', 'positive', 'negatif', 'negative', 'valeur', 'identite', 'permet', 'permets', 'permettre', 'veut', 'veux', 'voudrais', 'besoin', 'aussi', 'encore', 'apres', 'avant', 'selon', 'contre', 'trois', 'deux', 'quatre', 'cinq', 'cryptomonnaie', 'cryptomonnaies', 'crypto', 'cryptos', 'intelligence', 'market', 'compare', 'comparaison', 'base']);

const GLOBAL_CONSTRAINT = /(onglet|tab\b|curseur|slider|portefeuille|virtual|virtuel|capital de|acheter|vendre|rafraich|refresh|reset|bouton|couleur|theme|style|layout|responsive|mobile)/;

function analytical(t: string) {
  return /(nombre|combien|effectif|compte|total|somme|cumul|moyenne|part|proportion|pourcentage|ratio|repartition|classement|top\b|courbe|evolution|historique|serie|circulaire|camembert|donut|histogramme|distribution|barres|nuage|correlation|heatmap|chaleur|calendrier|tableau|liste|detail|simulation|scenario|prix|quantite|montant|variation|hausse|baisse|valeur (?:de|du|des)|identit)/.test(t);
}

/** Découpe atomique : une exigence = une opération + une visualisation. Conserve sujet et opération. */
export function atomicSplit(text: string): string[] {
  const clean = text.replace(/\*\*/g, '').trim();
  if (!clean) return [];
  const pair = clean.match(/^(.*?)(?:en\s+)?(hausse|baisse)\s+et\s+(?:en\s+)?(hausse|baisse)(.*)$/i);
  if (pair && pair[2].toLowerCase() !== pair[3].toLowerCase() && /nombre|combien|effectif|compter/i.test(pair[1])) {
    const prefix = pair[1].trim().replace(/\ben$/i, '').trim();
    return [prefix + ' en ' + pair[2] + pair[4], prefix + ' en ' + pair[3] + pair[4]];
  }
  if (/\b(?:parmi|entre|exactement)\b/i.test(clean)) return [clean];
  const parts = clean.split(/\s*(?:;|\bet puis\b|\bpuis\b|\bet aussi\b|\ainsi que\b)\s+/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const kept = parts.filter((p) => analytical(norm(p)) || GLOBAL_CONSTRAINT.test(norm(p)));
    if (kept.length > 1) return kept.map((p, i) => retainSubject(clean, p, i === 0 ? null : parts[0]));
  }
  const andSplit = clean.split(/\s+\bet\b\s+/i).map((s) => s.trim()).filter(Boolean);
  if (andSplit.length > 1 && andSplit.filter((p) => analytical(norm(p))).length >= 2) {
    return andSplit.filter((p) => analytical(norm(p))).map((p, i) => retainSubject(clean, p, i === 0 ? null : andSplit[0]));
  }
  return [clean];
}

/** Si un fragment a perdu le sujet ou l'opération, on les réattache depuis la clause mère. */
function retainSubject(parent: string, fragment: string, head: string | null): string {
  const f = norm(fragment);
  const hasOp = /(nombre|somme|total|moyenne|part|ratio|classement|courbe|circulaire|histogramme|barres|tableau|prix|montant|valeur)/.test(f);
  if (hasOp && /[A-Za-zÀ-ÿ]{3,}/.test(fragment)) return fragment;
  if (head && !hasOp) return `${head.replace(/[,:].*$/, '').trim()} ${fragment}`.trim();
  if (!hasOp) {
    const op = parent.match(/(nombre|somme|total|moyenne|part|classement|courbe|graphique circulaire|histogramme|barres|prix|montant|valeur)[^.|;]*/i);
    if (op) return `${op[0].trim()} ${fragment}`.trim();
  }
  return fragment;
}

/**
 * Analyse l'intégralité du prompt. Conserve la hiérarchie des sections.
 * Les sections design / acquisition deviennent des contraintes globales, pas des exigences analytiques.
 */
export function clausesOf(prompt: string): { analytical: string[]; design: string[]; sectionOf: Map<string, string> } {
  const sectionOf = new Map<string, string>();
  const design: string[] = [];
  const analyticalClauses: string[] = [];
  const sections = localSections(prompt);
  if (sections.length >= 2) {
    for (const s of sections) {
      const prose = s.body.split('\n').filter((x) => x.trim() && !/^[-•*]\s+/.test(x.trim()) && !/^colonnes?\s*:/i.test(x.trim()));
      const table = prose.find((x) => /\btableau\b/i.test(x));
      if (s.kind === 'data' && table && s.bullets.length && /colonnes?\s*:/i.test(s.body)) {
        analyticalClauses.push(table.trim());
        sectionOf.set(table.trim(), s.title.slice(0, 40));
        continue;
      }
      const items = [...prose, ...s.bullets].flatMap(atomicSplit).filter((x) => x.length > 2);
      if (s.kind === 'design' || s.kind === 'acquisition') {
        for (const it of items) design.push(it);
        continue;
      }
      for (const it of items) {
        if (GLOBAL_CONSTRAINT.test(norm(it)) && !analytical(norm(it))) { design.push(it); continue; }
        if (!analytical(norm(it))) continue;
        analyticalClauses.push(it);
        sectionOf.set(it, s.title.slice(0, 40));
      }
    }
    if (analyticalClauses.length) return { analytical: analyticalClauses, design, sectionOf };
  }
  const lines = prompt.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const items = lines.filter((l) => /^(?:[-•*]|\d{1,2}[.)])\s+\S/.test(l)).map((l) => l.replace(/^(?:[-•*]|\d{1,2}[.)])\s+/, '').replace(/\*\*/g, '').trim());
  const base = (items.length >= 2 ? items : prompt.replace(/\*\*/g, '').split(/[\n.!?]+/).map((s) => s.trim()).filter((s) => s.length > 8)).flatMap(atomicSplit);
  for (const it of base) {
    if (GLOBAL_CONSTRAINT.test(norm(it)) && !analytical(norm(it))) design.push(it);
    else if (analytical(norm(it))) analyticalClauses.push(it);
  }
  return { analytical: analyticalClauses, design, sectionOf };
}

export function viewOf(t: string): ViewKind {
  if (/(circulaire|camembert|donut|repartition)/.test(t)) return 'donut';
  if (/(histogramme|distribution)/.test(t)) return 'histogram';
  if (/(nuage|correlation|en fonction de)/.test(t)) return 'scatter';
  if (/(heatmap|carte de chaleur|calendrier)/.test(t)) return 'heatmap';
  if (/\bbarr?es?\b/.test(t)) return 'bars';
  if (/(classement|palmares|\btop\b)/.test(t)) return 'ranking';
  if (/(courbe|evolution|historique|serie temporelle|au fil)/.test(t)) return 'line';
  if (/(simulation|scenario|curseur)/.test(t)) return 'simulation';
  if (/(tableau|liste|detail)/.test(t)) return 'table';
  return 'kpi';
}

function num(s: string) {
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

export function filtersOf(text: string): ClauseFilter[] {
  const t = norm(text);
  const out: ClauseFilter[] = [];
  const between = t.match(/entre (-?\d+(?:[.,]\d+)?) et (-?\d+(?:[.,]\d+)?)/);
  if (between) {
    const lo = num(between[1]), hi = num(between[2]);
    if (lo !== undefined && hi !== undefined) out.push({ field: measureWords(t).length ? measureWords(t) : ['valeur', 'value'], op: 'between', value: [lo, hi] });
  }
  const cmp = t.match(/(superieur(?:e|es)?|plus de|plus grand(?:e)? que|inferieur(?:e|es)?|moins de|au moins|au plus)\s+(?:a\s+)?(-?\d+(?:[.,]\d+)?)/);
  if (cmp) {
    const n = num(cmp[2]);
    const op = /inferieur|moins de/.test(cmp[1]) ? 'lt' : /au plus/.test(cmp[1]) ? 'lte' : /au moins/.test(cmp[1]) ? 'gte' : 'gt';
    if (n !== undefined) out.push({ field: measureWords(t).length ? measureWords(t) : ['valeur', 'value'], op, value: n });
  }
  if (!out.length && /hausse|positif/.test(t)) out.push({ field: ['variation', 'change', 'delta', 'ecart'], op: 'gt', value: 0 });
  if (!out.length && /baisse|negatif/.test(t)) out.push({ field: ['variation', 'change', 'delta', 'ecart'], op: 'lt', value: 0 });
  const among = text.match(/parmi\s+([^.\n]+)/i);
  if (among) {
    const values = among[1].split(/,|\bet\b/i).map((x) => x.trim()).filter((x) => x.length > 1 && x.length <= 40 && x.split(/\s+/).length <= 3).slice(0, 12);
    if (values.length) out.push({ field: ['nom', 'name', 'libelle', 'categorie', 'type', 'symbol'], op: 'in', value: values });
  }
  const quoted = [...text.matchAll(/[«"“']([^»"”']{1,40})[»"”']/g)].map((m) => m[1].trim()).filter((x) => x.split(/\s+/).length <= 3);
  const named = text.match(/part (?:de |du |d['’]|des )(?:l['’])?([A-Za-zÀ-ÿ][\wÀ-ÿ-]{1,40})/i)
    ?? text.match(/(?:valeur|prix|montant|cours) (?:de |du |d['’]|des )(?:l['’])?([A-Za-zÀ-ÿ][\wÀ-ÿ-]{1,40})/i);
  const entity = quoted[0] ?? named?.[1];
  if (entity && entity.length <= 40) out.push({ field: ['nom', 'name', 'libelle', 'titre', 'title', 'symbol'], op: 'eq', value: entity });
  return out.slice(0, 4);
}

export function measureWords(t: string): string[] {
  return [...new Set(norm(t).split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w)))].slice(0, 4);
}

function durationOf(t: string): string | undefined {
  const relative = t.match(/\b(\d{1,3})\s*(?:derniers?\s+)?(jours?|heures?|h\b)/);
  return relative ? relative[1] + (relative[2].startsWith('h') ? ' heures' : ' jours') : undefined;
}

function periodOf(t: string): string | undefined {
  if (!/(courbe|historique|serie temporelle|evolution|depuis|pendant)/.test(t) &&
      /(?:volume|variation|change|rendement|performance|transactions|hausse|baisse)/.test(t) && durationOf(t)) return undefined;
  const relative = durationOf(t);
  if (relative) return relative;
  const m = t.match(/\b(janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre|(?:19|20)\d{2}|annee|mois|semaine|jour)\b/);
  return m?.[1];
}

const MONTHS: Record<string, number> = { janvier: 0, fevrier: 1, mars: 2, avril: 3, mai: 4, juin: 5, juillet: 6, aout: 7, septembre: 8, octobre: 9, novembre: 10, decembre: 11 };

/** Intervalle temporel réel pour une période nommée — jamais une simple inclusion de chaîne ISO. */
export function periodInterval(period: string, refMs = Date.now()): { start: number; end: number } | null {
  const p = norm(period).replace(/\s+/g, ' ').trim();
  const ref = new Date(refMs);
  const duration = p.match(/^(\d{1,3})\s*(jours?|heures?)$/);
  if (duration && Number(duration[1]) > 0) return { start: refMs - Number(duration[1]) * (duration[2].startsWith('jour') ? 86400_000 : 3600_000), end: refMs };
  if (/^\d{4}$/.test(p)) {
    const y = Number(p);
    return { start: Date.UTC(y, 0, 1), end: Date.UTC(y + 1, 0, 1) - 1 };
  }
  const month = MONTHS[p];
  if (month !== undefined) {
    const y = ref.getUTCFullYear();
    return { start: Date.UTC(y, month, 1), end: Date.UTC(y, month + 1, 1) - 1 };
  }
  if (/24\s*h/.test(p) || p === 'jour') return { start: refMs - 24 * 3600_000, end: refMs };
  if (/7\s*jours|semaine/.test(p)) return { start: refMs - 7 * 24 * 3600_000, end: refMs };
  if (/30\s*jours|mois/.test(p) && !MONTHS[p]) return { start: refMs - 30 * 24 * 3600_000, end: refMs };
  if (/annee/.test(p)) return { start: Date.UTC(ref.getUTCFullYear(), 0, 1), end: refMs };
  return null;
}

function unitOf(t: string): string | undefined {
  if (/\beur\b|euro/.test(t)) return 'EUR';
  if (/\busd\b|dollar/.test(t)) return 'USD';
  if (/\bgbp\b|livre/.test(t)) return 'GBP';
  if (/\bpct\b|pourcent/.test(t)) return '%';
  return undefined;
}

function grainOf(t: string): string | undefined {
  if (/par jour|quotidien|journalier/.test(t)) return 'day';
  if (/par semaine|hebdo/.test(t)) return 'week';
  if (/par mois|mensuel/.test(t)) return 'month';
  if (/par an|annuel/.test(t)) return 'year';
  if (/horaire|par heure/.test(t)) return 'hour';
  return undefined;
}

function populationOf(text: string, _t: string): string | undefined {
  const explicit = text.match(/(?:\bpopulation\s*[:=]\s*|\b(?:march[eé]|univers)\s+)([^.\n,]{3,60})/i);
  if (!explicit) return undefined;
  const value = explicit[1].replace(/\s+(?:en|sur|pendant|depuis)\s+(?:les\s+)?(?:\d|janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre).*$/i, '').trim();
  return value || undefined;
}

const WORD_NUM: Record<string, number> = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10 };

function limitOf(t: string): number | undefined {
  const m = t.match(/(?:top|premier(?:s)?|limite(?:e)?\s+a)\s+(\d{1,3})/)
    ?? t.match(/\b(\d{1,3})\s+premier(?:e)?s?\b/)
    ?? t.match(/\b(?:ces|des|les|de)\s+(\d{1,3})\s+(?:actifs?|produits?|articles?|elements?|lignes?|entites?|clients?|magasins?|cryptos?|cryptomonnaies?|tokens?|coins?)\b/)
    ?? t.match(/\btableau\s+(?:de|des)\s+(\d{1,3})\b/);
  if (m) return Number(m[1]);
  const w = t.match(/\b(?:ces|des|les|de|un\s+tableau\s+de)\s+(un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)\s+(?:actifs?|cryptos?|cryptomonnaies?|tokens?|coins?|elements?)\b/);
  if (w && WORD_NUM[w[1]]) return WORD_NUM[w[1]];
  return undefined;
}

function orderOf(t: string): OrderDir | undefined {
  if (/\b(?:decroissant(?:e)?s?|descendant(?:e)?s?|top)\b|du plus grand/.test(t)) return 'desc';
  if (/\b(?:croissant(?:e)?s?|ascendant(?:e)?s?)\b|du plus petit/.test(t)) return 'asc';
  return undefined;
}

function aggOf(t: string, view: ViewKind, measures: string[], entities: string[]): ReqTemplate['agg'] {
  if (/(nombre|combien|effectif|\bcompte\b|compter)/.test(t)) return 'count';
  if (/(part|proportion|pourcentage|ratio|repartition)/.test(t) && view === 'kpi') return 'ratio';
  if (/moyenne|en moyenne/.test(t)) return 'avg';
  if (view === 'line' || view === 'table') return undefined;
  if (view === 'bars' && measures.some((m) => NON_ADDITIVE.test(m))) return 'identity';
  if (view === 'kpi' && entities.length && /actuel/.test(t)) return 'identity';
  if (/derniere|dernier|actuel/.test(t)) return 'last';
  if (/(somme|cumul|\btotal\b)/.test(t)) return 'sum';
  // Mesure brute d'une entité nommée : identité, jamais un comptage implicite.
  if (entities.length && measures.length && /(valeur|prix|montant|cours)/.test(t) && !/(nombre|somme|total|moyenne|part)/.test(t)) return 'identity';
  if (view === 'kpi' && entities.length && measures.length && !/(nombre|somme|total|moyenne|part|classement)/.test(t)) return 'identity';
  if (view === 'kpi' && measures.some((m) => NON_ADDITIVE.test(m))) return 'last';
  if (view === 'kpi' && !measures.length) return 'count';
  return undefined;
}

export function clauseToReq(text: string, index: number, section?: string, design?: string, parentId?: string): ReqTemplate | null {
  const t = norm(text);
  if (!analytical(t)) return null;
  const view = viewOf(t);
  const where = filtersOf(text);
  const entityFilters = where.filter((w) => (w.op === 'eq' || w.op === 'in') && ['nom', 'name', 'libelle', 'titre', 'title'].some((f) => w.field.includes(f)));
  const entities = entityFilters.flatMap((w) => Array.isArray(w.value) ? w.value.map(String) : w.value !== undefined ? [String(w.value)] : []);
  const measures = measureWords(t).filter((w) => !entities.some((e) => norm(e) === w) && !/^(hausse|baisse|positif|negatif|superieur|inferieur)$/.test(w));
  const agg = aggOf(t, view, measures, entities);
  const id = `${t.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 28) || 'clause'}_${index + 1}`.slice(0, 40);
  const share = agg === 'ratio';
  const two = measures.length >= 2 ? measures : undefined;
  const period = periodOf(t);
  const grain = grainOf(t);
  const population = populationOf(text, t);
  const limit = limitOf(t);
  const order = orderOf(t);
  const inputUnit = unitOf(t);
  const unit = share ? '%' : inputUnit;
  const transform = /(base\s*100|rebase|index[eé]|normalis[eé]e?\s+a\s+100)/.test(t) && view === 'line' ? 'base100' as const : undefined;
  const scopeSize = ['kpi','bars','donut'].includes(view) ? limit : undefined;
  const measureWindow = !period ? durationOf(t) : undefined;
  const sectionId = section ? `sec_${norm(section).replace(/[^a-z0-9]+/g, '_').slice(0, 20)}` : undefined;
  const dimensions = view === 'ranking' || view === 'donut' || view === 'bars' || view === 'table' ? ['nom', 'name', 'libelle', 'categorie'] : undefined;
  // Les colonnes explicites sont extraites de la structure du document, pas des mots-clés du titre.
  const columns = undefined;
  return {
    id, label: text.slice(0, 120), mandatory: true, tool: ['*'], title: text.slice(0, 80),
    view, visualization: view,
    measure: measures.length ? (view === 'scatter' ? [measures[0]] : measures) : undefined,
    measures: measures.length ? measures : undefined,
    den: view === 'scatter' && two ? [two[1]] : undefined,
    label_: dimensions,
    dimensions,
    columns,
    agg, operation: agg,
    where: where.length ? where : undefined,
    filters: where.length ? where : undefined,
    denWhere: share ? [] : undefined,
    percent: share,
    entities: entities.length ? entities : undefined,
    population, limit, period, grain, order, unit, transform, measureWindow, scopeSize, inputUnit: share && inputUnit !== '%' ? inputUnit : undefined,
    section, design, parentId: parentId ?? sectionId,
    acceptance: [
      view, agg ? `op:${agg}` : null, transform ? `transform:${transform}` : null,
      where.length ? `filtre:${where.map((w) => w.op).join(',')}` : null,
      entities.length ? `entite:${entities.join(',')}` : null, population ? `pop:${population}` : null,
      period ? `periode:${period}` : null, grain ? `grain:${grain}` : null, unit ? `unite:${unit}` : null,
      limit != null ? `limit:${limit}` : null,
    ].filter(Boolean).join(' · ').slice(0, 300),
  };
}

/** Contrat lu sur la consigne entière, avant toute acquisition. */
export function readContract(prompt: string): ReqTemplate[] {
  const { analytical, design, sectionOf } = clausesOf(prompt);
  const designNote = design.length ? design.join(' | ').slice(0, 200) : undefined;
  const reqs = analytical.map((text, i) => clauseToReq(text, i, sectionOf.get(text), designNote)).filter((r): r is ReqTemplate => !!r);
  for (const r of reqs) {
    if (r.view !== 'table') continue;
    const sec = localSections(prompt).find((s) => s.title.slice(0, 40) === r.section);
    if (!sec?.bullets.length || !/colonnes?\s*:/i.test(sec.body)) continue;
    r.columns = sec.bullets.map((x) => x.replace(/[.]+$/, '').trim()).slice(0, 12);
    const list = r.label.match(/(?:exactement|uniquement|seulement).*?:\s*(.+?)[.]?$/i);
    if (list) {
      r.entities = list[1].split(/,|\bet\b/i).map((x) => x.trim()).filter(Boolean);
      r.filters = r.where = [{ field: ['nom', 'name', 'libelle', 'titre', 'title'], op: 'in', value: r.entities }];
    }
  }
  // Table → colonnes : parentId pointe vers l'exigence tableau de la même section.
  for (const r of reqs) {
    if (r.view === 'table' || !r.section) continue;
    const parent = reqs.find((p) => p.view === 'table' && p.section === r.section);
    if (parent && parent.id !== r.id) (r as { parentId?: string }).parentId = parent.id;
  }
  return freezeReqs(capRequirements(reqs));
}

export function capRequirements(reqs: ReqTemplate[]): ReqTemplate[] {
  if (reqs.length <= REQ_CAP) return reqs;
  const dropped = reqs.slice(REQ_CAP - 1);
  const kept = reqs.slice(0, REQ_CAP - 1);
  kept.push({
    id: 'capacite_depassee', label: 'Exigences au-delà de la capacité', mandatory: true, tool: ['*'], view: 'note', visualization: 'note', title: 'Capacité',
    acceptance: `${dropped.length} exigences non analysées (capacité ${REQ_CAP}) : ${dropped.map((r) => r.label).join(' | ').slice(0, 180)}`,
  });
  return kept;
}

export function freezeReqs(reqs: ReqTemplate[]): ReqTemplate[] {
  return reqs.map((r) => Object.freeze({
    ...r,
    where: r.where ? Object.freeze([...r.where]) : undefined,
    filters: r.filters ? Object.freeze([...r.filters]) : undefined,
    denWhere: r.denWhere ? Object.freeze([...r.denWhere]) : undefined,
    measure: r.measure ? Object.freeze([...r.measure]) : undefined,
    measures: r.measures ? Object.freeze([...r.measures]) : undefined,
    den: r.den ? Object.freeze([...r.den]) : undefined,
    time: r.time ? Object.freeze([...r.time]) : undefined,
    label_: r.label_ ? Object.freeze([...r.label_]) : undefined,
    entities: r.entities ? Object.freeze([...r.entities]) : undefined,
    dimensions: r.dimensions ? Object.freeze([...r.dimensions]) : undefined,
    columns: r.columns ? Object.freeze([...r.columns]) : undefined,
    series: r.series ? Object.freeze(r.series.map((s) => Object.freeze([...s]))) : undefined,
    covers: r.covers ? Object.freeze([...r.covers]) : undefined,
    tool: Object.freeze([...r.tool]),
  }));
}

export type { HybridPlan as AnalyticalDraft } from './hybrid.js';

/**
 * AI-first : le LLM construit le contrat intégral depuis le prompt.
 * Pas de readContract / atomicSplit comme source d'intentions.
 * Échec → ok=false (signal explicite), jamais un contrat syntaxique « équivalent ».
 */
export async function draftAnalytical(prompt: string, base: Understanding, catalog: CatalogServer[], options?: { budget?: import('./contract-guard.js').LlmBudget }) {
  const { interpretAndPlan } = await import('./hybrid.js');
  return interpretAndPlan(prompt, catalog, base, options);
}

export { VIEW_KINDS };
