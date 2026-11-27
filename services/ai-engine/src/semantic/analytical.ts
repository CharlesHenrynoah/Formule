import type { CatalogServer } from '../discovery/catalog.js';
import { llm } from '../llm.js';
import { fenceUntrusted } from '@formule/contracts';
import { NON_ADDITIVE } from './resolve.js';
import { norm, VIEW_KINDS, type ClauseFilter, type ReqTemplate, type Understanding, type ViewKind } from './lexicon.js';

/** Plafond du contrat d'application. Au-delà, l'excédent est une exigence explicite, jamais un oubli. */
export const REQ_CAP = 40;

const STOP = new Set(['avec', 'dans', 'pour', 'dans', 'les', 'des', 'une', 'sur', 'par', 'aux', 'que', 'qui', 'est', 'sont', 'cette', 'cette', 'tout', 'tous', 'toute', 'toutes', 'plus', 'moins', 'entre', 'comme', 'depuis', 'vers', 'alors', 'ainsi', 'donc', 'mais', 'dont', 'leur', 'leurs', 'nous', 'vous', 'elle', 'elles', 'ils', 'application', 'interface', 'graphique', 'graphiques', 'section', 'sections', 'demande', 'montre', 'afficher', 'affiche', 'creer', 'cree', 'construis', 'element', 'elements', 'objet', 'objets', 'ligne', 'lignes', 'donnee', 'donnees', 'actif', 'actifs', 'nombre', 'total', 'somme', 'moyenne', 'part', 'parts', 'ratio', 'classement', 'courbe', 'evolution', 'historique', 'liste', 'tableau', 'detail', 'circulaire', 'camembert', 'donut', 'histogramme', 'barres', 'barre', 'nuage', 'correlation', 'calendrier', 'hausse', 'baisse', 'positif', 'positive', 'negatif', 'negative']);

/** Découpe la consigne en clauses. Les puces et les phrases comptent toutes : rien n'est écarté ici. */
export function clausesOf(prompt: string): string[] {
  const lines = prompt.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const items = lines.filter((l) => /^(?:[-•*]|\d{1,2}[.)])\s+\S/.test(l)).map((l) => l.replace(/^(?:[-•*]|\d{1,2}[.)])\s+/, '').replace(/\*\*/g, '').trim());
  if (items.length >= 2) return items;
  return prompt.replace(/\*\*/g, '').split(/[\n.!?]+/).map((s) => s.trim()).filter((s) => s.length > 8);
}

function analytical(t: string) {
  return /(nombre|combien|effectif|compte|total|somme|cumul|moyenne|part|proportion|pourcentage|ratio|repartition|classement|top\b|courbe|evolution|historique|serie|circulaire|camembert|donut|histogramme|distribution|barres|nuage|correlation|heatmap|chaleur|calendrier|tableau|liste|detail|simulation|scenario|prix|quantite|montant|variation|hausse|baisse)/.test(t);
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

/** Filtres nommés par la clause. Ils font partie du contrat, pas d'un choix fait après la lecture. */
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
    const values = among[1].split(/,|\bet\b/i).map((x) => x.trim()).filter((x) => x.length > 1).slice(0, 12);
    if (values.length) out.push({ field: ['nom', 'name', 'libelle', 'categorie', 'type'], op: 'in', value: values });
  }
  const quoted = [...text.matchAll(/[«"“']([^»"”']{1,40})[»"”']/g)].map((m) => m[1].trim()).filter(Boolean);
  const named = text.match(/part (?:de |du |d['’]|des )([A-Za-zÀ-ÿ][\wÀ-ÿ-]{1,40})/i);
  const entity = quoted[0] ?? named?.[1];
  if (entity) out.push({ field: ['nom', 'name', 'libelle', 'titre', 'title'], op: 'eq', value: entity });
  return out.slice(0, 4);
}

export function measureWords(t: string): string[] {
  return [...new Set(norm(t).split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w)))].slice(0, 4);
}

function aggOf(t: string, view: ViewKind, measures: string[]): ReqTemplate['agg'] {
  if (/(nombre|combien|effectif|\bcompte\b|compter)/.test(t)) return 'count';
  if (/(part|proportion|pourcentage|ratio|repartition)/.test(t)) return 'ratio';
  if (/moyenne|en moyenne/.test(t)) return 'avg';
  if (/derniere|dernier|actuel/.test(t)) return 'last';
  if (/(somme|cumul|\btotal\b)/.test(t)) return 'sum';
  if (view === 'kpi' && measures.some((m) => NON_ADDITIVE.test(m))) return 'last';
  if (view === 'kpi' && !measures.length) return 'count';
  return undefined;
}

export function clauseToReq(text: string, index: number): ReqTemplate | null {
  const t = norm(text);
  if (!analytical(t)) return null;
  const view = viewOf(t);
  const where = filtersOf(text);
  const entity = where.find((w) => w.op === 'eq' && typeof w.value === 'string');
  const measures = measureWords(t).filter((w) => w !== norm(String(entity?.value ?? '')) && !/^(hausse|baisse|positif|negatif|superieur|inferieur)$/.test(w));
  const agg = aggOf(t, view, measures);
  const id = `${t.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 28) || 'clause'}_${index + 1}`.slice(0, 40);
  const share = agg === 'ratio';
  const two = measures.length >= 2 ? measures : undefined;
  return {
    id, label: text.slice(0, 120), mandatory: true, tool: ['*'], title: text.slice(0, 80), view,
    measure: measures.length ? (view === 'scatter' ? [measures[0]] : measures) : undefined,
    den: view === 'scatter' && two ? [two[1]] : undefined,
    label_: view === 'ranking' || view === 'donut' || view === 'bars' ? ['nom', 'name', 'libelle', 'categorie', 'famille'] : undefined,
    agg, where: where.length ? where : undefined,
    denWhere: share ? [] : undefined,
    percent: share,
    acceptance: `${view}${agg ? ` · ${agg}` : ''}${where.length ? ` · filtre ${where.map((w) => w.op).join(',')}` : ''}`,
  };
}

/** Contrat lu sur la consigne entière, avant toute acquisition. L'excédent est signalé, pas jeté en silence. */
export function readContract(prompt: string): ReqTemplate[] {
  const reqs = clausesOf(prompt).map(clauseToReq).filter((r): r is ReqTemplate => !!r);
  return capRequirements(reqs);
}

export function capRequirements(reqs: ReqTemplate[]): ReqTemplate[] {
  if (reqs.length <= REQ_CAP) return reqs;
  const dropped = reqs.slice(REQ_CAP - 1);
  const kept = reqs.slice(0, REQ_CAP - 1);
  kept.push({
    id: 'capacite_depassee', label: 'Exigences au-delà de la capacité', mandatory: true, tool: ['*'], view: 'note', title: 'Capacité',
    acceptance: `${dropped.length} exigences non analysées (capacité ${REQ_CAP}) : ${dropped.map((r) => r.label).join(' | ').slice(0, 180)}`,
  });
  return kept;
}

/**
 * Fige le contrat avant la lecture MCP.
 * Une recette déjà nommée reste telle quelle. Sinon la consigne décide de la vue, de l'opération et des filtres.
 * Le modèle peut seulement proposer des mots de mesure encore vides : il ne change ni la vue, ni l'agrégation, ni les filtres.
 */
export async function draftAnalytical(prompt: string, base: Understanding, catalog: CatalogServer[]): Promise<Understanding> {
  if (!base.generic && base.reqs.length) return { ...base, reqs: capRequirements(base.reqs) };
  let reqs = readContract(prompt);
  if (!reqs.length) return base;
  if (llm.name !== 'mock') reqs = await fillMeasures(prompt, reqs, catalog);
  return { ...base, mission: prompt.slice(0, 300), reqs, generic: false, simulation: reqs.some((r) => r.view === 'simulation') || base.simulation };
}

async function fillMeasures(prompt: string, reqs: ReqTemplate[], catalog: CatalogServer[]): Promise<ReqTemplate[]> {
  const cat = catalog.flatMap((s) => s.tools.filter((t) => t.permission === 'read').map((t) => t.name)).join(', ');
  const out = await llm.json<{ hints?: { id?: string; measure?: unknown }[] }>([
    { role: 'system', content: 'Tu proposes uniquement des mots de champs pour des exigences déjà figées. Tu ne changes ni la vue, ni l\'opération, ni les filtres. JSON : {"hints":[{"id":str,"measure":[str]}]}' },
    { role: 'user', content: `Consigne : ${prompt}\nOutils : ${fenceUntrusted('outils', cat)}\nExigences : ${JSON.stringify(reqs.map((r) => ({ id: r.id, label: r.label, view: r.view, agg: r.agg })))}` },
  ]);
  const hints = new Map((out?.hints ?? []).map((h) => [String(h.id ?? ''), Array.isArray(h.measure) ? h.measure.map((x) => norm(String(x))).filter((w) => w.length > 2).slice(0, 4) : []]));
  return reqs.map((r) => r.measure?.length || r.view === 'note' ? r : { ...r, measure: hints.get(r.id)?.length ? hints.get(r.id) : r.measure });
}
