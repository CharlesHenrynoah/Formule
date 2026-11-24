/**
 * Étape de sourcing, avant tout développement.
 * L’agent Sélecteur choisit le MCP ; le déterministe ne sert qu’en repli.
 * Le dépôt et les garde-fous (keepNamedServer, Product Owner) restent déterministes.
 */
import { argsForTool, keepNamedServer, mentionedServers, readsForCollections, readsForUnmatched, valueFits, type ServerRecord, type SourceTool } from '../../app-agents/ingest.ts';
import {
  classifyRestriction,
  correctAcquisition,
  dropOptionalArgument,
  executeCodePrompt,
  parameterIsOptional,
  restrictedParameter,
  findCodeTool,
  findDocsTool,
  mcpMetaNames,
  observeShape,
  sdkHintsFromDocs,
  stripCodeFence,
  stripTypeSuppression,
  type DiagnosticClass,
} from './execute-code.ts';
import { classifyLink } from '../../../../mcp-hub/src/link-state.ts';
import { admitExecute } from './execute-gate.ts';
import { reviewSource } from './product-owner.ts';
import { acquisitionNeeds, hitsInRows, linkChain, observedFields, rowsAbout } from './chain.ts';
import { classifySearch, profileTool } from './capabilities.ts';
import { readsFromSelector, selectorPrompt } from './select-mcp.ts';
import { routeDemand } from './pose.ts';
import { splitAcquisition } from '../../discovery/acquire.ts';
import { attemptKey, callIdentity, compileIntent, methodFits, methodJournal, registerMethods, responseInScope, selectMethod, type Acquisition, type Intent } from './sdk-scope.ts';
import { alignPairSeries, keepSpan } from './series.ts';

export type ResponseState = 'vide' | 'erreur' | 'inconnu' | 'valide';
export type SourceRead = { tool: string; args: Record<string, unknown>; ok: boolean; error?: string; rows: Array<Record<string, unknown>>; raw?: unknown; diagnostic?: DiagnosticClass; state?: ResponseState; acquisition?: string; observedAt?: string };
export type SourceSample = { tool: string; args: Record<string, unknown>; rows: Array<Record<string, unknown>> };
export type SourceOffer = { canBuild: boolean; text: string; brief: string; samples: SourceSample[]; log: string };

/** Séries [horodatage, mesure] alignées par horodatage. Le nom de série reste celui du serveur. */
function chartRows(data: unknown): Array<Record<string, unknown>> | null {
  return alignPairSeries(data);
}

export function failureText(data: unknown): string | null {
  const text = typeof data === 'string'
    ? data
    : data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string'
      ? String((data as { message: string }).message)
      : '';
  if (/TypeScript diagnostics|Expected \d+\s*(?:-\d+)?\s+arguments?, but got|SyntaxError|TypeError|ReferenceError|is not a function|Traceback \(most recent|ValidationError|ZodError/i.test(text)) return text.slice(0, 900);
  const link = text ? classifyLink(text).obstacle : 'unknown';
  if (link === 'transport' || link === 'session') return text.slice(0, 900);
  return null;
}

const DOC_KEY = /^(method|endpoint|summary|description|params|response|query|language|path|url)$/i;

export function isDocumentationRow(row: Record<string, unknown>): boolean {
  const keys = Object.keys(row).filter((key) => key !== 'collection');
  return keys.length > 0 && keys.every((key) => DOC_KEY.test(key));
}

function asRows(value: unknown[]): Array<Record<string, unknown>> | null {
  if (!value.length) return null;
  if (value.every((item) => item && typeof item === 'object' && !Array.isArray(item))) return value as Array<Record<string, unknown>>;
  if (value.every((item) => item == null || ['string', 'number', 'boolean'].includes(typeof item))) return value.map((item) => ({ value: item }));
  return null;
}

/** Projection sans perte : la forme brute décide, un non-tableau n'est pas vide. */
export function projectResponse(data: unknown): { state: ResponseState; rows: Array<Record<string, unknown>>; collections: Record<string, Array<Record<string, unknown>>>; shape: string } {
  const empty = { state: 'vide' as const, rows: [], collections: {}, shape: 'vide' };
  if (data == null || data === '') return empty;
  if (typeof data === 'number' || typeof data === 'boolean') {
    const rows = [{ value: data }];
    return { state: 'valide', rows, collections: { valeur: rows }, shape: typeof data };
  }
  if (typeof data === 'string') {
    if (!data.trim()) return empty;
    const lines = data.split('\n').map((line) => line.replace(/^\s*[-*]\s*/, '').replace(/^\d+(?:\.\d+)*\s+/, '').trim()).filter((line) => line.length > 2 && line.length < 120 && !line.endsWith(':'));
    const rows = lines.length > 1 ? keepSpan(lines, 80).map((titre) => ({ titre })) : [{ texte: data.trim().slice(0, 280) }];
    return { state: 'valide', rows, collections: { texte: rows }, shape: 'texte' };
  }
  if (typeof data !== 'object') return { state: 'inconnu', rows: [], collections: {}, shape: typeof data };
  if (Array.isArray(data)) {
    if (!data.length) return empty;
    const rows = asRows(data);
    if (!rows) return { state: 'inconnu', rows: [], collections: {}, shape: observeShape(data) };
    return { state: 'valide', rows: keepSpan(rows, 240), collections: { liste: rows }, shape: observeShape(data) };
  }
  const chart = chartRows(data);
  if (chart?.length) return { state: 'valide', rows: chart, collections: { serie: chart }, shape: observeShape(data) };
  const record = data as Record<string, unknown>;
  const collections: Record<string, Array<Record<string, unknown>>> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!Array.isArray(value)) continue;
    const rows = asRows(value);
    if (rows) collections[key] = keepSpan(rows, 240);
  }
  const names = Object.keys(collections);
  if (names.length) {
    const rows = names.flatMap((name) => collections[name]!.map((row) => (names.length > 1 ? { ...row, collection: name } : row)));
    return { state: 'valide', rows, collections, shape: observeShape(data) };
  }
  const keys = Object.keys(record);
  if (!keys.length) return empty;
  if (keys.length === 1 && record[keys[0]!] && typeof record[keys[0]!] === 'object') {
    const inner = projectResponse(record[keys[0]!]);
    if (inner.state === 'valide' || inner.state === 'vide') return inner;
  }
  const row: Record<string, unknown> = {};
  const flatten = (value: unknown, prefix: string) => {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      if (prefix) row[prefix] = value;
      return;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length && prefix) row[prefix] = value;
    for (const [key, child] of entries) flatten(child, prefix ? `${prefix}.${key}` : key);
  };
  flatten(record, '');
  if (Object.keys(row).length) return { state: 'valide', rows: [row], collections: { objet: [row] }, shape: observeShape(data) };
  return { state: 'inconnu', rows: [], collections: {}, shape: observeShape(data) };
}

function columnRole(key: string, rows: Array<Record<string, unknown>>): 'date' | 'libellé' | 'nombre' | 'état' {
  const values = rows.map((row) => row[key]).filter((value) => value != null && value !== '');
  if (/state|status|etat|statut/i.test(key)) return 'état';
  if (values.some((value) => typeof value === 'number' && Number.isFinite(value) || (typeof value === 'string' && /^-?\d+(?:[.,]\d+)?$/.test(value.trim())))) return 'nombre';
  if (/date|created|published|updated|merged|closed|timestamp/i.test(key) || values.some((value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value))) return 'date';
  return 'libellé';
}

function fieldsOf(rows: Array<Record<string, unknown>>): string {
  const list = rows.filter((row) => row && !isDocumentationRow(row));
  const pool = list.length ? list : rows;
  if (!pool.length) return 'aucun champ observé';
  const keys = [...new Set(pool.flatMap((item) => Object.keys(item)))];
  const ranked = [...keys].sort((a, b) => {
    const score = (key: string) => columnRole(key, pool) === 'nombre' ? 0 : columnRole(key, pool) === 'date' ? 1 : 2;
    return score(a) - score(b);
  });
  return ranked.slice(0, 8).map((key) => `${key} (${columnRole(key, pool)})`).join(', ');
}

function norm(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function labelsOn(page: string): string[] {
  const labels: string[] = [];
  for (const match of page.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)) {
    const text = match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) labels.push(text);
  }
  for (const match of page.matchAll(/\blabel=["']([^"']+)["']/gi)) labels.push(match[1]);
  return labels;
}

/** Titre déjà affiché sur la page, pour n'importe quel projet. Un mot trop court ne bloque pas une autre vue. */
export function presentLabel(prompt: string, page: string): string | null {
  if (!page.trim()) return null;
  const route = routeDemand(prompt);
  const quoted = [...prompt.matchAll(/[«"]([^»"]{2,80})[»"]/g)].map((match) => match[1].trim());
  const names = [...quoted, route.title].filter(Boolean);
  for (const label of labelsOn(page)) {
    const shown = norm(label);
    if (shown.length < 4) continue;
    for (const name of names) {
      const asked = norm(name);
      const words = asked.split(' ').filter(Boolean);
      if (asked.length < 4) continue;
      if (shown === asked || (words.length >= 2 && shown.includes(asked))) return label.replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

/** Texte montré à l'utilisateur, et le brief que le développement réutilise s'il valide. */
export function offerFromReads(prompt: string, reads: SourceRead[], page = '', intent: Intent = compileIntent(prompt)): SourceOffer {
  const present = presentLabel(prompt, page);
  if (present) {
    const text = `Cet élément est déjà présent sur l'interface : « ${present} ».\nRien de nouveau ne sera généré.`;
    return { canBuild: false, text, brief: text, samples: [], log: text };
  }
  const route = intent.route;
  const needles = intent.claims.filter((claim) => claim.kind === 'entite' || claim.kind === 'filtre').map((claim) => claim.text);
  const holdsDemand = (row: Record<string, unknown>) => {
    const fields = Object.keys(row).filter((key) => key !== 'collection');
    const hits = hitsInRows([row], needles);
    const seen = observedFields([row]);
    const chain = linkChain(prompt, fields, { hits, measured: seen.measured, witness: seen.witness, population: 1 }, intent.claims);
    const needs = acquisitionNeeds(chain);
    if (!needs.length) return true;
    const entityNeeds = needs.some((need) => need.kind === 'entite' || need.kind === 'filtre');
    if (entityNeeds && hits.length > 0) return true;
    const open = new Set(needs.map((need) => need.text));
    return chain.links.some((link) => {
      const kind = chain.claims.find((claim) => claim.id === link.claim)?.kind;
      return (kind === 'mesure' || kind === 'unite' || kind === 'dimension') && link.state === 'tenu' && !open.has(link.text) && !!link.field && fields.includes(link.field);
    });
  };
  const useful = (read: SourceRead) => read.ok && read.rows.some((row) => !isDocumentationRow(row) && holdsDemand(row));
  const business = (read: SourceRead) => useful(read);
  const lines = !route.data
    ? ['Aucune collection à lire pour cette demande.']
    : reads.length
    ? reads.map((read) => {
      const where = [read.args.owner, read.args.repo].filter(Boolean).join('/') || String(Object.entries(read.args).find(([key, value]) => key !== 'language' && key !== 'code' && typeof value === 'string' && value.length > 2 && value.length < 80 && !/function|=>|client\./.test(value))?.[1] ?? '');
      if (!read.ok) return `${read.tool}${where ? ` sur ${where}` : ''} a échoué : ${read.error ?? 'lecture impossible'}.`;
      const proof = read.acquisition ? ` Preuve ${read.acquisition}.` : '';
      const fields = fieldsOf(read.rows);
      if (read.rows.length && !read.rows.every((row) => isDocumentationRow(row)) && !useful(read)) return `${read.tool}${where ? ` sur ${where}` : ''} : ${read.rows.length} ligne, champs hors demande : ${fields}.${proof}`;
      return `${read.tool}${where ? ` sur ${where}` : ''} : ${read.rows.length} ligne${read.rows.length > 1 ? 's' : ''}. Champs : ${fields}.${proof}`;
    })
    : ['Aucune lecture ne correspond à cette demande.'];
  const ready = !route.data || reads.some(business);
  const quoted = [...prompt.matchAll(/[«"]([^»"]{2,80})[»"]/g)].map((match) => match[1].trim());
  const named = [...quoted].reverse().find((label) => label.split(' ').length >= 2 && !/[{}/]/.test(label));
  const element = `Ce qui peut être généré : ${route.kind} « ${named || route.title} ».`;
  const obtained = reads.filter(business);
  const failed = reads.filter((read) => !read.ok);
  const summary = !route.data
    ? [
      'Données obtenues : aucune.',
      'Données manquantes : aucune lecture demandée.',
      'Obstacle : aucun.',
      'Correction : aucune.',
      'Résultat : génération sans lecture.',
    ].join('\n')
    : [
      `Données obtenues : ${obtained.map((read) => `${read.tool} (${read.rows.length} ligne${read.rows.length > 1 ? 's' : ''})`).join(', ') || 'aucune'}.`,
      `Données manquantes : ${ready ? 'aucune' : 'lecture exploitable'}.`,
      `Obstacle : ${failed.map((read) => read.error).filter(Boolean).join(' ; ') || 'aucun'}.`,
      'Correction : aucune.',
      `Résultat : ${ready ? 'lecture exploitable' : 'rien ne peut être généré'}.`,
    ].join('\n');
  const text = [
    summary,
    'Voici les données pour cette demande.',
    ...lines,
    ready ? element : `Rien ne peut être généré pour « ${named || route.title} » tant qu’une lecture ne renvoie pas les mesures demandées.`,
  ].join('\n');
  const brief = [`Sourcing validé. ${element}`, ...lines, 'Respecte le rôle de chaque champ : une date reste une date, un libellé reste un libellé.'].join('\n');
  const samples = reads.filter(business).slice(0, 3).map((read) => ({
    tool: read.tool,
    args: read.args,
    rows: splitAcquisition(read.rows).stored.filter((row) => !needles.length || hitsInRows(read.rows, needles).length === 0 || hitsInRows([row], needles).length > 0).map((row) => {
      const clipped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row).slice(0, 12)) clipped[key] = typeof value === 'string' && value.length > 180 ? value.slice(0, 180) : value;
      return clipped;
    }),
  }));
  const log = failed.map((read) => {
    const code = typeof read.args.code === 'string' ? `\n${read.args.code}` : '';
    return `${read.tool} [${read.diagnostic ?? 'autre'}] ${read.error ?? ''}${code}`;
  }).join('\n');
  return { canBuild: ready, text, brief, samples, log };
}

type Listed = { id: string; description?: string; serverName?: string; write?: boolean; ecriture?: boolean; schema?: unknown; inputSchema?: unknown };

function serverOf(id: string): string {
  return id.includes('__') ? id.split('__')[0] : '';
}

async function runReads(
  reads: Array<{ tool: string; args: Record<string, unknown> }>,
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  admit?: (tool: string, args: Record<string, unknown>) => string | null,
  lock?: { required: string[]; forbidden: string[] },
): Promise<SourceRead[]> {
  const done: SourceRead[] = [];
  const dead = new Set<string>();
  for (const read of reads) {
    const server = serverOf(read.tool);
    if (lock && (lock.forbidden.includes(server) || (lock.required.length > 0 && !lock.required.includes(server)))) {
      done.push({ ...read, ok: false, error: `source refusée : ${server || read.tool}`, rows: [], state: 'erreur', diagnostic: 'signature' });
      continue;
    }
    if (server && dead.has(server)) continue;
    const refusal = admit?.(read.tool, read.args) ?? null;
    if (refusal === 'defer') continue;
    if (refusal) {
      done.push({ ...read, ok: false, error: refusal, rows: [], state: 'erreur', diagnostic: 'signature' });
      continue;
    }
    try {
      const result = await call(read.tool, read.args);
      const failed = failureText(result);
      if (failed) {
        done.push({ ...read, ok: false, error: failed, rows: [], raw: result, diagnostic: correctAcquisition('', failed).diagnostic });
        if (classifyRestriction(failed) === 'TRANSPORT_ERROR' && server) dead.add(server);
        continue;
      }
      const projected = projectResponse(result);
      done.push({
        ...read,
        ok: projected.state === 'valide',
        error: projected.state === 'vide' ? 'réponse vide' : projected.state === 'inconnu' ? 'structure inconnue' : undefined,
        rows: projected.rows,
        raw: result,
        state: projected.state,
      });
    } catch (error) {
      const message = (error as Error).message;
      done.push({ ...read, ok: false, error: message, rows: [], diagnostic: correctAcquisition('', message).diagnostic });
      if (classifyRestriction(message) === 'TRANSPORT_ERROR' && server) dead.add(server);
    }
  }
  return done;
}

/** Une acquisition réussie reste. L'échec d'une autre ne l'efface pas. */
function keepFootholds(previous: SourceRead[], extra: SourceRead[]): SourceRead[] {
  const kept = [...previous];
  for (const read of extra) {
    const index = kept.findIndex((item) => item.tool === read.tool && JSON.stringify(item.args) === JSON.stringify(read.args));
    if (index === -1) kept.push(read);
    else if (read.ok && read.rows.length) kept[index] = read;
    else if (!kept[index]?.ok) kept[index] = read;
  }
  return kept;
}

const DATA_KINDS = new Set(['mesure', 'unite', 'periode', 'dimension', 'parametre']);

function selectionNote(input: { intention: string; capacite: string; candidats: string[]; exclus: string[]; args: Record<string, unknown>; preuves: string[]; resultat: string }): string {
  return [
    `intention : ${input.intention}`,
    `capacité : ${input.capacite}`,
    `candidats : ${input.candidats.join(', ') || 'aucun'}`,
    `exclus : ${input.exclus.join(' ; ') || 'aucun'}`,
    `arguments : ${JSON.stringify(input.args)}`,
    `preuves : ${input.preuves.join(' ; ') || 'aucune'}`,
    `résultat : ${input.resultat}`,
  ].join('\n');
}

function excludedTools(catalog: SourceTool[], server: string): string[] {
  return catalog
    .filter((tool) => !server || serverOf(tool.id) === server)
    .map((tool) => ({ tool, profile: profileTool(tool) }))
    .filter((item) => item.profile.capability === 'VALIDATE' || item.profile.capability === 'TRIGGER' || item.profile.capability === 'WRITE' || item.profile.capability === 'SDK_EXECUTE')
    .slice(0, 8)
    .map((item) => `${item.tool.id} (${item.profile.capability} : ${item.profile.reasons[0]})`);
}

function filterArgs(tool: SourceTool, prompt: string, needle: string): Record<string, unknown> | null {
  const base = argsForTool(tool, prompt);
  if (!base) return null;
  const props = tool.inputSchema?.properties ?? {};
  const key = Object.keys(props).find((item) => /^(query|q|search|name|filter|nom)$/i.test(item));
  if (!key) return null;
  const prop = props[key];
  const description = prop && typeof prop === 'object' && 'description' in prop ? String((prop as { description?: unknown }).description ?? '') : '';
  if (!/filter|search|name|description|nom|titre|label|filtre/i.test(description)) return null;
  if (!valueFits(needle, prop)) return null;
  return { ...base, [key]: needle };
}

function hasDataNeed(prompt: string, done: SourceRead[], intent: Intent): boolean {
  const rows = done.filter((read) => read.ok).flatMap((read) => read.rows).filter((row) => !isDocumentationRow(row));
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const needles = intent.claims.filter((claim) => claim.kind === 'entite' || claim.kind === 'filtre').map((claim) => claim.text);
  const seen = observedFields(rowsAbout(rows, needles));
  const chain = linkChain(prompt, fields, { hits: hitsInRows(rows, needles), measured: seen.measured, witness: seen.witness, population: rows.length }, intent.claims);
  return acquisitionNeeds(chain).some((need) => DATA_KINDS.has(need.kind));
}

/** Une entité se résout dans les valeurs, ou par un filtre de recherche. Jamais par un outil incompatible. */
async function coverEntities(
  prompt: string,
  catalog: SourceTool[],
  done: SourceRead[],
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  intent: Intent,
): Promise<{ done: SourceRead[]; log: string; gap: string; changed: boolean }> {
  const needs = intent.claims.filter((claim) => claim.kind === 'entite' || claim.kind === 'filtre');
  if (!needs.length) return { done, log: '', gap: '', changed: false };
  const notes: string[] = [];
  let gap = '';
  let changed = false;
  const locked = sourceLock(intent);
  const { use, skip } = locked ? { use: locked.required, skip: locked.forbidden } : mentionedServers(prompt, catalog);
  const fromReads = [...new Set(done.map((read) => serverOf(read.tool)).filter(Boolean))];
  const preferred = use.length ? use : fromReads.filter((id) => !skip.includes(id) && !/^demo/.test(id));
  const down = new Set(done.filter((read) => !read.ok && (read.diagnostic === 'transport' || classifyRestriction(read.error ?? '') === 'TRANSPORT_ERROR')).map((read) => serverOf(read.tool)));
  const searches = catalog.filter((tool) => {
    const server = serverOf(tool.id);
    if (down.has(server)) return false;
    if (skip.includes(server) || /^demo/.test(server) && !use.some((id) => /^demo/.test(id))) return false;
    if (preferred.length && !preferred.includes(server)) return false;
    return profileTool(tool).capability === 'SEARCH';
  });
  for (const need of needs) {
    const known = done.flatMap((read) => hitsInRows(read.rows, [need.text], read.tool));
    if (known.length) {
      notes.push(selectionNote({
        intention: need.text,
        capacite: 'SEARCH',
        candidats: [...new Set(known.map((hit) => hit.tool).filter((tool): tool is string => !!tool))],
        exclus: excludedTools(catalog, serverOf(known[0]?.tool ?? preferred[0] ?? '')),
        args: done.find((read) => read.tool === known[0]?.tool)?.args ?? {},
        preuves: known.slice(0, 3).map((hit) => `${hit.field}#${hit.rowId}`),
        resultat: 'correspondance',
      }));
      continue;
    }
    const tool = searches.find((item) => filterArgs(item, prompt, need.text));
    const args = tool ? filterArgs(tool, prompt, need.text) : null;
    if (!tool || !args) {
      if (preferred.some((id) => down.has(id))) continue;
      gap = gap || `recherche incomplète : ${need.text}`;
      notes.push(selectionNote({ intention: need.text, capacite: 'SEARCH', candidats: searches.map((item) => item.id), exclus: excludedTools(catalog, preferred[0] ?? ''), args: {}, preuves: [], resultat: 'recherche incomplète' }));
      continue;
    }
    const already = done.find((read) => read.tool === tool.id && JSON.stringify(read.args) === JSON.stringify(args));
    const extra = already ? [already] : await runReads([{ tool: tool.id, args }], call, undefined, sourceLock(intent));
    if (!already) {
      done = keepFootholds(done, extra);
      changed = true;
    }
    const read = extra[0];
    const verdict = classifySearch({ ok: !!read?.ok || read?.state === 'vide', rows: read?.rows ?? [], args, properties: tool.inputSchema?.properties, needle: need.text });
    const label = verdict.gap === 'correspondance' ? 'correspondance' : verdict.gap === 'absence' ? 'absence confirmée' : verdict.gap === 'pagination' ? 'pagination manquante' : verdict.gap === 'erreur' ? 'erreur technique' : 'recherche incomplète';
    if (verdict.gap !== 'correspondance') gap = `${label} : ${need.text}`;
    notes.push(selectionNote({
      intention: need.text,
      capacite: 'SEARCH',
      candidats: [tool.id],
      exclus: excludedTools(catalog, serverOf(tool.id)),
      args,
      preuves: verdict.hits.slice(0, 3).map((hit) => `${hit.field}#${hit.rowId}`),
      resultat: label,
    }));
  }
  return { done, log: notes.join('\n'), gap, changed };
}

function catalogOf(listed: Listed[]): SourceTool[] {
  return listed.filter((tool) => !(tool.write || tool.ecriture)).map((tool) => ({
    id: tool.id,
    name: tool.id.includes('__') ? tool.id.split('__').slice(1).join('__') : tool.id,
    description: tool.description,
    serverName: tool.serverName,
    write: false,
    inputSchema: (tool.schema ?? tool.inputSchema) as SourceTool['inputSchema'],
  }));
}

function mergeRecords(registry: ServerRecord[], catalog: SourceTool[]): ServerRecord[] {
  const map = new Map<string, ServerRecord>();
  for (const server of registry) map.set(server.id, { ...server, name: server.name || server.id });
  for (const tool of catalog) {
    const id = serverOf(tool.id);
    if (id.length < 3) continue;
    const have = map.get(id);
    if (!have) {
      map.set(id, { id, name: tool.serverName || id, enabled: true, status: 'connected', authorized: 1 });
      continue;
    }
    if (have.enabled === false || have.status === 'disabled') continue;
    have.status = 'connected';
    have.authorized = Math.max(have.authorized, 1);
    if (tool.serverName) have.name = have.name || tool.serverName;
  }
  return [...map.values()];
}

function sourceLock(intent: Intent): { required: string[]; forbidden: string[] } | undefined {
  if (!intent.sources.required.length && !intent.sources.forbidden.length) return undefined;
  return { required: intent.sources.required, forbidden: intent.sources.forbidden };
}

function narrowCatalog(catalog: SourceTool[], intent: Intent): SourceTool[] {
  const { required, forbidden } = intent.sources;
  const real = catalog.some((tool) => {
    const id = serverOf(tool.id);
    return id.length > 0 && !/^demo/.test(id) && !forbidden.includes(id);
  });
  return catalog.filter((tool) => {
    const id = serverOf(tool.id);
    if (!id || forbidden.includes(id)) return false;
    if (required.length && !required.includes(id)) return false;
    if (!required.length && /^demo/.test(id) && real) return false;
    return true;
  });
}

function sourceBlocked(lines: string[]): SourceOffer {
  const detail = lines.join(' ; ');
  const text = [
    'Sélecteur : contrainte de source tenue.',
    'Données obtenues : aucune.',
    `Données manquantes : ${detail}.`,
    `Obstacle : ${detail}.`,
    'Correction : aucune.',
    'Résultat : source indisponible.',
    'Voici les données pour cette demande.',
    'Rien ne peut être généré tant que la source demandée n’est pas disponible.',
  ].join('\n');
  return { canBuild: false, text, brief: text, samples: [], log: text };
}

async function holdSources(
  intent: Intent,
  identities: ServerRecord[],
  reconnect?: (id: string) => Promise<ServerRecord | null>,
): Promise<{ identities: ServerRecord[]; blocked: string[]; refresh: boolean }> {
  const blocked: string[] = [];
  let refresh = false;
  const next = identities.map((item) => ({ ...item }));
  for (const id of intent.sources.required) {
    const state = next.find((item) => item.id === id);
    if (!state) {
      blocked.push(`${id} : inconnu du registre`);
      continue;
    }
    if (state.enabled === false || state.status === 'disabled') {
      blocked.push(`${id} : désactivé`);
      continue;
    }
    if (state.status === 'connected') continue;
    let revived: ServerRecord | null = null;
    try { revived = reconnect ? await reconnect(id) : null; } catch (error) {
      revived = { ...state, status: 'error', authorized: 0, error: (error as Error).message };
    }
    if (revived && revived.status === 'connected' && revived.enabled !== false) {
      const index = next.findIndex((item) => item.id === id);
      next[index] = { ...state, ...revived, id };
      refresh = true;
      continue;
    }
    blocked.push(`${id} : indisponible (${revived?.error || state.error || 'connexion impossible'})`);
  }
  return { identities: next, blocked, refresh };
}

/** Lit les outils. Le sélecteur choisit le serveur. Le Product Owner valide avant Valider. */
export async function collectSource(
  prompt: string,
  page: string,
  list: () => Promise<Listed[]>,
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  select?: (mission: string) => Promise<string>,
  writeCode?: (mission: string) => Promise<string>,
  options?: { registry?: ServerRecord[]; registryUnreadable?: boolean; reconnect?: (id: string) => Promise<ServerRecord | null> },
): Promise<SourceOffer> {
  let intent = compileIntent(prompt);
  if (presentLabel(prompt, page)) return offerFromReads(prompt, [], page, intent);
  if (!intent.route.data) return offerFromReads(prompt, [], page, intent);
  try {
    const listed = await list();
    let catalog = catalogOf(listed);
    let identities = mergeRecords(options?.registry ?? [], catalog);
    intent = compileIntent(prompt, identities.map((item) => ({ id: item.id, name: item.name })));
    if (options?.registryUnreadable && intent.sources.unknown.length) return sourceBlocked(intent.sources.unknown.map((id) => `${id} : registre illisible`));
    if (intent.sources.unknown.length) return sourceBlocked(intent.sources.unknown.map((id) => `${id} : inconnu du registre`));
    const held = await holdSources(intent, identities, options?.reconnect);
    identities = held.identities;
    if (held.refresh) catalog = catalogOf(await list());
    for (const id of intent.sources.required) {
      if (held.blocked.some((line) => line.startsWith(`${id} :`))) continue;
      if (!catalog.some((tool) => serverOf(tool.id) === id)) held.blocked.push(`${id} : aucun outil autorisé`);
    }
    if (held.blocked.length) return sourceBlocked(held.blocked);
    catalog = narrowCatalog(catalog, intent);
    const demand = `${prompt}\n${page}`;
    let reads: Array<{ tool: string; args: Record<string, unknown> }> = [];
    let via: 'agent' | 'collections' | 'unmatched' | 'none' = 'none';

    // 1) Agent Sélecteur d’abord : choix intelligent du serveur / des outils.
    if (select) {
      try {
        const picked = keepNamedServer(demand, catalog, readsFromSelector(await select(selectorPrompt(demand, catalog, intent)), catalog, demand));
        if (picked.length) {
          reads = picked.slice(0, 3);
          via = 'agent';
        }
      } catch { /* repli déterministe */ }
    }

    // 2) Repli : collections connues, puis outils non appariés.
    if (!reads.length) {
      const known = keepNamedServer(demand, catalog, readsForCollections(intent.route.collections, demand, catalog));
      if (known.length) {
        reads = known.slice(0, 3);
        via = 'collections';
      }
    }
    if (!reads.length) {
      // Toujours garder keepNamedServer (anti demo bleed) — même motif que agent/collections.
      const unmatched = keepNamedServer(demand, catalog, readsForUnmatched(demand, catalog));
      if (unmatched.length) {
        reads = unmatched.slice(0, 3);
        via = 'unmatched';
      }
    }

    const codeIds = new Set(catalog.filter((tool) => profileTool(tool).capability === 'SDK_EXECUTE').map((tool) => tool.id));
    let liveDocs: ReturnType<typeof sdkHintsFromDocs> = [];
    const admitCall = (tool: string, args: Record<string, unknown>) => {
      if (!codeIds.has(tool)) return null;
      if (typeof args.code !== 'string') return 'defer';
      const verdict = admitExecute(String(args.code), liveDocs);
      return verdict.ok ? null : verdict.reason;
    };
    let done = await runReads(reads, call, admitCall, sourceLock(intent));
    let owner = reviewSource(prompt, catalog, done, intent);
    let lastCorrection = 'aucune';
    let lastLayer = '';
    let gap = '';
    let selectionLog = '';
    const covered = await coverEntities(prompt, catalog, done, call, intent);
    done = covered.done;
    selectionLog = covered.log;
    gap = covered.gap;
    if (covered.changed) owner = reviewSource(prompt, catalog, done, intent);
    if (owner.ok) gap = '';

    // Une acquisition à la fois. Une erreur ne retire pas les appuis déjà validés.
    // Une entité, un filtre ou une validation ne partent pas vers un exécuteur de code.
    if (!owner.ok && writeCode && hasDataNeed(prompt, done, intent)) {
      const locked = sourceLock(intent);
      const { use, skip } = locked ? { use: locked.required, skip: locked.forbidden } : mentionedServers(prompt, catalog);
      const fromReads = [...new Set(done.map((read) => serverOf(read.tool)).filter(Boolean))];
      const preferred = use.length ? use : fromReads.filter((id) => !skip.includes(id) && !/^demo/.test(id));
      const codeTool = findCodeTool(catalog, preferred, skip);
      const serverDown = (id: string) => done.some((read) => serverOf(read.tool) === id && !read.ok && (read.diagnostic === 'transport' || read.diagnostic === 'availability' || read.diagnostic === 'session' || classifyRestriction(read.error ?? '') === 'TRANSPORT_ERROR'));
      if (codeTool && serverDown(serverOf(codeTool.id))) {
        selectionLog += `liaison : transport sur ${serverOf(codeTool.id)}\n`;
        lastCorrection = 'liaison';
      } else if (codeTool) {
        const server = serverOf(codeTool.id);
        const documented = (rows: Array<Record<string, unknown>>) => rows.filter((row) => Object.keys(row).some((key) => /^(method|endpoint|summary|description|params|response)$/i.test(key)));
        let docs = sdkHintsFromDocs(done.flatMap((read) => (serverOf(read.tool) === server ? documented(read.rows) : [])));
        if (!docs.length) {
          const docsTool = findDocsTool(catalog, preferred.length ? preferred : [server], skip);
          if (docsTool) {
            const dug = await runReads([{ tool: docsTool.id, args: { query: prompt.slice(0, 160), language: 'en' } }], call, undefined, sourceLock(intent));
            done = [...done.filter((read) => !skip.includes(serverOf(read.tool))), ...dug];
            docs = sdkHintsFromDocs(dug.flatMap((read) => documented(read.rows)));
          }
        }
        const meta = mcpMetaNames(catalog, server);
        const registry = registerMethods(docs);
        const plan = intent.acquisitions;
        const banned = new Map<string, Set<string>>();
        const blockedAcq = new Set<string>();
        const spent = new Map<string, number>();
        const seen = new Set<string>();
        const ban = (id: string, method: string) => {
          if (!method) return;
          const set = banned.get(id) ?? new Set<string>();
          set.add(method);
          banned.set(id, set);
        };
        const denied = (id: string) => [...(banned.get(id) ?? [])];
        type Repair = { lastError?: string; lastCode: string; replay: string; strategy: 'rewrite' | 'minimal' | 'stop'; observed: string };
        const repairs = new Map<string, Repair>();
        const boxOf = (id: string): Repair => {
          const found = repairs.get(id);
          if (found) return found;
          const created: Repair = { lastCode: '', replay: '', strategy: 'rewrite', observed: '' };
          repairs.set(id, created);
          return created;
        };
        const prior = done.find((read) => read.tool === codeTool.id && read.error && typeof read.args.code === 'string');
        if (prior?.error && plan[0]) {
          const first = boxOf(plan[0].id);
          first.lastError = prior.error;
          if (prior.raw != null) first.observed = observeShape(prior.raw);
        }
        liveDocs = docs;
        const rowsOf = (id: string) => done.filter((read) => read.acquisition === id && read.ok).flatMap((read) => read.rows.filter((row) => !isDocumentationRow(row)));
        const argsOf = (id: string) => {
          const read = [...done].reverse().find((item) => item.acquisition === id && typeof item.args.code === 'string');
          return typeof read?.args.code === 'string' ? read.args.code : '';
        };
        const satisfied = (acq: Acquisition) => {
          const rows = rowsOf(acq.id);
          return rows.length > 0 && responseInScope(rows, acq, { args: argsOf(acq.id) }).ok;
        };
        const heldCount = () => plan.filter((item) => satisfied(item)).reduce((sum, item) => sum + item.measures.length + item.entities.length, 0);
        let held = heldCount();
        const ceiling = Math.min(12, Math.max(4, (plan.length || 1) * 3));
        for (let attempt = 0; attempt < ceiling; attempt++) {
          const acq = plan.find((item) => !blockedAcq.has(item.id) && (spent.get(item.id) ?? 0) < 2 && !satisfied(item));
          if (!acq) break;
          const box = boxOf(acq.id);
          if (box.strategy === 'stop') {
            blockedAcq.add(acq.id);
            continue;
          }
          const req = acq;
          const claim = acq.measures.concat(acq.entities).join(', ') || acq.label;
          lastLayer = acq.id;
          const available = registry.filter((method) => !denied(acq.id).includes(method.method));
          const picked = registry.length ? selectMethod(available, req, denied(acq.id)) : null;
          if (registry.length && !picked) {
            selectionLog += methodJournal({ method: '', args: '', scope: req.scope, expected: claim, obtained: '', decision: 'rejetée, aucune méthode au périmètre' }) + '\n';
            blockedAcq.add(acq.id);
            continue;
          }
          const shown = picked ? docs.filter((doc) => doc.method === picked.method.method) : docs.filter((doc) => !doc.method || !denied(acq.id).includes(doc.method));
          try {
            let code = '';
            if (box.replay) {
              code = box.replay;
              box.replay = '';
            } else if (box.lastCode && box.lastError && box.strategy === 'rewrite') {
              const fixed = correctAcquisition(box.lastCode, box.lastError, box.observed);
              lastCorrection = fixed.strategy === 'raw' ? 'retour brut, propriété absente retirée' : fixed.strategy === 'degrade' ? 'paramètre optionnel retiré' : fixed.strategy;
              if (fixed.strategy === 'stop' || (fixed.strategy === 'once' && (spent.get(acq.id) ?? 0) > 0)) {
                blockedAcq.add(acq.id);
                selectionLog += `restriction : branche ${acq.label} arrêtée\n`;
                box.lastCode = '';
                continue;
              }
              const rewritten = fixed.code ? callIdentity(fixed.code)[0]?.method : '';
              if (fixed.code && rewritten && denied(acq.id).includes(rewritten)) fixed.code = null;
              if (fixed.code && !seen.has(attemptKey(rewritten || 'script', callIdentity(fixed.code)[0]?.args ?? '', [acq.id]))) code = stripTypeSuppression(fixed.code);
              else box.strategy = fixed.strategy === 'raw' || fixed.strategy === 'reinspect' || fixed.strategy === 'minimal' || fixed.strategy === 'degrade' ? 'minimal' : box.strategy;
            }
            if (!code) {
              const raw = await writeCode(executeCodePrompt({
                prompt,
                tool: codeTool,
                docs: shown.length ? shown : docs,
                metaNames: meta,
                lastError: box.lastError,
                observed: box.observed,
                claim,
                minimal: box.strategy === 'minimal',
                excluded: denied(acq.id),
              }));
              code = stripTypeSuppression(stripCodeFence(raw));
              lastCorrection = box.strategy === 'minimal' ? 'appel minimal, retour brut' : 'nouvel appel ciblé';
            }
            const fact = callIdentity(code)[0];
            const method = fact?.method ?? '';
            const args = fact?.args ?? '';
            const known = method ? registry.find((item) => item.method === method) : undefined;
            const unfit = known ? methodFits(known, req) : null;
            if (registry.length && (!method || !known)) {
              if (method) ban(acq.id, method);
              selectionLog += methodJournal({ method, args, scope: req.scope, expected: claim, obtained: '', decision: 'rejetée avant l’appel, méthode non documentée' }) + '\n';
              box.lastCode = '';
              box.lastError = `méthode ${method || 'inconnue'} non documentée`;
              spent.set(acq.id, (spent.get(acq.id) ?? 0) + 1);
              continue;
            }
            if (method && (denied(acq.id).includes(method) || (unfit && !unfit.ok))) {
              ban(acq.id, method);
              selectionLog += methodJournal({ method, args, scope: req.scope, expected: claim, obtained: known?.fields.join(', ') || '', decision: `rejetée avant l’appel, ${unfit?.reason ?? 'méthode hors périmètre'}` }) + '\n';
              box.lastCode = '';
              box.lastError = `méthode ${method} exclue`;
              spent.set(acq.id, (spent.get(acq.id) ?? 0) + 1);
              continue;
            }
            const gate = admitExecute(code, shown.length ? shown : docs);
            if (!gate.ok) {
              box.lastError = gate.reason;
              box.lastCode = '';
              spent.set(acq.id, (spent.get(acq.id) ?? 0) + 1);
              if ((spent.get(acq.id) ?? 0) >= 2) blockedAcq.add(acq.id);
              continue;
            }
            const key = attemptKey(method || 'script', args, [acq.id]);
            if (seen.has(key)) {
              blockedAcq.add(acq.id);
              continue;
            }
            seen.add(key);
            box.lastCode = code;
            const extra = (await runReads([{ tool: codeTool.id, args: { code, intent: claim.slice(0, 160) } }], call, admitCall, sourceLock(intent))).map((read) => ({ ...read, acquisition: acq.id, observedAt: new Date().toISOString() }));
            done = keepFootholds(done, extra);
            const fresh = extra.find((read) => read.raw != null);
            if (fresh?.raw != null) box.observed = observeShape(fresh.raw);
            const freshRows = extra.flatMap((read) => read.ok ? read.rows.filter((row) => !isDocumentationRow(row)) : []);
            const verdict = freshRows.length ? responseInScope(freshRows, req, { args }) : null;
            if (verdict) {
              selectionLog += methodJournal({
                method,
                args,
                scope: `${req.scope}/${req.grain}`,
                expected: claim,
                obtained: verdict.obtained.join(', '),
                decision: verdict.ok ? 'acceptée' : `rejetée, ${verdict.reason}`,
              }) + '\n';
              if (verdict.ok) selectionLog += `preuve : ${acq.id} | ${method} | ${args || 'aucun'} | ${verdict.carried.concat(verdict.obtained).join(', ')}\n`;
            }
            const dated = freshRows.some((row) => Object.keys(row).some((field) => /date|time|timestamp|jour/i.test(field)));
            const historyLeft = req.grain === 'serie' && registry.some((item) => item.scope === 'historique' && item.method !== method && !denied(acq.id).includes(item.method));
            if (verdict?.ok && historyLeft && !dated && method) {
              ban(acq.id, method);
              selectionLog += methodJournal({ method, args, scope: `${req.scope}/${req.grain}`, expected: claim, obtained: verdict.obtained.join(', '), decision: 'rejetée, granularité point alors qu’une série est documentée' }) + '\n';
              box.lastCode = '';
              box.lastError = 'granularité : série attendue';
              spent.set(acq.id, (spent.get(acq.id) ?? 0) + 1);
              continue;
            }
            if (verdict && !verdict.ok && method) {
              ban(acq.id, method);
              box.lastCode = '';
              box.lastError = verdict.reason;
              spent.set(acq.id, (spent.get(acq.id) ?? 0) + 1);
              if (verdict.scopeMismatch) box.strategy = 'rewrite';
              continue;
            }
            const failure = extra.find((read) => !read.ok && read.error);
            const kind = failure?.error ? classifyRestriction(failure.error) : null;
            if (failure && (kind === 'TRANSPORT_ERROR' || failure.diagnostic === 'transport' || failure.diagnostic === 'availability' || failure.diagnostic === 'session')) {
              for (const item of plan) blockedAcq.add(item.id);
              selectionLog += `liaison : ${kind ?? failure.diagnostic} sur ${acq.label}\n`;
              lastCorrection = 'liaison';
              box.lastCode = '';
              box.strategy = 'stop';
              continue;
            }
            if (failure && (failure.diagnostic === 'auth' || kind === 'AUTH_INVALID' || kind === 'PERMISSION_DENIED' || failure.diagnostic === 'quota' || kind === 'QUOTA_EXCEEDED' || kind === 'RATE_LIMIT')) {
              blockedAcq.add(acq.id);
              selectionLog += `restriction : ${kind ?? failure.diagnostic} sur ${acq.label}\n`;
              lastCorrection = kind ?? failure.diagnostic ?? 'stop';
              box.lastCode = '';
              continue;
            }
            if (failure && (failure.diagnostic === 'restriction' || kind === 'PLAN_RESTRICTION' || kind === 'PARAMETER_RESTRICTION')) {
              const param = restrictedParameter(failure.error ?? '');
              const optional = !param || parameterIsOptional(known?.doc.params ?? '', param);
              const stripped = param && optional ? dropOptionalArgument(box.lastCode, param) : null;
              selectionLog += `restriction : ${kind ?? 'PLAN_RESTRICTION'}${param ? ` ${param}` : ''} sur ${acq.label}\n`;
              if (stripped && !seen.has(attemptKey(method || 'script', callIdentity(stripped)[0]?.args ?? '', [acq.id]))) {
                const degrades = acq.periods.length > 0 && /days|interval|from|to|start|end/i.test(param ?? '');
                selectionLog += degrades ? `dégradation : ${param} retiré, granularité par défaut\n` : `paramètre ${param} retiré, valeur par défaut conservée\n`;
                box.replay = stripped;
                box.lastError = '';
                continue;
              }
              ban(acq.id, method);
              if (!stripped) blockedAcq.add(acq.id);
              box.lastCode = '';
              continue;
            }
            owner = reviewSource(prompt, catalog, done, intent);
            const next = heldCount();
            selectionLog += `progression : ${held} → ${next} exigences tenues\n`;
            if (!owner.ok && next <= held) {
              if (method && verdict) ban(acq.id, method);
              spent.set(acq.id, (spent.get(acq.id) ?? 0) + 1);
              if ((spent.get(acq.id) ?? 0) >= 2) blockedAcq.add(acq.id);
              box.strategy = box.strategy === 'rewrite' ? 'minimal' : box.strategy;
            } else held = next;
            if (owner.ok) break;
            box.lastError = extra.map((read) => read.error).filter(Boolean).join('\n')
              || (verdict && !verdict.ok ? verdict.reason : '')
              || (extra.some((read) => read.ok && read.rows.length) ? 'lignes présentes mais hors intention' : 'réponse vide ou hors mesures');
          } catch (error) {
            box.lastError = (error as Error).message;
            if (correctAcquisition('', box.lastError).strategy === 'stop') blockedAcq.add(acq.id);
          }
        }
        const acquired = plan.filter((item) => satisfied(item)).map((item) => item.label);
        const missingAcq = plan.filter((item) => !acquired.includes(item.label)).map((item) => item.label);
        selectionLog += `acquises : ${acquired.join(', ') || 'aucune'}\nmanquantes : ${missingAcq.join(', ') || 'aucune'}\n`;
      }
    }

    const selectLine = via === 'agent'
      ? `Sélecteur (agent) : ${reads.map((read) => read.tool).join(', ') || 'aucun outil'}.`
      : via === 'collections'
      ? 'Sélecteur : repli collections (agent sans lecture valide).'
      : via === 'unmatched'
      ? 'Sélecteur : repli outils non appariés.'
      : '';
    // Afficher seulement les lectures hors skip (quests : séparer erreur / ok).
    const shown = sourceLock(intent);
    const useShow = shown?.required ?? [];
    const skipShow = shown?.forbidden ?? mentionedServers(prompt, catalog).skip;
    const visible = done.filter((read) => {
      const server = serverOf(read.tool);
      if (skipShow.includes(server)) return false;
      if (useShow.length && server && !useShow.includes(server)) return false;
      if (/^demo/.test(server) && skipShow.some((id) => /^demo/.test(id))) return false;
      return true;
    });
    const offer = offerFromReads(prompt, useShow.length ? visible : (visible.length ? visible : done.filter((read) => !/^demo/.test(serverOf(read.tool)))), page, intent);
    const sawBusiness = done.some((read) => read.ok && read.rows.some((row) => !isDocumentationRow(row)));
    const linkDown = done.some((read) => !read.ok && (read.diagnostic === 'transport' || read.diagnostic === 'availability' || read.diagnostic === 'session' || classifyRestriction(read.error ?? '') === 'TRANSPORT_ERROR'));
    if (sawBusiness || linkDown) gap = '';
    const missing = owner.ok ? 'aucune' : (owner.missing.filter((item) => item !== 'lecture métier').join(', ') || gap || 'lecture exploitable');
    const result = owner.ok && offer.canBuild ? 'exigences tenues' : linkDown && !sawBusiness ? 'liaison interrompue' : gap || (offer.samples.length ? 'acquisitions réussies conservées, exigences encore ouvertes' : 'rien ne peut être généré');
    let text = [
      selectLine,
      offer.text.replace('Données manquantes : aucune.', `Données manquantes : ${missing}.`).replace('Données manquantes : lecture exploitable.', `Données manquantes : ${missing}.`).replace('Correction : aucune.', `Correction : ${lastCorrection}.`).replace('Résultat : lecture exploitable.', `Résultat : ${result}.`).replace('Résultat : rien ne peut être généré.', `Résultat : ${result}.`),
    ].filter(Boolean).join('\n\n');
    if (!owner.ok) text = text.replace(/Ce qui peut être généré :[^\n]*/g, 'Rien ne peut être généré.');
    const focus = <T extends { rows: Array<Record<string, unknown>> }>(samples: T[]): T[] => {
      const needles = intent.claims.filter((claim) => claim.kind === 'entite' || claim.kind === 'filtre').map((claim) => claim.text);
      if (!needles.length) return samples;
      return samples.map((sample) => {
        if (!hitsInRows(sample.rows, needles).length) return sample;
        return { ...sample, rows: sample.rows.filter((row) => hitsInRows([row], needles).length > 0) };
      });
    };
    const log = [selectionLog, offer.log, owner.text, lastLayer ? `couche ${lastLayer}` : '', lastCorrection !== 'aucune' ? `correction ${lastCorrection}` : ''].filter(Boolean).join('\n\n');
    if (!owner.ok) {
      return { canBuild: false, text, brief: owner.brief, samples: focus(offer.samples), log };
    }
    return {
      canBuild: offer.canBuild,
      text,
      brief: [selectLine, offer.brief, owner.brief].filter(Boolean).join('\n\n'),
      samples: focus(owner.samples.length ? owner.samples : offer.samples),
      log,
    };
  } catch (error) {
    return offerFromReads(prompt, [{ tool: 'mcp', args: {}, ok: false, error: (error as Error).message, rows: [] }], page, intent);
  }
}
