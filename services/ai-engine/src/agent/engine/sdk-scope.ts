/**
 * Une méthode SDK est retenue pour le périmètre qu'elle couvre.
 * Un champ commun ne rend pas deux périmètres interchangeables.
 */
import ts from 'typescript';
import { claimsFromPrompt, hitsInRows, linkChain, observedFields, quantitativeClaim, rowsAbout, termCovers, type ChainProof } from './chain.ts';

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

/** Une acquisition a son propre contrat. Elle ne hérite pas des mesures des autres vues. */
export type Acquisition = Requirements & { id: string; label: string; dependsOn: string[] };

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

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = fold(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function mentions(text: string, measure: string): boolean {
  return fold(text).includes(fold(measure));
}

/** Découpe la demande en acquisitions indépendantes, puis fusionne celles qui partagent grain, entité et période. */
export function acquisitionsOf(prompt: string): Acquisition[] {
  const claims = claimsFromPrompt(prompt);
  const measures = unique(claims.filter((claim) => claim.kind === 'mesure').map((claim) => claim.text));
  const entities = unique(claims.filter((claim) => claim.kind === 'entite').map((claim) => claim.text));
  const units = unique(claims.filter((claim) => claim.kind === 'unite').map((claim) => claim.text));
  const periods = unique(claims.filter((claim) => claim.kind === 'periode').map((claim) => claim.text));
  const filters = unique(claims.filter((claim) => claim.kind === 'filtre').map((claim) => claim.text));
  const ui = unique(claims.filter((claim) => claim.kind === 'vue' || claim.kind === 'meta' || claim.kind === 'action' || claim.kind === 'operation').map((claim) => claim.text));
  const segments = prompt.split(/\s+et\s+|,\s*|;\s*/i).map((part) => part.trim()).filter(Boolean);
  const isSeries = (part: string) => /courbe|graphique|historique|sparkline|par jour|par semaine|série|serie/i.test(part);
  const isList = (part: string) => /top\s*\d+|classement|\btableau\b|\bliste\b|\bgrille\b/i.test(part);
  const isGlobal = (part: string) => /\bglobal\b|ensemble du|tous les totaux/i.test(part);
  const seriesText = segments.filter(isSeries).join(' ');
  const listText = segments.filter(isList).join(' ');
  const globalText = segments.filter(isGlobal).join(' ');
  const pointText = segments.filter((part) => !isSeries(part) && !isList(part) && !isGlobal(part)).join(' ');
  const namedIn = (text: string) => entities.filter((entity) => mentions(text, entity));
  const measured = (text: string) => measures.filter((measure) => mentions(text, measure));
  const wantsSeries = seriesText.length > 0;
  const wantsList = listText.length > 0;
  const wantsGlobal = globalText.length > 0;
  const base = { units, filters, ui, dependsOn: [] as string[] };
  const out: Acquisition[] = [];
  if (wantsGlobal) {
    const own = measured(globalText);
    const totals = own.length ? own : measures.filter((measure) => /total|nombre|count/i.test(measure));
    if (totals.length || !measures.length) out.push({ ...base, id: 'global', label: 'agrégat global', entities: [], measures: totals.length ? totals : measures, periods: [], grain: 'point', scope: 'global' });
  }
  if (wantsList) {
    const own = measured(listText);
    if (own.length) out.push({ ...base, id: 'liste', label: 'collection agrégée', entities: namedIn(listText), measures: own, periods: [], grain: 'liste', scope: 'agrege' });
  }
  if (wantsSeries) {
    const own = measured(seriesText);
    if (own.length || measures.length) out.push({ ...base, id: 'serie', label: 'série historique', entities: namedIn(seriesText), measures: own.length ? own : measures.slice(0, 1), periods, grain: 'serie', scope: 'historique' });
  }
  const pointMeasures = measured(pointText);
  const pointEntities = namedIn(pointText);
  if (pointMeasures.length || (!wantsSeries && !wantsList && !wantsGlobal && (measures.length || entities.length))) {
    const own = pointMeasures.length ? pointMeasures : measures;
    const who = pointEntities.length ? pointEntities : wantsSeries || wantsList || wantsGlobal ? [] : entities;
    const scope: Scope = who.length ? 'individuel' : 'agrege';
    out.push({ ...base, id: 'instant', label: 'mesures instantanées', entities: who, measures: own, periods: wantsSeries ? [] : periods, grain: 'point', scope });
  }
  if (!out.length && (measures.length || entities.length)) {
    const grain: Grain = wantsSeries ? 'serie' : wantsList ? 'liste' : 'point';
    const scope: Scope = grain === 'serie' ? 'historique' : grain === 'liste' ? 'agrege' : entities.length ? 'individuel' : wantsGlobal ? 'global' : 'agrege';
    out.push({ ...base, id: grain, label: grain, entities, measures, periods, grain, scope });
  }
  return out;
}

/** Exigences d'une acquisition. Le grain dominant reste disponible pour les appels qui visent une seule vue. */
export function requirementsOf(prompt: string): Requirements {
  const all = acquisitionsOf(prompt);
  const grain: Grain = /courbe|graphique|historique|sparkline|par jour|par semaine|série|serie/i.test(prompt)
    ? 'serie'
    : /top\s*\d+|classement|tableau|liste|grille/i.test(prompt)
      ? 'liste'
      : 'point';
  const match = all.find((item) => item.grain === grain) ?? all[0];
  return match ?? { entities: [], measures: [], units: [], periods: [], filters: [], grain: 'point', scope: 'agrege', ui: [] };
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

function carriedTokens(args: string): Array<{ key: string; value: string }> {
  const named = [...args.matchAll(/([A-Za-z_][\w]*)\s*[:=]\s*['"]([^'"]+)['"]/g)].map((match) => ({ key: match[1] ?? '', value: match[2] ?? '' }));
  const positional = [...args.matchAll(/client(?:\.\w+)+\(\s*['"]([^'"]+)['"]/g)].map((match) => ({ key: 'id', value: match[1] ?? '' }));
  return [...named, ...positional];
}

function tokenMatches(value: string, needle: string): boolean {
  return fold(value) === fold(needle);
}

/** Après l'appel : la réponse est jugée sur le contrat de son acquisition, pas sur tout le dashboard. */
export function responseInScope(rows: Array<Record<string, unknown>>, req: Requirements, carried?: { args?: string }): { ok: boolean; reason: string; obtained: string[]; scopeMismatch: boolean; carried: string[] } {
  const kept = carriedTokens(carried?.args ?? '');
  const carriedLabels = [
    ...req.entities.filter((entity) => kept.some((item) => /id|slug|symbol|name/i.test(item.key) && tokenMatches(item.value, entity))).map((entity) => `entité ${entity}`),
    ...req.units.filter((unit) => kept.some((item) => /currency|devise|unit|vs_currency/i.test(item.key) && tokenMatches(item.value, unit))).map((unit) => `unité ${unit}`),
    ...req.periods.filter((period) => kept.some((item) => /days|interval|from|to/i.test(item.key) && fold(`${item.value} ${period}`).includes(fold(item.value)))).map((period) => `période ${period}`),
  ];
  if (!rows.length) return { ok: false, reason: 'réponse vide', obtained: [], scopeMismatch: false, carried: carriedLabels };
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((field) => field !== 'collection');
  const obtained = fields.slice(0, 12);
  const entityInValues = (entity: string) => hitsInRows(rows, [entity]).length > 0;
  const entityInArgs = (entity: string) => rows.length <= 1 && kept.some((item) => /id|slug|symbol|name/i.test(item.key) && tokenMatches(item.value, entity));
  const entityMissing = req.entities.filter((entity) => !entityInValues(entity) && !entityInArgs(entity));
  if (req.scope !== 'global' && globalShape(fields)) {
    return { ok: false, reason: 'périmètre global', obtained, scopeMismatch: true, carried: carriedLabels };
  }
  const dated = fields.some((field) => /date|time|timestamp|jour/i.test(field));
  if (req.grain === 'serie' && !dated) {
    return { ok: false, reason: 'granularité : série attendue', obtained, scopeMismatch: true, carried: carriedLabels };
  }
  if (req.scope !== 'global' && req.entities.length && entityMissing.length && rows.length > 1) {
    return { ok: false, reason: `population hors entité : ${entityMissing.join(', ')}`, obtained, scopeMismatch: true, carried: carriedLabels };
  }
  const about = rowsAbout(rows, req.entities);
  const seen = observedFields(about);
  const measuresMissing = req.measures.filter((measure) => {
    const quantitative = quantitativeClaim(measure);
    const pool = quantitative ? seen.measured : [...seen.witness, ...seen.measured];
    return !pool.some((field) => termCovers(measure, field));
  });
  if (measuresMissing.length) {
    const named = measuresMissing.filter((measure) => fields.some((field) => termCovers(measure, field)));
    const reason = named.length ? `mesure sans valeur : ${named.join(', ')}` : `mesure absente : ${measuresMissing.join(', ')}`;
    return { ok: false, reason, obtained, scopeMismatch: false, carried: carriedLabels };
  }
  if (req.scope !== 'global' && req.entities.length && entityMissing.length) return { ok: false, reason: `entité absente : ${entityMissing.join(', ')}`, obtained, scopeMismatch: false, carried: carriedLabels };
  return { ok: true, reason: carriedLabels.length ? `périmètre tenu (${carriedLabels.join(', ')})` : 'périmètre tenu', obtained, scopeMismatch: false, carried: carriedLabels };
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
