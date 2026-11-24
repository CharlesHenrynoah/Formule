/**
 * Une méthode SDK est retenue pour le périmètre qu'elle couvre.
 * Un champ commun ne rend pas deux périmètres interchangeables.
 */
import ts from 'typescript';
import { claimsFromPrompt, hitsInRows, linkChain, termCovers, type ChainProof } from './chain.ts';

export type Scope = 'global' | 'individuel' | 'agrege' | 'historique';
export type Grain = 'point' | 'serie' | 'liste';

export type MethodDoc = {
  method?: string;
  endpoint?: string;
  summary?: string;
  description?: string;
  params?: string;
  response?: string;
  returns?: string;
  signature?: string;
  example?: string;
};

export type SdkMethod = {
  method: string;
  doc: MethodDoc;
  scope: Scope;
  grain: Grain;
  fields: string[];
  acceptsEntity: boolean;
  acceptsUnit: boolean;
  acceptsPeriod: boolean;
};

export type Requirements = {
  entities: string[];
  measures: string[];
  units: string[];
  periods: string[];
  filters: string[];
  grain: Grain;
  scope: Scope;
  ui: string[];
};

const UI_KIND = new Set(['meta', 'vue', 'action', 'operation', 'periode']);

function fold(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

function bagOf(doc: MethodDoc): string {
  return fold(`${doc.method ?? ''} ${doc.endpoint ?? ''} ${doc.summary ?? ''} ${doc.description ?? ''}`);
}

function fieldNames(schema: string): string[] {
  return [...schema.matchAll(/\b([A-Za-z_][\w]*)\b/g)]
    .map((match) => match[1]!)
    .filter((name) => !/^(string|number|boolean|object|array|null|integer|true|false|undefined)$/i.test(name));
}

/** Exigences d'acquisition, séparées de l'interface. Un titre, une carte ou un filtre temporel ne se télécharge pas. */
export function requirementsOf(prompt: string): Requirements {
  const claims = claimsFromPrompt(prompt);
  const entities = claims.filter((claim) => claim.kind === 'entite').map((claim) => claim.text);
  const measures = claims.filter((claim) => claim.kind === 'mesure').map((claim) => claim.text);
  const units = claims.filter((claim) => claim.kind === 'unite').map((claim) => claim.text);
  const periods = claims.filter((claim) => claim.kind === 'periode').map((claim) => claim.text);
  const filters = claims.filter((claim) => claim.kind === 'filtre').map((claim) => claim.text);
  const ui = claims.filter((claim) => claim.kind === 'vue' || claim.kind === 'meta' || claim.kind === 'action' || claim.kind === 'operation').map((claim) => claim.text);
  const grain: Grain = /courbe|graphique|historique|sparkline|par jour|par semaine|série|serie/i.test(prompt)
    ? 'serie'
    : /top\s*\d+|classement|tableau|liste|grille/i.test(prompt)
      ? 'liste'
      : 'point';
  let scope: Scope = 'agrege';
  if (grain === 'serie') scope = 'historique';
  else if (grain === 'liste') scope = 'agrege';
  else if (entities.length) scope = 'individuel';
  else if (/\bglobal\b|ensemble du|tous les totaux/i.test(prompt)) scope = 'global';
  return { entities, measures, units, periods, filters, grain, scope, ui };
}

export function registerMethods(docs: MethodDoc[]): SdkMethod[] {
  const seen = new Set<string>();
  const out: SdkMethod[] = [];
  for (const doc of docs) {
    const method = (doc.method ?? '').trim();
    if (!method || seen.has(method)) continue;
    seen.add(method);
    const bag = bagOf(doc);
    const params = doc.params ?? '';
    const response = `${doc.response ?? ''} ${doc.returns ?? ''}`;
    const fields = fieldNames(response);
    const history = /chart|histor|timeseries|ohlc|sparkline|\bhistory\b/.test(bag)
      || (/timestamp|\[time/.test(fold(response)) && /price|value|close/.test(fold(response)));
    const global = /\bglobal\b|\boverview\b|\bstats\b|\btotals?\b/.test(bag);
    const hasId = /\{(id|slug|symbol|name)\}/.test(bag) || /\b(id|slug|symbol)\s*\??\s*:/.test(params);
    const list = /\b(list|markets|search|find)\b/.test(bag) || /\[/.test(response);
    let scope: Scope = 'agrege';
    if (history) scope = 'historique';
    else if (global && !hasId) scope = 'global';
    else if (list) scope = 'agrege';
    else if (hasId) scope = 'individuel';
    else if (fields.some((field) => /^(active_|total_)/.test(field) || /count$/i.test(field)) && !fields.some((field) => /^(name|title|nom|symbol|id)$/i.test(field))) scope = 'global';
    const grain: Grain = scope === 'historique' ? 'serie' : scope === 'agrege' ? 'liste' : 'point';
    out.push({
      method,
      doc,
      scope,
      grain,
      fields,
      acceptsEntity: hasId || /\b(id|slug|symbol|name|query|q)\b/.test(fold(params)),
      acceptsUnit: /\b(currency|devise|unit|vs_)\b/.test(fold(params)),
      acceptsPeriod: /\b(days|interval|from|to|since|until|start|end)\b/.test(fold(params)),
    });
  }
  return out;
}

function coversMeasure(method: SdkMethod, measure: string): boolean {
  if (method.fields.length) return method.fields.some((field) => termCovers(measure, field));
  return termCovers(measure, method.doc.summary ?? '') || termCovers(measure, method.method);
}

export function methodFits(method: SdkMethod, req: Requirements): { ok: boolean; score: number; reason: string } {
  if (method.scope === 'global' && req.scope !== 'global') return { ok: false, score: 0, reason: 'périmètre global' };
  if (req.grain !== 'serie' && method.scope === 'historique') return { ok: false, score: 0, reason: 'périmètre historique' };
  if (req.grain === 'liste' && method.scope === 'individuel') return { ok: false, score: 0, reason: 'une fiche ne remplit pas une liste' };
  if (req.measures.length && method.fields.length && !req.measures.some((measure) => coversMeasure(method, measure))) {
    return { ok: false, score: 0, reason: 'schéma sans la mesure' };
  }
  let score = method.scope === req.scope ? 5 : 1;
  if (req.measures.length && !method.fields.length && !req.measures.some((measure) => coversMeasure(method, measure))) score = 1;
  if (req.measures.every((measure) => coversMeasure(method, measure))) score += 3;
  if (req.entities.length && method.acceptsEntity) score += 2;
  if (req.units.length && method.acceptsUnit) score += 1;
  if (req.periods.length && method.acceptsPeriod) score += 1;
  if (method.grain === req.grain) score += 1;
  return { ok: true, score, reason: method.scope };
}

/** La méthode dont le schéma couvre l'entité, la mesure et la granularité. */
export function selectMethod(methods: SdkMethod[], req: Requirements, banned: string[] = []): { method: SdkMethod; reason: string; rejected: Array<{ method: string; reason: string }> } | null {
  const rejected: Array<{ method: string; reason: string }> = [];
  const ranked: Array<{ method: SdkMethod; score: number; reason: string }> = [];
  for (const method of methods) {
    if (banned.includes(method.method)) {
      rejected.push({ method: method.method, reason: 'exclue après une réponse hors périmètre' });
      continue;
    }
    const fit = methodFits(method, req);
    if (!fit.ok) rejected.push({ method: method.method, reason: fit.reason });
    else ranked.push({ method, score: fit.score, reason: fit.reason });
  }
  ranked.sort((a, b) => b.score - a.score || a.method.method.localeCompare(b.method.method));
  const best = ranked[0];
  if (!best) return null;
  return { method: best.method, reason: best.reason, rejected };
}

export function globalShape(fields: string[]): boolean {
  if (!fields.length) return false;
  const totals = fields.some((field) => /^(active_|total_)/.test(field) || /(^|_)count$/i.test(field));
  const named = fields.some((field) => /^(name|title|nom|symbol|id)$/i.test(field));
  return totals && !named;
}

/** Après l'appel : une réponse techniquement valide peut rester hors sujet. */
export function responseInScope(rows: Array<Record<string, unknown>>, req: Requirements): { ok: boolean; reason: string; obtained: string[]; scopeMismatch: boolean } {
  if (!rows.length) return { ok: false, reason: 'réponse vide', obtained: [], scopeMismatch: false };
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((field) => field !== 'collection');
  const obtained = fields.slice(0, 12);
  const measuresMissing = req.measures.filter((measure) => !fields.some((field) => termCovers(measure, field)));
  const entityMissing = req.entities.filter((entity) => !hitsInRows(rows, [entity]).length);
  if (req.scope !== 'global' && globalShape(fields)) {
    return { ok: false, reason: 'périmètre global', obtained, scopeMismatch: true };
  }
  const dated = fields.some((field) => /date|time|timestamp|jour/i.test(field));
  if (req.grain === 'serie' && !dated) {
    return { ok: false, reason: 'granularité : série attendue', obtained, scopeMismatch: true };
  }
  if (measuresMissing.length) return { ok: false, reason: `mesure absente : ${measuresMissing.join(', ')}`, obtained, scopeMismatch: false };
  if (req.scope === 'individuel' && entityMissing.length) return { ok: false, reason: `entité absente : ${entityMissing.join(', ')}`, obtained, scopeMismatch: false };
  return { ok: true, reason: 'périmètre tenu', obtained, scopeMismatch: false };
}

export function acquisitionProgress(prompt: string, fields: string[], proof?: ChainProof): { held: string[]; open: string[] } {
  const chain = linkChain(prompt, fields, proof);
  const held: string[] = [];
  const open: string[] = [];
  for (const link of chain.links) {
    const claim = chain.claims.find((item) => item.id === link.claim);
    if (!claim || UI_KIND.has(claim.kind)) continue;
    (link.state === 'tenu' ? held : open).push(link.text);
  }
  return { held, open };
}

function chainOf(node: ts.Expression): string[] | null {
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isPropertyAccessExpression(node)) {
    const head = chainOf(node.expression);
    return head ? [...head, node.name.text] : null;
  }
  return null;
}

function normalizeArgs(raw: string): string {
  const pairs = [...raw.matchAll(/([A-Za-z_][\w]*)\s*:\s*('[^']*'|"[^"]*"|`[^`]*`|\d+|true|false)/g)];
  if (!pairs.length) return raw.replace(/\s+/g, ' ').slice(0, 180);
  return pairs.map((pair) => `${pair[1]}=${pair[2]}`).sort().join('&');
}

/** L'identité d'une tentative est la méthode et ses arguments, pas le texte du script. */
export function callIdentity(code: string): Array<{ method: string; args: string }> {
  const source = ts.createSourceFile('run.js', code, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const found: Array<{ method: string; args: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const path = chainOf(node.expression);
      if (path && path[0] === 'client' && path.length > 1) {
        const raw = node.arguments.map((arg) => arg.getText(source)).join(', ');
        found.push({ method: path.join('.'), args: normalizeArgs(raw) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function attemptKey(method: string, args: string, claims: string[]): string {
  return `${method}|${args}|${[...claims].sort().join(',')}`;
}

export function methodJournal(input: { method: string; args: string; scope: string; expected: string; obtained: string; decision: string }): string {
  return [
    `méthode : ${input.method || 'inconnue'}`,
    `arguments : ${input.args || 'aucun'}`,
    `périmètre : ${input.scope}`,
    `attendu : ${input.expected}`,
    `obtenu : ${input.obtained || 'rien'}`,
    `décision : ${input.decision}`,
  ].join('\n');
}
