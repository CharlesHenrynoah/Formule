/**
 * Demandes structurées en sections (« 1. Indicateurs », « 2. Radar »…) : une requête par section de données,
 * une exigence par puce (couverte si un champ RÉEL la porte, sinon « Donnée indisponible » avec la raison),
 * des KPI calculés sur les sections, le style tiré de la section « Design ». Rien n'est bloqué tant qu'une
 * section a des données : le reste est livré étiqueté.
 */
import type { AppSpec, Requirement, ViewSpec, QuerySpec } from '@formule/contracts';
import { getCollection, getPath } from '@formule/contracts';
import type { Acquired, CatalogServer, ToolRef } from '../discovery/catalog.js';
import { rankTools, resolveArgs } from '../discovery/catalog.js';
import { intentTokens } from '../discovery/args-synth.js';
import { clauseToReq, filtersOf } from './analytical.js';
import { datasetOf, isSeries, NON_ADDITIVE, resolveRequirement, type Dataset } from './resolve.js';
import { recommend } from './charts.js';
import { norm } from './lexicon.js';
import { taxonomyFor } from '../packs.js';

export interface Section { n: number; title: string; body: string; bullets: string[]; kind: 'kpi' | 'data' | 'acquisition' | 'design' | 'other' }
export interface Parsed { title: string | null; intro: string; sections: Section[]; excluded: string[]; directives: { tool: string; text: string }[] }

export function parseSections(prompt: string): Parsed {
  const lines = prompt.replace(/\r/g, '').split('\n');
  const sections: Section[] = []; const intro: string[] = [];
  let cur: Section | null = null;
  for (const raw of lines) {
    const l = raw.trim();
    const h = l.match(/^(?:#{1,4}\s*)?(?:\*\*)?\s*(\d{1,2})\s*[.)]\s*(.+?)\s*(?:\*\*)?\s*$/) ?? l.match(/^#{1,4}\s+(.+)$/)?.map((x, i) => (i === 1 ? String(sections.length + 1) : x)).concat(['']);
    if (h && h[2] !== undefined && !/^[-•*]\s/.test(l)) {
      const title = (h[2] || h[1]).replace(/\*\*/g, '').trim();
      cur = { n: Number(h[1]) || sections.length + 1, title, body: '', bullets: [], kind: kindOf(title) };
      sections.push(cur); continue;
    }
    if (!cur) { intro.push(l); continue; }
    if (/^[-•*]\s+/.test(l)) cur.bullets.push(l.replace(/^[-•*]\s+/, '').trim());
    if (l) cur.body += `${l}\n`;
  }
  const title = prompt.match(/nomm[ée]e?\s+\*\*(.+?)\*\*/i)?.[1] ?? prompt.match(/nomm[ée]e?\s+[«"“]\s*(.+?)\s*[»"”]/i)?.[1] ?? null;
  const excluded = [...prompt.matchAll(/n['’]utilise\s+pas\s+`?([\w.-]+)`?|sans\s+(?:utiliser\s+)?`([\w.-]+)`/gi)].map((m) => (m[1] ?? m[2]).toLowerCase());
  const directives = [...prompt.matchAll(/(?<!n['’])utilise\s+`([\w.-]+)`\s+pour\s+([^.\n]+)/gi)].map((m) => ({ tool: m[1], text: m[2] }));
  return { title, intro: intro.join(' ').trim(), sections, excluded, directives };
}

function kindOf(title: string): Section['kind'] {
  const t = norm(title);
  if (/indicateurs?|kpi|chiffres? cles?|synthese/.test(t)) return 'kpi';
  if (/acquisition|sources?|outils?|connexion/.test(t)) return 'acquisition';
  if (/design|style|apparence|theme|charte/.test(t)) return 'design';
  return 'data';
}

export const isMultiSection = (prompt: string) => parseSections(prompt).sections.filter((s) => s.kind === 'data' || s.kind === 'kpi').length >= 2;

/** Concepts de puces → noms de champs plausibles (comparés aux champs RÉELLEMENT lus). */
const CONCEPTS: [RegExp, string[]][] = [
  [/telechargements?|downloads?/, ['downloads']],
  [/\blikes?\b|j.aime/, ['likes']],
  [/votes?|upvotes?/, ['upvotes']],
  [/tendances?|trending/, ['trending_score', 'trendingscore']],
  [/architectures?/, ['architecture', 'architectures', 'model_type']],
  [/organisations?|editeurs?/, ['author', 'organization', 'org']],
  [/auteurs?/, ['authors', 'author']],
  [/licences?|licenses?/, ['license', 'licence', 'tag_license']],
  [/dates? de publication|publie|date/, ['published_at', 'created_at', 'created', 'date', 'last_modified']],
  [/categories?|taches?|tasks?/, ['task', 'pipeline_tag', 'category']],
  [/liens?|urls?|articles? originaux/, ['arxiv_url', 'url', 'link', 'uri']],
  [/resumes?|abstracts?|decouvertes?|descriptions?/, ['summary', 'description', 'ai_short_description', 'short_description', 'abstract']],
  [/statuts?|etat/, ['statut', 'status', 'stage', 'disabled']],
  [/infrastructures?|materiel|hardware|sdk/, ['sdk', 'hardware']],
  [/colonnes?/, ['features', 'columns']],
  [/configurations?/, ['configs', 'config_names']],
  [/volumes?|tailles?|lignes/, ['num_rows', 'size', 'dataset_size', 'total_files']],
  [/titres?|noms?/, ['title', 'titre', 'name']],
];
const GENERIC_WORDS = new Set(['interface', 'donnees', 'classement', 'liste', 'tableau', 'filtres', 'filtre', 'categorie', 'categories', 'nombre', 'total', 'avec', 'pour', 'dans', 'les', 'des', 'leurs', 'interactif', 'interactive', 'disponibles', 'disponible', 'decouverte', 'exploration', 'apercu', 'resume', 'liens', 'originaux', 'dernieres', 'derniers', 'recent', 'recentes', 'latest', 'new']);
const FEATURE = /classement|filtres?|tableaux?|graphiques?|courbes?|top\s*\d+|tendance/;

function fieldsOf(ds: Dataset) { return ds.fields.map((f) => ({ ...f, key: norm(f.rel.split('.').pop() ?? f.rel) })); }
function present(ds: Dataset, rel: string) { const rows = ds.collection ? getCollection(ds.acq.raw, ds.collection) ?? [] : []; return rows.some((r) => { const v = getPath(r, rel); return v !== null && v !== undefined && v !== ''; }); }

function conceptFields(bullet: string, ds: Dataset): { matched: { rel: string; key: string }[]; concepts: string[]; missingConcepts: string[] } {
  const b = norm(bullet);
  const F = fieldsOf(ds);
  const matched: { rel: string; key: string }[] = []; const concepts: string[] = []; const missingConcepts: string[] = [];
  for (const [re, keys] of CONCEPTS) {
    const m = re.exec(b); if (!m) continue;
    concepts.push(m[0]);
    // ordre de préférence du concept (ex. liens : url https avant uri interne)
    const f = keys.map((k) => F.find((x) => x.key === k && present(ds, x.rel))).find(Boolean);
    if (!f) { missingConcepts.push(m[0]); continue; }
    if (!matched.some((y) => y.rel === f.rel)) matched.push({ rel: f.rel, key: f.key });
  }
  return { matched, concepts, missingConcepts };
}

export interface SectionPlan { spec: AppSpec; acqs: Acquired[]; datasets: Map<string, Dataset>; demo: boolean; log: string[] }

export async function planSections(prompt: string, catalog: CatalogServer[], acquire: (ref: ToolRef, qid: string, args: Record<string, unknown>) => Promise<Acquired>): Promise<SectionPlan> {
  const P = parseSections(prompt);
  const log: string[] = [];
  // exclusion tolérante aux fautes (« f_whoami » exclut hf_whoami) : un outil exclu n'est JAMAIS appelé
  const allowed = (r: ToolRef) => !P.excluded.some((x) => isExcluded(r.tool.name, x));
  if (P.excluded.length) log.push(`Outils exclus par la demande : ${P.excluded.join(', ')}`);
  const views: ViewSpec[] = []; const reqs: Requirement[] = []; const queries: QuerySpec[] = [];
  const datasets = new Map<string, Dataset>(); const acqs: Acquired[] = [];
  const bySection = new Map<number, { ds: Dataset; tokens: Set<string> }>();
  const seen = new Map<string, string>();
  const acqCache = new Map<string, Acquired>();
  // périmètre : serveurs désignés par les directives (« Utilise `outil` ») ou nommés dans la demande ; sinon tous
  const pn = norm(prompt);
  const directedServers = new Set(catalog.filter((s) => s.tools.some((t) => P.directives.some((d) => d.tool === t.name))).map((s) => s.serverId));
  const namedServers = new Set(catalog.filter((s) => { const words = norm(s.name.replace(/\(.*?\)/g, '')).split(/[^a-z0-9]+/).filter((w) => w.length > 3); return words.length > 0 && words.every((w) => pn.includes(w)); }).map((s) => s.serverId));
  const scope = directedServers.size ? directedServers : namedServers.size ? namedServers : null;
  if (scope) log.push(`Périmètre : ${catalog.filter((s) => scope.has(s.serverId)).map((s) => s.name).join(', ')}`);
  const inScope = (id: string) => !scope || scope.has(id);
  const readRefs = (): ToolRef[] => catalog.flatMap((s) => s.status === 'connected' && inScope(s.serverId) ? s.tools.filter((t) => t.permission === 'read').map((t) => ({ serverId: s.serverId, serverName: s.name, demo: s.demo, tool: t })) : []).filter(allowed);
  const rid = (s: string) => norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 34) || 'req';
  const uniq = (base: string) => { let id = base; let i = 2; while (reqs.some((r) => r.id === id) || views.some((v) => v.id === id)) id = `${base.slice(0, 30)}_${i++}`; return id; };

  for (const sec of P.sections.filter((s) => s.kind === 'data')) {
    const text = `${sec.title}\n${sec.body}`;
    const it = intentTokens(text);
    // candidats : outil nommé dans la section > directives « Utilise X pour … » > proximité
    const named = readRefs().filter((r) => norm(text).includes(norm(r.tool.name)));
    const directed = P.directives.map((d) => ({ d, ref: readRefs().find((r) => r.tool.name === d.tool), s: [...intentTokens(d.text).tokens].filter((w) => it.tokens.has(w) && w.length > 3).length }))
      .filter((x) => x.ref && x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.ref!);
    const ranked = rankTools(catalog, text).filter(allowed).filter((r) => inScope(r.serverId));
    const candidates = [...named, ...directed, ...ranked, ...P.directives.map((d) => readRefs().find((r) => r.tool.name === d.tool)).filter(Boolean) as ToolRef[]]
      .filter((r, i, a) => a.findIndex((x) => x.serverId === r.serverId && x.tool.name === r.tool.name) === i);
    let chosen: { ref: ToolRef; args: Record<string, unknown>; acq?: Acquired; score?: number } | null = null; const tried: string[] = [];
    const viable: { ref: ToolRef; args: Record<string, unknown> }[] = [];
    const scored: { ref: ToolRef; args: Record<string, unknown>; acq: Acquired; score: number }[] = [];
    const blobs = new Map<object, string>();
    for (const ref of candidates.slice(0, 6)) {
      const { args, missing } = await resolveArgs(ref, text, catalog);
      if (missing.length) { tried.push(`${ref.tool.name} (${missing.join(', ')})`); continue; }
      viable.push({ ref, args });
      if (viable.length >= 3) break;
    }
    // Plusieurs sources possibles : on lit, et on garde celle dont les champs RÉELS couvrent le plus de puces.
    for (const v of viable) {
      const key0 = `${v.ref.serverId}__${v.ref.tool.name}__${JSON.stringify(v.args)}`;
      const cached = acqCache.get(key0);
      const a = cached ?? await acquire(v.ref, `cand_${acqCache.size}`, v.args);
      acqCache.set(key0, a);
      const d = datasetOf(a);
      if (a.envelope.status === 'error' || !d.collection || d.docOnly) { tried.push(`${v.ref.tool.name} (${a.envelope.error?.kind ?? 'sans données'})`); continue; }
      const rows = (getCollection(a.raw, d.collection) ?? []).length;
      const blob = (JSON.stringify(v.args) + ' ' + JSON.stringify(a.raw).slice(0, 6000)).toLowerCase();
      const want = Number(norm(text).match(/\btop\s*(\d{1,3})\b/)?.[1] ?? 0);
      const score = (sec.bullets.length ? sec.bullets : [sec.title]).reduce((acc, b) => acc + conceptFields(b, d).matched.length, 0) * 10 + Math.min(rows, want || rows) + (want && rows >= want ? 5 : 0);
      const entry = { ...v, acq: a, score }; scored.push(entry); blobs.set(entry, blob);
      if (viable.length === 1) break;
    }
    // Preuve discriminante (générique) : un mot de la section présent chez certains candidats seulement
    // (dans leurs arguments ou leurs données) départage — ex. « publications » ↔ hf://papers/…
    const discr = [...it.tokens].filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w));
    for (const c of scored) {
      const blob = blobs.get(c) ?? '';
      for (const w of discr) {
        const inMe = blob.includes(w); const inAll = scored.every((o) => (blobs.get(o) ?? '').includes(w));
        if (inMe && !inAll) c.score += 25; else if (!inMe && scored.some((o) => (blobs.get(o) ?? '').includes(w))) c.score -= 25;
      }
      if (!chosen || c.score > (chosen.score ?? -Infinity)) chosen = c;
    }
    const sectionLabel = sec.title.replace(/\*\*/g, '');
    if (!chosen) {
      log.push(`${sectionLabel} : aucun outil exploitable${tried.length ? ` — ${tried.join(' ; ')}` : ''}`);
      for (const b of sec.bullets.length ? sec.bullets : [sectionLabel]) reqs.push({ id: uniq(rid(b)), label: `${sectionLabel} · ${b}`.slice(0, 120), mandatory: true, status: 'unavailable', reason: `Donnée indisponible : aucun outil autorisé ne fournit cette section${tried.length ? ` (${tried[0]})` : ''}`, evidence: null });
      views.push({ kind: 'note', id: uniq(`note_${rid(sectionLabel)}`), title: sectionLabel, text: 'Donnée indisponible : aucun appel MCP autorisé ne fournit cette section.', requirementIds: [], section: sectionLabel });
      continue;
    }
    const key = `${chosen.ref.serverId}__${chosen.ref.tool.name}__${JSON.stringify(chosen.args)}`;
    let qid = seen.get(key);
    if (!qid) {
      qid = uniq(`q_${rid(sectionLabel)}`).slice(0, 40);
      const a0 = chosen.acq ?? await acquire(chosen.ref, qid, chosen.args);
      const a = { ...a0, queryId: qid };
      acqs.push(a); seen.set(key, qid);
      const ds = datasetOf(a); datasets.set(qid, ds);
      queries.push({ id: qid, serverId: chosen.ref.serverId, tool: chosen.ref.tool.name, args: chosen.args, refresh: { mode: 'once' }, envelopeId: a.envelope.id });
      log.push(`${sectionLabel} : ${chosen.ref.tool.name} ${JSON.stringify(chosen.args).slice(0, 140)} → ${a.envelope.status}`);
    }
    const ds = datasets.get(qid)!;
    bySection.set(sec.n, { ds, tokens: it.tokens });
    const failed = ds.acq.envelope.status === 'error' || !ds.collection || ds.docOnly;
    if (failed) {
      const why = ds.acq.envelope.error ? `${ds.acq.envelope.error.kind} : ${ds.acq.envelope.error.message.slice(0, 120)}` : ds.docOnly ? 'texte sans mesures' : 'aucune collection';
      for (const b of sec.bullets.length ? sec.bullets : [sectionLabel]) reqs.push({ id: uniq(rid(b)), label: `${sectionLabel} · ${b}`.slice(0, 120), mandatory: true, status: 'unavailable', reason: `Donnée indisponible (${why})`, evidence: null });
      views.push({ kind: 'note', id: uniq(`note_${rid(sectionLabel)}`), title: sectionLabel, text: `Donnée indisponible : ${why}.`, requirementIds: [], section: sectionLabel });
      continue;
    }
    const coll = ds.collection!;
    const rawSample = JSON.stringify(ds.acq.raw).slice(0, 20000).toLowerCase() + ' ' + JSON.stringify(ds.acq.args).toLowerCase();
    const F = fieldsOf(ds).filter((f) => present(ds, f.rel));
    const idF = F.find((f) => ['id', 'titre', 'title', 'name', 'path', 'uri'].includes(f.key)) ?? F.find((f) => f.role === 'identifier');
    const titleF = F.find((f) => ['title', 'titre', 'name'].includes(f.key) && f.rel !== idF?.rel);
    const tableCols = new Map<string, { path: string; label: string; unit: string | null; type: 'number' | 'string' | 'time' | 'boolean' | 'link' }>();
    const addCol = (f: { rel: string; key: string } | undefined) => {
      if (!f || tableCols.has(f.rel) || tableCols.size >= 9) return;
      const full = ds.fields.find((x) => x.rel === f.rel)!;
      const isLink = /^(url|link|arxiv_url|uri)$/.test(f.key);
      tableCols.set(f.rel, { path: f.rel, label: f.key.replace(/_/g, ' '), unit: full.unit ?? null, type: isLink ? 'link' : full.type === 'time' ? 'time' : full.type === 'number' ? 'number' : full.type === 'boolean' ? 'boolean' : 'string' });
    };
    addCol(idF); addCol(titleF);
    const tableId = uniq(`t_${rid(sectionLabel)}`);
    const rankMeasure = F.find((f) => ['downloads', 'likes', 'upvotes', 'trending_score'].includes(f.key) && f.type === 'number');
    let rankingId: string | null = null;
    const secReqs: string[] = [];
    for (const b of sec.bullets.length ? sec.bullets : [sectionLabel]) {
      const { matched, concepts, missingConcepts } = conceptFields(b, ds);
      matched.forEach((m) => addCol(m));
      const id = uniq(rid(b)); secReqs.push(id);
      const feature = FEATURE.test(norm(b));
      if (matched.length && concepts.length - missingConcepts.length >= Math.ceil(concepts.length / 2)) {
        const lack = missingConcepts.length ? `partiel : ${missingConcepts.join(', ')} — Donnée indisponible` : '';
        reqs.push({ id, label: `${sectionLabel} · ${b}`.slice(0, 120), mandatory: true, status: 'covered', ...(lack ? { reason: lack } : {}), evidence: { envelopeId: ds.acq.envelope.id, path: `${coll}[].${matched[0].rel}`, viewId: tableId } });
      } else if (!concepts.length && (feature || [...intentTokens(b).tokens].some((w) => w.length >= 4 && !GENERIC_WORDS.has(w) && rawSample.includes(w)))) {
        // puce qui désigne les éléments listés eux-mêmes (un de ses mots figure dans les données lues)
        reqs.push({ id, label: `${sectionLabel} · ${b}`.slice(0, 120), mandatory: true, status: 'covered', evidence: { envelopeId: ds.acq.envelope.id, path: `${coll}[]`, viewId: /classement|top/.test(norm(b)) && rankMeasure ? (rankingId ??= uniq(`r_${rid(sectionLabel)}`)) : tableId } });
      } else {
        reqs.push({ id, label: `${sectionLabel} · ${b}`.slice(0, 120), mandatory: true, status: 'unavailable', reason: `Donnée indisponible : ${concepts.length ? `champ « ${concepts.join(', ')} » absent` : 'non fourni'} dans les données lues (${ds.acq.ref.tool.name})`, evidence: null });
      }
    }
    // colonnes de mesure utiles même sans puce explicite
    for (const f of F.filter((x) => x.type === 'number').slice(0, 3)) addCol(f);
    // champ de facettes : le champ catégoriel nommé dans la demande, sinon le plus « catégoriel » (2 à 30 valeurs)
    const catF = F.filter((f) => f.type === 'string' && !/^(id|uri|path|url|link|titre|title|name|description|summary)$/.test(f.key)).map((f) => ({ f, d: new Set((getCollection(ds.acq.raw, coll) ?? []).map((r) => getPath(r, f.rel))).size })).filter((x) => x.d >= 2 && x.d <= 30);
    const namedCat = catF.find((x) => norm(sec.body).includes(norm(x.f.key).replace(/_/g, ' ')) || /categor/.test(norm(sec.body)) && /task|categor|type|kind|genre/.test(x.f.key));
    const facetF = (namedCat ?? catF.sort((a, b) => a.d - b.d).find((x) => x.d <= 12))?.f;
    const wantsFacets = /filtre|categorie/.test(norm(sec.body));
    if (rankMeasure && (rankingId || /classement|top|tendance|populaire/.test(norm(text)))) {
      const labelF = idF ?? titleF;
      if (labelF) views.push({ kind: 'ranking', id: rankingId ?? uniq(`r_${rid(sectionLabel)}`), title: `${sectionLabel} · classement par ${rankMeasure.key.replace(/_/g, ' ')}`, queryId: qid, requirementIds: secReqs.filter((r) => reqs.find((x) => x.id === r)?.evidence?.viewId === rankingId), section: sectionLabel, bindings: { collection: coll, label: labelF.rel, metric: rankMeasure.rel, groupBy: false, agg: 'sum', unit: null, population: `${(getCollection(ds.acq.raw, coll) ?? []).length} éléments lus (${ds.acq.ref.tool.name})`, order: 'desc', limit: 20 } });
    }
    views.push({ kind: 'table', id: tableId, title: sectionLabel, queryId: qid, requirementIds: secReqs.filter((r) => reqs.find((x) => x.id === r)?.evidence?.viewId === tableId), section: sectionLabel,
      bindings: { collection: coll, columns: [...tableCols.values()], ...(facetF ? { facets: { path: facetF.rel, ...(wantsFacets ? facetGroups(sec.body, facetF.key, ds, catalog) : {}) } } : {}) } });
    // graphiques de forme sur cette section
    const before = views.length;
    recommend(views, datasets, [qid], `${sec.title}\n${sec.body}`, 4);
    for (const v of views.slice(before)) (v as { section?: string }).section = sectionLabel;
  }

  // Indicateurs : calculés sur les sections de données, dans l'ordre des puces
  const kpiViews: ViewSpec[] = [];
  for (const sec of P.sections.filter((s) => s.kind === 'kpi')) {
    const sectionLabel = sec.title.replace(/\*\*/g, '');
    for (const b of sec.bullets) {
      const nb = norm(b); const it = intentTokens(b);
      // section visée : celle qui partage le plus de mots significatifs avec la puce (générique)
      const words = [...it.tokens].filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w) && !/^(nombre|cumul|cumules|telechargements?|selection|selectionnes|recuperes?|recuperees|plus|populaire)$/.test(w));
      const target = [...bySection.values()].filter((x) => x.ds.collection && x.ds.acq.envelope.status !== 'error')
        .map((x) => ({ x, s: words.filter((w) => x.tokens.has(w)).length })).filter((y) => y.s > 0).sort((a, b) => b.s - a.s)[0]?.x;
      const id = uniq(rid(b));
      if (!target) { reqs.push({ id, label: `${sectionLabel} · ${b}`.slice(0, 120), mandatory: true, status: 'unavailable', reason: 'Donnée indisponible : aucune section lue ne porte cet ensemble', evidence: null }); views.push({ kind: 'note', id: uniq(`k_${rid(b)}`), title: b.slice(0, 80), text: 'Donnée indisponible', requirementIds: [id], section: sectionLabel }); continue; }
      const ds = target.ds; const coll = ds.collection!;
      const qid = [...datasets.entries()].find(([, d]) => d === ds)![0];
      const F = fieldsOf(ds).filter((f) => present(ds, f.rel));
      const measure = (/(telechargement|download)/.test(nb) ? F.find((f) => f.key === 'downloads') : /(like)/.test(nb) ? F.find((f) => f.key === 'likes') : /(vote)/.test(nb) ? F.find((f) => f.key === 'upvotes') : undefined)
        ?? (/(populaire|meilleur|plus)/.test(nb) ? F.find((f) => ['downloads', 'likes', 'upvotes', 'trending_score'].includes(f.key)) : undefined);
      const labelF = F.find((f) => ['id', 'title', 'titre', 'name', 'path', 'uri'].includes(f.key));
      const vid = uniq(`k_${rid(b)}`);
      let view: ViewSpec | null = null;
      if (/(populaire|meilleur|le plus|top 1)/.test(nb) && measure && labelF) view = { kind: 'kpi', id: vid, title: b.slice(0, 80), queryId: qid, requirementIds: [id], section: sectionLabel, bindings: { unit: null, aggregate: { collection: coll, agg: 'top', measure: measure.rel, labelPath: labelF.rel, where: [], percent: false } } };
      else if (/(cumul|total|somme|ensemble des)/.test(nb) && measure && !NON_ADDITIVE.test(norm(measure.rel))) view = { kind: 'kpi', id: vid, title: b.slice(0, 80), queryId: qid, requirementIds: [id], section: sectionLabel, bindings: { unit: null, aggregate: { collection: coll, agg: 'sum', measure: measure.rel, where: [], percent: false } } };
      else if (/(nombre|combien|compte|count)/.test(nb)) {
        const where = [];
        let missingFilter: string | null = null;
        for (const w of filtersOf(b)) {
          const f = F.find((x) => w.field.some((k) => x.key.includes(norm(k)) || norm(k).includes(x.key)));
          if (!f) { missingFilter = w.field[0]; break; }
          where.push({ path: f.rel, op: w.op, ...(w.value !== undefined ? { value: w.value } : {}) });
        }
        if (missingFilter) reqs.push({ id, label: `${sectionLabel} · ${b}`.slice(0, 120), mandatory: true, status: 'unavailable', reason: `champ de filtre « ${missingFilter} » absent des données lues`, evidence: null });
        else view = { kind: 'kpi', id: vid, title: b.slice(0, 80), queryId: qid, requirementIds: [id], section: sectionLabel, bindings: { unit: null, aggregate: { collection: coll, agg: 'count', where, percent: false } } };
      } else {
        const clause = clauseToReq(b, reqs.length);
        if (clause) {
          const resolved = resolveRequirement({ ...clause, id, tool: [norm(ds.acq.ref.tool.name)] }, ds, vid, qid);
          if (resolved.ok && resolved.view.kind !== 'table' && resolved.view.kind !== 'note') view = { ...resolved.view, section: sectionLabel };
          else if (!resolved.ok) reqs.push({ id, label: `${sectionLabel} · ${b}`.slice(0, 120), mandatory: true, status: 'unavailable', reason: resolved.reason, evidence: null });
        }
      }
      if (view) { kpiViews.push(view); reqs.push({ id, label: `${sectionLabel} · ${b}`.slice(0, 120), mandatory: true, status: 'covered', evidence: { envelopeId: ds.acq.envelope.id, path: `${coll}[]${measure ? `.${measure.rel}` : ''}`, viewId: vid } }); }
      else if (!reqs.some((r) => r.id === id)) reqs.push({ id, label: `${sectionLabel} · ${b}`.slice(0, 120), mandatory: true, status: 'unavailable', reason: 'Donnée indisponible : mesure absente des données lues', evidence: null });
    }
  }

  const design = norm(P.sections.filter((s) => s.kind === 'design').map((s) => s.body + s.title).join(' ') + ' ' + P.intro);
  const accent = (['orange', 'rouge', 'bleu', 'vert', 'violet', 'cyan'] as const).find((c) => design.includes(c)) ?? 'mono';
  const spec: AppSpec = {
    specVersion: 1, title: (P.title ?? P.sections[0]?.title ?? 'Interface').slice(0, 80),
    mission: (P.intro || prompt).replace(/\*\*/g, '').replace(/\s+/g, ' ').slice(0, 400), demo: acqs.some((a) => a.ref.demo),
    requirements: capReqs(reqs), queries, views: capViews([...kpiViews, ...views]), actions: [], commands: [],
    style: { density: 'confortable', accent, font: /monospace|\bmono\b/.test(design) ? 'mono' : 'system', nav: /laterale?|sidebar|barre de navigation/.test(design) ? 'sidebar' : 'top', theme: /graphite/.test(design) ? 'graphite' : 'noir' },
  };
  return { spec, acqs, datasets, demo: spec.demo, log };
}

function capReqs(reqs: Requirement[]): Requirement[] {
  if (reqs.length <= 40) return reqs;
  const extra = reqs.length - 39;
  return [...reqs.slice(0, 39), { id: 'capacite_depassee', label: 'Exigences au-delà de la capacité', mandatory: true, status: 'unavailable', reason: `${extra} exigences non affichées : capacité 40`, evidence: null }];
}

function capViews(views: ViewSpec[]): ViewSpec[] {
  if (views.length <= 28) return views;
  const extra = views.length - 27;
  return [...views.slice(0, 27), { kind: 'note', id: 'vues_depassees', title: 'Capacité', text: `${extra} vues non affichées : capacité 28.`, requirementIds: [] }];
}

export function isExcluded(tool: string, x: string): boolean {
  const a = tool.toLowerCase(), b = x.toLowerCase();
  if (a === b || a.endsWith(b) || b.endsWith(a)) return true;
  if (Math.abs(a.length - b.length) > 2) return false;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length] <= 2;
}

/**
 * Groupes de filtres demandés (« Filtres par catégorie : A, B, C ») : taxonomie d'un pack actif si elle existe,
 * sinon rapprochement des noms demandés avec les valeurs RÉELLES du champ ; un groupe sans valeur n'est pas créé.
 */
export function facetGroups(body: string, fieldKey: string, ds: Dataset, catalog: CatalogServer[]): { groups?: Record<string, string[]> } {
  const tax = taxonomyFor(fieldKey, catalog);
  if (tax) return { groups: tax };
  const m = body.match(/(?:filtres?|cat[ée]gories?)[^:\n]*:\s*([^\n.]+)/i);
  if (!m) return {};
  const wanted = m[1].split(/,|\bet\b|\//).map((x) => x.trim()).filter((x) => x.length > 1).slice(0, 10);
  const values = [...new Set((getCollection(ds.acq.raw, ds.collection!) ?? []).map((r) => String(getPath(r, ds.fields.find((f) => f.rel.endsWith(fieldKey))?.rel ?? fieldKey) ?? '')))].filter(Boolean);
  const groups: Record<string, string[]> = {};
  for (const w of wanted) { const k = norm(w); const hits = values.filter((v) => norm(v).includes(k) || k.includes(norm(v))); if (hits.length) groups[w] = hits; }
  return Object.keys(groups).length >= 2 ? { groups } : {};
}
