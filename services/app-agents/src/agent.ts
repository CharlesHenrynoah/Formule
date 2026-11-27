import {
  aggregate, getCollection, getPath, rank, toSeries, simulateLinear, classifyIntent,
  type AppSpec, type AppDataBundle, type ViewSpec,
} from '@formule/contracts';

/** Agent local d'une app publiée : répond sur ses données, pilote ses vues. Ne modifie rien. */
export interface Version { n: number; spec: AppSpec; bundle: AppDataBundle; status: string; certification: { certified: boolean; message: string; label: string } | null }
export type ViewCommand = { op: 'show' | 'hide' | 'focus' | 'reset'; viewId?: string };

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: process.env.FORMULE_TZ ?? 'Europe/Paris' }) : 'heure inconnue');
const STOP = new Set(['quel', 'quelle', 'quels', 'est', 'les', 'des', 'une', 'pour', 'dans', 'sur', 'avec', 'mon', 'mes', 'notre', 'combien', 'affiche', 'montre', 'seulement', 'la', 'le', 'du', 'de', 'vue', 'interface']);
const words = (s: string) => norm(s).split(/[^a-z0-9%]+/).filter((w) => w.length > 2 && !STOP.has(w));

function viewHay(v: ViewSpec, spec: AppSpec) {
  const req = spec.requirements.filter((r) => v.requirementIds.includes(r.id)).map((r) => r.label).join(' ');
  const kind = { kpi: 'indicateur valeur total', line: 'courbe graphique evolution', table: 'tableau liste detail', ranking: 'classement top meilleur plus', simulation: 'simulation scenario', note: 'note' }[v.kind];
  return norm(`${v.title} ${req} ${kind}`);
}

export function matchViews(spec: AppSpec, text: string): ViewSpec[] {
  const ws = words(text);
  return spec.views.map((v) => ({ v, s: ws.reduce((a, w) => a + (viewHay(v, spec).includes(w) ? 1 : viewHay(v, spec).includes(w.slice(0, 5)) ? 0.5 : 0), 0) }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.v);
}

function provenance(ver: Version, queryId: string) {
  const q = ver.bundle.queries[queryId];
  if (!q) return 'source inconnue';
  return `observé à ${hhmm(q.envelope.observedAt ?? q.envelope.fetchedAt)}, source ${q.envelope.source.serverName}${q.envelope.source.demo ? ' (démo)' : ''}`;
}

/** Réponse type : le fait d'abord (valeur, unité), puis heure et provenance. */
export function describeView(ver: Version, v: ViewSpec): string {
  if (v.kind === 'note') return v.text;
  const q = ver.bundle.queries[v.queryId];
  if (!q || q.raw == null) return `${v.title} : donnée indisponible (${q?.envelope.status ?? 'aucune lecture'}).`;
  const ref = Date.parse(q.envelope.observedAt ?? q.envelope.fetchedAt);
  const prov = provenance(ver, v.queryId);
  const partial = q.envelope.coverage.complete ? '' : ` Couverture partielle : ${q.envelope.coverage.note}.`;
  if (v.kind === 'kpi') {
    if (v.bindings.value) {
      const x = getPath(q.raw, v.bindings.value);
      const unit = v.bindings.unitPath ? String(getPath(q.raw, v.bindings.unitPath) ?? '') : v.bindings.unit ?? '';
      return typeof x === 'number' ? `${nf.format(x)}${unit ? ` ${unit}` : ''}, ${prov}. (${v.title})${partial}` : `${v.title} : valeur ${x === null || x === undefined ? 'manquante' : 'invalide'}, ${prov}.`;
    }
    const r = aggregate(q.raw, v.bindings.aggregate!, v.bindings.unit, ref);
    if (r.state === 'empty') return `${v.title} : vide (aucune ligne sur le périmètre), ${prov}.`;
    if (r.value === null) return `${v.title} : ${r.reason ?? r.state}, ${prov}.`;
    return `${nf.format(r.value)}${r.unit ? ` ${r.unit}` : ''}, ${prov}. ${v.title} sur ${r.count} ligne(s)${r.skipped ? `, ${r.skipped} sans mesure exclue(s)` : ''}.${partial}`;
  }
  if (v.kind === 'ranking') {
    const r = rank(q.raw, v.bindings);
    if (!r.rows.length) return `${v.title} : vide, ${prov}.`;
    const top = r.rows.slice(0, 3).map((x, i) => `${i + 1}. ${x.label} ${nf.format(x.value)}${v.bindings.unit ? ` ${v.bindings.unit}` : ''}`).join(' ; ');
    return `${top}. ${v.title}, ${prov}${q.envelope.coverage.complete ? '' : ' (top des résultats reçus)'}.`;
  }
  if (v.kind === 'line') {
    const rows = getCollection(q.raw, v.bindings.collection) ?? [];
    const parts = v.bindings.series.map((s) => {
      const pts = toSeries(rows, v.bindings.t, s.path, getPath).points;
      const last = [...pts].reverse().find((p) => p.v !== null);
      return last ? `${s.label} : ${nf.format(last.v!)}${s.unit ? ` ${s.unit}` : ''} au ${new Date(last.t).toLocaleDateString('fr-FR')}` : `${s.label} : aucune mesure`;
    });
    return `${parts.join(' ; ')} (dernier point mesuré), ${prov}. ${rows.length} points.`;
  }
  if (v.kind === 'table') return `${(getCollection(q.raw, v.bindings.collection) ?? []).length} lignes dans « ${v.title} », ${prov}.`;
  if (v.kind === 'simulation') {
    const pts = toSeries(getCollection(q.raw, v.bindings.collection) ?? [], v.bindings.t, v.bindings.v, getPath).points;
    const d = Object.fromEntries(v.model.params.map((p) => [p.id, p.default]));
    const s = simulateLinear(pts, { variation_pct: d.variation_pct ?? 0, horizon: d.horizon ?? 7 });
    const end = s.scenario[s.scenario.length - 1];
    return `Scénario (pas une observation) : ${end ? nf.format(end.v!) : '—'}${v.bindings.unit ? ` ${v.bindings.unit}` : ''} en fin d’horizon. Hypothèses : ${s.assumptions.join(' ; ')}.`;
  }
  return v.title;
}

export function answer(ver: Version, message: string, mode: 'ask' | 'agent'): { text: string; commands?: ViewCommand[] } {
  const spec = ver.spec;
  const t = norm(message);
  const intent = classifyIntent(message, { projectOpen: true, mode });
  const matched = matchViews(spec, message);
  if (intent === 'Control' || /^(affiche|montre|masque|cache|reaffiche|tout afficher)/.test(t)) {
    if (/(tout afficher|reaffiche tout|tout montrer|reinitialise)/.test(t)) return { text: 'Toutes les vues sont réaffichées.', commands: [{ op: 'reset' }] };
    const v = matched[0];
    if (!v) return { text: `Aucune vue ne correspond. Vues : ${spec.views.map((x) => x.title).join(', ')}.` };
    if (/(masque|cache)/.test(t)) return { text: `« ${v.title} » masquée (affichage seulement ; la version n’est pas modifiée).`, commands: [{ op: 'hide', viewId: v.id }] };
    if (/seulement|uniquement|focus/.test(t)) return { text: `Affichage limité à « ${v.title} ».`, commands: [{ op: 'focus', viewId: v.id }] };
    return { text: `« ${v.title} » affichée.`, commands: [{ op: 'show', viewId: v.id }] };
  }
  if (!matched.length) {
    const missing = spec.requirements.filter((r) => r.status !== 'covered');
    const reqHit = missing.find((r) => words(message).some((w) => norm(r.label).includes(w.slice(0, 5))));
    if (reqHit) return { text: `« ${reqHit.label} » n’est pas disponible dans cette interface : ${reqHit.reason ?? 'mesure manquante'}.` };
    return { text: `Je ne trouve pas cette mesure dans l’interface. Disponible : ${spec.views.filter((v) => v.kind !== 'note').map((v) => v.title).join(', ')}.${missing.length ? ` Manquant : ${missing.map((r) => r.label).join(', ')}.` : ''}` };
  }
  const head = /(plus|moins|meilleur|pire|top|classement|rentable)/.test(t) ? matched.find((v) => v.kind === 'ranking') ?? matched[0] : matched.find((v) => v.kind === 'kpi') ?? matched[0];
  let text = describeView(ver, head);
  if (/(moins|pire)/.test(t) && head.kind === 'ranking') {
    const q = ver.bundle.queries[head.queryId];
    const r = rank(q.raw, { ...head.bindings, order: 'asc' });
    if (r.rows[0]) text = `${r.rows[0].label} : ${nf.format(r.rows[0].value)}${head.bindings.unit ? ` ${head.bindings.unit}` : ''} (le plus bas). ${head.title}, ${provenance(ver, head.queryId)}.`;
  }
  if (ver.certification && !ver.certification.certified) text += ` Attention : version ${ver.certification.label}.`;
  return { text };
}
