/**
 * Moteur de graphiques générique : aucun fournisseur, aucun nom de champ en dur.
 * 1. profile()   : forme RÉELLE des données (types, cardinalités, signe, additivité, temps).
 * 2. intents()   : ce que la demande cherche à voir (tendance, part, classement, distribution, corrélation…).
 * 3. recommend() : uniquement les formes que la demande nomme. Aucun tableau de bord générique ajouté par défaut.
 */
import { getCollection, getPath, type ViewSpec } from '@formule/contracts';
import { norm } from './lexicon.js';
import { isSeries, NON_ADDITIVE, type Dataset } from './resolve.js';

export interface FieldProfile { rel: string; label: string; kind: 'measure' | 'category' | 'time' | 'name' | 'other'; distinct: number; filled: number; signed: boolean; additive: boolean; unit: string | null; skew: number; mentioned: boolean }
export interface Profile { rows: number; fields: FieldProfile[]; time: FieldProfile | null; name: FieldProfile | null; series: boolean; days: number }

const pretty = (rel: string) => rel.split('.').pop()!.replace(/_/g, ' ').replace(/ (eur|usd|gbp|chf|jpy)$/, '');
const ID = /(^|\.)(id|uuid|_id)$|_id$|(^|\.)(url|uri|link|href|path|sha|hash)$/;

/** Vocabulaire FR↔EN générique pour reconnaître un champ nommé dans la demande. */
const VOCAB: Record<string, string[]> = {
  prix: ['price', 'cost', 'amount'], montant: ['amount', 'total', 'value'], revenu: ['revenue', 'income', 'sales'],
  volume: ['volume'], telechargements: ['downloads'], likes: ['likes', 'stars'], capitalisation: ['market_cap', 'cap'],
  variation: ['change', 'delta', 'pct'], date: ['date', 'time', 'created', 'updated'], categorie: ['category', 'type', 'task', 'tag', 'kind'],
  pays: ['country', 'region'], famille: ['family', 'group', 'category'], groupe: ['group', 'family'], poids: ['weight', 'mass'], taille: ['size', 'length'], duree: ['duration'], nom: ['name', 'label', 'title'], statut: ['status', 'state'], temperature: ['temp'], score: ['score', 'rating'],
};
export function mentions(text: string, rel: string): boolean {
  const t = norm(text); const k = norm(pretty(rel));
  if (k.length >= 3 && t.includes(k)) return true;
  return Object.entries(VOCAB).some(([fr, en]) => t.includes(fr) && en.some((e) => k.includes(e)));
}

export function profile(ds: Dataset, text = ''): Profile | null {
  if (!ds.collection) return null;
  const rows = (getCollection(ds.acq.raw, ds.collection) ?? []) as unknown[];
  if (!rows.length) return null;
  const series = isSeries(ds);
  const fields: FieldProfile[] = ds.fields.map((f) => {
    const vals = rows.map((r) => getPath(r, f.rel)).filter((x) => x !== null && x !== undefined && x !== '');
    const distinct = new Set(vals.map((v) => JSON.stringify(v))).size;
    const nums = vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const isNum = f.type === 'number' && nums.length >= vals.length * 0.8;
    const isTime = f.role === 'time' || (typeof vals[0] === 'string' && /^\d{4}-\d{2}-\d{2}/.test(String(vals[0])));
    const mean = nums.reduce((a, b) => a + b, 0) / (nums.length || 1);
    const sorted = [...nums].sort((a, b) => a - b); const med = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const kind: FieldProfile['kind'] = ID.test(norm(f.rel)) ? 'other' : isTime ? 'time' : isNum && distinct > 1 ? 'measure'
      : f.type === 'string' && distinct >= 2 && distinct <= Math.min(24, rows.length - 1) ? 'category'
      : f.type === 'string' && distinct >= rows.length * 0.9 && /(name|nom|title|titre|symbol|label|libelle|id)$/.test(norm(f.rel)) ? 'name' : 'other';
    return { rel: f.rel, label: pretty(f.rel), kind, distinct, filled: vals.length / rows.length, signed: nums.some((n) => n < 0) && nums.some((n) => n > 0),
      additive: isNum && !NON_ADDITIVE.test(norm(f.rel)) && !nums.some((n) => n < 0), unit: f.unit ?? null,
      skew: med ? Math.abs(mean / med) : 1, mentioned: !!text && mentions(text, f.rel) };
  }).filter((f) => f.filled >= 0.5 && (f.kind !== 'measure' || (ds.fields.find((x) => x.rel === f.rel)?.units?.length ?? 0) <= 1));
  const time = series?.time ? fields.find((f) => f.rel === series.time.rel) ?? null : null;
  const name = fields.find((f) => f.kind === 'name') ?? null;
  const days = time ? new Set(rows.map((r) => String(getPath(r, time.rel) ?? '').slice(0, 10))).size : 0;
  return { rows: rows.length, fields, time, name, series: !!series, days };
}

export type Intent = 'trend' | 'share' | 'rank' | 'distribution' | 'correlation' | 'compare' | 'calendar';
export function intents(text: string): Set<Intent> {
  const t = norm(text); const s = new Set<Intent>();
  if (/(evolution|tendance|historique|au fil|dans le temps|trend|courbe|progression|jour|semaine|mois)/.test(t)) s.add('trend');
  if (/(part|repartition|proportion|mix|composition|pourcentage du total|share|camembert|donut|circulaire)/.test(t)) s.add('share');
  if (/(top|classement|meilleur|plus (grand|gros|eleve|populaire)|rank|leader|premiers)/.test(t)) s.add('rank');
  if (/(distribution|dispersion|histogramme|ecart|frequence|spread)/.test(t)) s.add('distribution');
  if (/(correlation|relation|lien entre|versus|\bvs\b|en fonction de|nuage|scatter)/.test(t)) s.add('correlation');
  if (/(compar|par categorie|par type|par segment|par pays|par statut|selon)/.test(t)) s.add('compare');
  if (/(calendrier|saisonnalite|heatmap|carte de chaleur|par jour de)/.test(t)) s.add('calendar');
  return s;
}

interface Candidate { view: ViewSpec; score: number; family: string; fields: string[]; intent: Intent | null }

/** Candidats notés pour un jeu de données. Les poids : adéquation (forme des données) + intention + champs nommés. */
export function candidates(qid: string, ds: Dataset, p: Profile, want: Set<Intent>): Candidate[] {
  const coll = ds.collection!; const out: Candidate[] = []; const id = (s: string) => `vz_${qid.slice(-12)}_${s}`;
  const M = p.fields.filter((f) => f.kind === 'measure').sort((a, b) => Number(b.mentioned) - Number(a.mentioned));
  const C = p.fields.filter((f) => f.kind === 'category').sort((a, b) => Number(b.mentioned) - Number(a.mentioned) || a.distinct - b.distinct);
  const add = (family: string, view: ViewSpec, base: number, intent: Intent | null, fields: FieldProfile[]) =>
    out.push({ view, family, intent, fields: fields.map((f) => f.rel), score: base + (intent && want.has(intent) ? 30 : 0) + fields.filter((f) => f.mentioned).length * 12 });
  const m0 = M[0]; const mA = M.find((m) => m.additive);

  // tendance : courbe multi-séries (mesures comparables = même unité)
  if (p.series && p.time && m0 && p.rows >= 3) {
    const same = M.filter((m) => m.unit === m0.unit).slice(0, 3);
    add('trend', { kind: 'line', id: id('lin'), title: `Évolution · ${same.map((m) => m.label).join(', ')}`, queryId: qid, requirementIds: [], bindings: { collection: coll, t: p.time.rel, series: same.map((m) => ({ path: m.rel, label: m.label.slice(0, 40), unit: m.unit })) } }, 40, 'trend', same);
    if (p.days >= 20) add('calendar', { kind: 'heatmap', id: id('cal'), title: `Calendrier · ${m0.label}`, queryId: qid, requirementIds: [], bindings: { collection: coll, t: p.time.rel, v: m0.rel, agg: 'avg', unit: m0.unit } }, 22 + Math.min(10, p.days / 10), 'calendar', [m0]);
  }
  // instantané d'éléments nommés
  if (!p.series && p.name && p.rows >= 3) {
    for (const m of M.slice(0, 3)) {
      const signed = m.signed;
      add(signed ? 'diverging' : 'rank', { kind: 'bars', id: id(`b${m.rel.length}${m.label.slice(0, 3)}`), title: `${m.label} par ${p.name.label}`, queryId: qid, requirementIds: [], bindings: { collection: coll, label: p.name.rel, metric: m.rel, agg: 'sum', unit: m.unit, limit: 12 } }, signed ? 34 : 26 - M.indexOf(m) * 4, signed ? 'compare' : 'rank', [m, p.name]);
    }
    if (mA && p.rows <= 60) add('share', { kind: 'donut', id: id('prt'), title: `Part · ${mA.label}`, queryId: qid, requirementIds: [], bindings: { collection: coll, label: p.name.rel, metric: mA.rel, agg: 'sum', unit: mA.unit, limit: 7 } }, 18 + (mA.skew > 2 ? 8 : 0), 'share', [mA, p.name]);
  }
  // catégories : part (≤ 7 modalités lisibles) et comparaison (barres)
  for (const c of C.slice(0, 2)) {
    const mm = mA ?? null;
    if (c.distinct <= 8) add('share', { kind: 'donut', id: id(`d${C.indexOf(c)}`), title: mm ? `Répartition · ${mm.label} par ${c.label}` : `Répartition par ${c.label}`, queryId: qid, requirementIds: [], bindings: { collection: coll, label: c.rel, metric: mm?.rel, agg: mm ? 'sum' : 'count', unit: mm?.unit ?? null, limit: 7 } }, 24 - C.indexOf(c) * 6, 'share', mm ? [c, mm] : [c]);
    add('compare', { kind: 'bars', id: id(`c${C.indexOf(c)}`), title: mm && !c.mentioned ? `${mm.label} par ${c.label}` : `Nombre par ${c.label}`, queryId: qid, requirementIds: [], bindings: { collection: coll, label: c.rel, metric: mm && !c.mentioned ? mm.rel : undefined, agg: mm && !c.mentioned ? 'sum' : 'count', unit: mm && !c.mentioned ? mm.unit : null, limit: 10 } }, 22 + (c.distinct > 8 ? 6 : 0) - C.indexOf(c) * 6, 'compare', [c]);
  }
  // distribution : utile quand la mesure est étalée (asymétrie) et qu'il y a assez de points
  if (m0 && p.rows >= 10) add('distribution', { kind: 'histogram', id: id('his'), title: `Distribution · ${m0.label}`, queryId: qid, requirementIds: [], bindings: { collection: coll, v: m0.rel, bins: Math.min(24, Math.max(6, Math.round(Math.sqrt(p.rows)))), unit: m0.unit } }, 14 + Math.min(12, (m0.skew - 1) * 6), 'distribution', [m0]);
  // corrélation : deux mesures distinctes (pas la même grandeur en double)
  if (M.length >= 2 && p.rows >= 8) {
    const [a, b] = [M[0], M.find((m) => m.unit !== M[0].unit || m.label.split(' ')[0] !== M[0].label.split(' ')[0]) ?? M[1]];
    const color = C.find((c) => c.distinct <= 8);
    add('correlation', { kind: 'scatter', id: id('sca'), title: `${a.label} × ${b.label}`, queryId: qid, requirementIds: [], bindings: { collection: coll, x: a.rel, y: b.rel, xLabel: a.label, yLabel: b.label, xUnit: a.unit, yUnit: b.unit, color: color?.rel } }, 16 + (p.rows >= 30 ? 6 : 0), 'correlation', [a, b]);
  }
  return out;
}

/** Sélection : seulement les familles demandées. Sans intention de graphique, aucune vue n'est ajoutée. */
export function recommend(views: ViewSpec[], datasets: Map<string, Dataset>, queryIds: string[], text = '', budgetPerQuery = 5) {
  const want = intents(text);
  const covered = (v: ViewSpec) => views.some((x) => x.kind === v.kind && (x as { queryId?: string }).queryId === (v as { queryId?: string }).queryId && JSON.stringify(x.bindings) === JSON.stringify(v.bindings));
  for (const qid of queryIds) {
    const ds = datasets.get(qid);
    if (!ds?.collection || ds.acq.envelope.status === 'error') continue;
    const p = profile(ds, text); if (!p || p.rows < 3) continue;
    // mini-courbe sur les KPI quand le temps existe
    if (want.has('trend') && p.series && p.time) for (const v of views) if (v.kind === 'kpi' && v.queryId === qid && v.bindings.aggregate?.measure && !v.bindings.spark && v.bindings.aggregate.agg !== 'ratio')
      v.bindings.spark = { collection: ds.collection, t: p.time.rel, v: v.bindings.aggregate.measure };
    const existingKinds = new Set(views.filter((v) => (v as { queryId?: string }).queryId === qid).map((v) => v.kind));
    // La demande est la source de vérité : une forme non citée n'est pas substituée par un graphique générique.
    const cands = (want.size ? candidates(qid, ds, p, want).filter((c) => c.intent && want.has(c.intent)) : [])
      .map((c) => ({ ...c, score: c.score - (existingKinds.has(c.view.kind) ? 15 : 0) })).sort((a, b) => b.score - a.score);
    const families = new Set<string>(); const pairs = new Set<string>(); let n = 0;
    for (const pass of [0, 1]) for (const c of cands) {
      if (n >= budgetPerQuery || views.length >= 28) break;
      const key = `${c.view.kind}:${c.fields.sort().join('|')}`;
      if (pairs.has(key) || covered(c.view) || views.some((v) => v.id === c.view.id)) continue;
      if (pass === 0 && families.has(c.family)) continue;
      if (c.score < 15) continue;
      views.push(c.view); families.add(c.family); pairs.add(key); n++;
    }
  }
}
