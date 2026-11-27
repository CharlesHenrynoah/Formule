import type { AppSpec, ViewSpec } from '@formule/contracts';
import { norm } from '../semantic/lexicon.js';

export type DeltaOp =
  | { op: 'title'; value: string }
  | { op: 'density'; value: 'compact' | 'confortable' }
  | { op: 'accent'; value: 'bleu' | 'vert' | 'sable' | 'violet' }
  | { op: 'removeView'; target: string }
  | { op: 'removeColumn'; target: string }
  | { op: 'simulate'; pct: number }
  | { op: 'add'; kind: 'line' | 'table' | 'ranking' | 'kpi' | 'simulation'; text: string };

/** Delta explicite : ce qui n'est pas demandé reste inchangé. */
export function parseDelta(text: string): DeltaOp[] {
  const t = norm(text);
  const ops: DeltaOp[] = [];
  const title = text.match(/renomme(?:r)?\s+(?:l['’]interface\s+|le titre\s+|l['’]app\s+)?(?:en|:)\s*[«"]?\s*([^»"]+?)\s*[»"]?\s*$/i);
  if (title) ops.push({ op: 'title', value: title[1].trim().slice(0, 80) });
  if (/\b(compacte?|dense|plus serre)\b/.test(t)) ops.push({ op: 'density', value: 'compact' });
  if (/\b(aere|confortable|espace)\b/.test(t)) ops.push({ op: 'density', value: 'confortable' });
  const accent = t.match(/\b(bleu|vert|sable|violet)\b/);
  if (accent && /(couleur|accent|theme|teinte)/.test(t)) ops.push({ op: 'accent', value: accent[1] as 'bleu' });
  const sim = t.match(/simule[rz]?\s*([+-]?\s*\d+(?:[.,]\d+)?)\s*%/);
  if (sim) ops.push({ op: 'simulate', pct: Number(sim[1].replace(/\s/g, '').replace(',', '.')) });
  const col = t.match(/(?:retire|supprime|enleve)\s+(?:cette |la )?colonne\s*(.*)$/);
  if (col) ops.push({ op: 'removeColumn', target: col[1].trim() });
  else {
    const rm = t.match(/(?:retire|supprime|enleve)\s+(?:la vue|le graphique|la courbe|le tableau|le classement|l'indicateur|le kpi|la simulation)?\s*(.*)$/);
    if (rm) ops.push({ op: 'removeView', target: (rm[1] || t).trim() });
  }
  const add = t.match(/ajoute(?:r|z)?\s+(?:un |une |le |la |des )?(graphique|courbe|tableau|classement|indicateur|kpi|simulation|scenario)\b(.*)$/);
  if (add) {
    const k = add[1];
    ops.push({ op: 'add', kind: k === 'graphique' || k === 'courbe' ? 'line' : k === 'tableau' ? 'table' : k === 'classement' ? 'ranking' : k === 'simulation' || k === 'scenario' ? 'simulation' : 'kpi', text: add[2].trim() });
  }
  return ops;
}

export function matchView(views: ViewSpec[], target: string): ViewSpec | undefined {
  const words = norm(target).split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  let best: { v: ViewSpec; s: number } | undefined;
  for (const v of views) {
    const hay = norm(`${v.title} ${v.kind === 'table' ? 'tableau' : v.kind === 'line' ? 'graphique courbe' : v.kind === 'ranking' ? 'classement' : v.kind === 'kpi' ? 'indicateur kpi' : v.kind}`);
    const s = words.reduce((a, w) => a + (hay.includes(w) ? 1 : 0), 0);
    if (s > 0 && (!best || s > best.s)) best = { v, s };
  }
  return best?.v;
}

/** Comparaison de non-régression : vues non touchées strictement identiques. */
export function untouchedEqual(before: AppSpec, after: AppSpec, touched: Set<string>): string[] {
  const issues: string[] = [];
  for (const v of before.views) {
    if (touched.has(v.id)) continue;
    const a = after.views.find((x) => x.id === v.id);
    if (!a) issues.push(`vue « ${v.title} » supprimée sans demande`);
    else if (JSON.stringify(a) !== JSON.stringify(v)) issues.push(`vue « ${v.title} » modifiée sans demande`);
  }
  for (const q of before.queries) {
    const a = after.queries.find((x) => x.id === q.id);
    if (a && JSON.stringify({ ...a, envelopeId: undefined }) !== JSON.stringify({ ...q, envelopeId: undefined })) issues.push(`requête ${q.id} modifiée sans demande`);
  }
  return issues;
}
