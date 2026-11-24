/**
 * Étape de sourcing, avant tout développement.
 * L’agent Sélecteur choisit le MCP ; le déterministe ne sert qu’en repli.
 * Le dépôt et les garde-fous (keepNamedServer, Product Owner) restent déterministes.
 */
import { argsForTool, keepNamedServer, mentionedServers, readsForCollections, readsForUnmatched, valueFits, type SourceTool } from '../../app-agents/ingest.ts';
import {
  correctAcquisition,
  executeCodePrompt,
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
import { acquisitionNeeds, claimsFromPrompt, hitsInRows, linkChain } from './chain.ts';
import { classifySearch, profileTool } from './capabilities.ts';
import { rankNeeds } from '../../navigation/apf.ts';
import { readsFromSelector, selectorPrompt } from './select-mcp.ts';
import { routeDemand } from './pose.ts';
import { splitAcquisition } from '../../discovery/acquire.ts';
import { acquisitionProgress, attemptKey, callIdentity, methodFits, methodJournal, registerMethods, requirementsOf, responseInScope, selectMethod } from './sdk-scope.ts';
import { alignPairSeries, keepSpan } from './series.ts';

export type ResponseState = 'vide' | 'erreur' | 'inconnu' | 'valide';
export type SourceRead = { tool: string; args: Record<string, unknown>; ok: boolean; error?: string; rows: Array<Record<string, unknown>>; raw?: unknown; diagnostic?: DiagnosticClass; state?: ResponseState };
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

function roleOf(key: string, value: unknown): 'date' | 'libellé' | 'nombre' | 'état' {
  if (/state|status/i.test(key)) return 'état';
  if (/date|created|published|updated|merged|closed/i.test(key) || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value))) return 'date';
  if (typeof value === 'number') return 'nombre';
  return 'libellé';
}

function fieldsOf(row: Record<string, unknown> | undefined): string {
  if (!row) return 'aucun champ observé';
  return Object.entries(row).slice(0, 8).map(([key, value]) => `${key} (${roleOf(key, value)})`).join(', ');
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
export function offerFromReads(prompt: string, reads: SourceRead[], page = ''): SourceOffer {
  const present = presentLabel(prompt, page);
  if (present) {
    const text = `Cet élément est déjà présent sur l'interface : « ${present} ».\nRien de nouveau ne sera généré.`;
    return { canBuild: false, text, brief: text, samples: [], log: text };
  }
  const route = routeDemand(prompt);
  const needles = claimsFromPrompt(prompt).filter((claim) => claim.kind === 'entite' || claim.kind === 'filtre').map((claim) => claim.text);
  const holdsDemand = (row: Record<string, unknown>) => {
    const fields = Object.keys(row).filter((key) => key !== 'collection');
    const hits = hitsInRows([row], needles);
    const chain = linkChain(prompt, fields, { hits });
    const needs = acquisitionNeeds(chain);
    if (!needs.length) return true;
    if (needs.some((need) => need.kind === 'entite' || need.kind === 'filtre')) return hits.length > 0;
    const open = new Set(needs.map((need) => need.text));
    return chain.links.some((link) => link.state === 'tenu' && !open.has(link.text) && !!link.field && fields.includes(link.field));
  };
  const useful = (read: SourceRead) => read.ok && read.rows.some((row) => !isDocumentationRow(row) && holdsDemand(row));
  const business = (read: SourceRead) => useful(read);
  const lines = !route.data
    ? ['Aucune collection à lire pour cette demande.']
    : reads.length
    ? reads.map((read) => {
      const where = [read.args.owner, read.args.repo].filter(Boolean).join('/') || String(Object.entries(read.args).find(([key, value]) => key !== 'language' && key !== 'code' && typeof value === 'string' && value.length > 2 && value.length < 80 && !/function|=>|client\./.test(value))?.[1] ?? '');
      if (!read.ok) return `${read.tool}${where ? ` sur ${where}` : ''} a échoué : ${read.error ?? 'lecture impossible'}.`;
      const fields = fieldsOf(read.rows[0]);
      if (read.rows.length && !read.rows.every((row) => isDocumentationRow(row)) && !useful(read)) return `${read.tool}${where ? ` sur ${where}` : ''} : ${read.rows.length} ligne, champs hors demande : ${fields}.`;
      return `${read.tool}${where ? ` sur ${where}` : ''} : ${read.rows.length} ligne${read.rows.length > 1 ? 's' : ''}. Champs : ${fields}.`;
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
): Promise<SourceRead[]> {
  const done: SourceRead[] = [];
  for (const read of reads) {
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

function hasDataNeed(prompt: string, done: SourceRead[]): boolean {
  const rows = done.filter((read) => read.ok).flatMap((read) => read.rows);
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const needles = claimsFromPrompt(prompt).filter((claim) => claim.kind === 'entite' || claim.kind === 'filtre').map((claim) => claim.text);
  const chain = linkChain(prompt, fields, { hits: hitsInRows(rows, needles) });
  return acquisitionNeeds(chain).some((need) => DATA_KINDS.has(need.kind));
}

/** Une entité se résout dans les valeurs, ou par un filtre de recherche. Jamais par un outil incompatible. */
async function coverEntities(
  prompt: string,
  catalog: SourceTool[],
  done: SourceRead[],
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<{ done: SourceRead[]; log: string; gap: string; changed: boolean }> {
  const needs = claimsFromPrompt(prompt).filter((claim) => claim.kind === 'entite' || claim.kind === 'filtre');
  if (!needs.length) return { done, log: '', gap: '', changed: false };
  const notes: string[] = [];
  let gap = '';
  let changed = false;
  const { use, skip } = mentionedServers(prompt, catalog);
  const fromReads = [...new Set(done.map((read) => serverOf(read.tool)).filter(Boolean))];
  const preferred = use.length ? use : fromReads.filter((id) => !skip.includes(id) && !/^demo/.test(id));
  const searches = catalog.filter((tool) => {
    const server = serverOf(tool.id);
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
      gap = gap || `recherche incomplète : ${need.text}`;
      notes.push(selectionNote({ intention: need.text, capacite: 'SEARCH', candidats: searches.map((item) => item.id), exclus: excludedTools(catalog, preferred[0] ?? ''), args: {}, preuves: [], resultat: 'recherche incomplète' }));
      continue;
    }
    const already = done.find((read) => read.tool === tool.id && JSON.stringify(read.args) === JSON.stringify(args));
    const extra = already ? [already] : await runReads([{ tool: tool.id, args }], call);
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

/** Lit les outils. Le sélecteur choisit le serveur. Le Product Owner valide avant Valider. */
export async function collectSource(
  prompt: string,
  page: string,
  list: () => Promise<Listed[]>,
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  select?: (mission: string) => Promise<string>,
  writeCode?: (mission: string) => Promise<string>,
): Promise<SourceOffer> {
  const route = routeDemand(prompt);
  if (presentLabel(prompt, page)) return offerFromReads(prompt, [], page);
  if (!route.data) return offerFromReads(prompt, [], page);
  try {
    const listed = await list();
    const catalog: SourceTool[] = listed.filter((tool) => !(tool.write || tool.ecriture)).map((tool) => ({
      id: tool.id,
      name: tool.id.includes('__') ? tool.id.split('__').slice(1).join('__') : tool.id,
      description: tool.description,
      serverName: tool.serverName,
      write: false,
      inputSchema: (tool.schema ?? tool.inputSchema) as SourceTool['inputSchema'],
    }));
    const demand = `${prompt}\n${page}`;
    let reads: Array<{ tool: string; args: Record<string, unknown> }> = [];
    let via: 'agent' | 'collections' | 'unmatched' | 'none' = 'none';

    // 1) Agent Sélecteur d’abord : choix intelligent du serveur / des outils.
    if (select) {
      try {
        const picked = keepNamedServer(demand, catalog, readsFromSelector(await select(selectorPrompt(demand, catalog)), catalog, demand));
        if (picked.length) {
          reads = picked.slice(0, 3);
          via = 'agent';
        }
      } catch { /* repli déterministe */ }
    }

    // 2) Repli : collections connues, puis outils non appariés.
    if (!reads.length) {
      const known = keepNamedServer(demand, catalog, readsForCollections(route.collections, demand, catalog));
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
    let done = await runReads(reads, call, admitCall);
    let owner = reviewSource(prompt, catalog, done);
    let lastCorrection = 'aucune';
    let lastLayer = '';
    let gap = '';
    let selectionLog = '';
    const covered = await coverEntities(prompt, catalog, done, call);
    done = covered.done;
    selectionLog = covered.log;
    gap = covered.gap;
    if (covered.changed) owner = reviewSource(prompt, catalog, done);
    if (owner.ok) gap = '';

    // Une acquisition à la fois. Une erreur ne retire pas les appuis déjà validés.
    // Une entité, un filtre ou une validation ne partent pas vers un exécuteur de code.
    if (!owner.ok && writeCode && hasDataNeed(prompt, done)) {
      const { use, skip } = mentionedServers(prompt, catalog);
      const fromReads = [...new Set(done.map((read) => serverOf(read.tool)).filter(Boolean))];
      const preferred = use.length ? use : fromReads.filter((id) => !skip.includes(id) && !/^demo/.test(id));
      const codeTool = findCodeTool(catalog, preferred, skip);
      if (codeTool) {
        const server = serverOf(codeTool.id);
        let docs = sdkHintsFromDocs(done.flatMap((read) => (serverOf(read.tool) === server ? read.rows : [])));
        if (!docs.length) {
          const docsTool = findDocsTool(catalog, preferred.length ? preferred : [server], skip);
          if (docsTool) {
            const dug = await runReads([{ tool: docsTool.id, args: { query: prompt.slice(0, 160), language: 'en' } }], call);
            done = [...done.filter((read) => !skip.includes(serverOf(read.tool))), ...dug];
            docs = sdkHintsFromDocs(dug.flatMap((read) => read.rows));
          }
        }
        const meta = mcpMetaNames(catalog, server);
        const registry = registerMethods(docs);
        const banned = new Set<string>();
        const spent = new Map<string, number>();
        const seen = new Set<string>();
        let lastError: string | undefined;
        let lastCode = '';
        let observed = '';
        let stagnant = 0;
        let strategy: 'rewrite' | 'minimal' | 'stop' = 'rewrite';
        const blocked: string[] = [];
        const prior = done.find((read) => read.tool === codeTool.id && read.error && typeof read.args.code === 'string');
        if (prior?.error && prior.raw != null) observed = observeShape(prior.raw);
        liveDocs = docs;
        const businessFields = () => [...new Set(done.filter((read) => read.ok && read.rows.some((row) => !isDocumentationRow(row))).flatMap((read) => read.rows.filter((row) => !isDocumentationRow(row)).flatMap((row) => Object.keys(row))))];
        const progress = () => acquisitionProgress(prompt, businessFields());
        let held = progress().held.length;
        const ceiling = Math.min(8, Math.max(4, (requirementsOf(prompt).measures.length + requirementsOf(prompt).entities.length + 1) * 2));
        for (let attempt = 0; attempt < ceiling && strategy !== 'stop'; attempt++) {
          const fields = businessFields();
          const chain = linkChain(prompt, fields);
          const ranked = rankNeeds(acquisitionNeeds(chain).filter((need) => DATA_KINDS.has(need.kind) && need.kind !== 'periode'), blocked);
          const choice = ranked.find((item) => item.score > 0) ?? (strategy === 'minimal' ? ranked[0] : undefined);
          if (!choice) {
            strategy = 'stop';
            break;
          }
          const claim = choice.text;
          lastLayer = choice.layer;
          if ((spent.get(claim) ?? 0) >= 2) {
            blocked.push(claim);
            continue;
          }
          const req = requirementsOf(prompt);
          const available = registry.filter((method) => !banned.has(method.method));
          const picked = registry.length ? selectMethod(available, req, [...banned]) : null;
          if (registry.length && !picked) {
            selectionLog += methodJournal({ method: '', args: '', scope: req.scope, expected: req.measures.concat(req.entities).join(', ') || claim, obtained: '', decision: 'rejetée, aucune méthode au périmètre' }) + '\n';
            blocked.push(claim);
            continue;
          }
          const shown = picked ? docs.filter((doc) => doc.method === picked.method.method) : docs.filter((doc) => !doc.method || !banned.has(doc.method));
          try {
            let code = '';
            if (lastCode && lastError && strategy === 'rewrite') {
              const fixed = correctAcquisition(lastCode, lastError, observed);
              lastCorrection = fixed.strategy === 'raw' ? 'retour brut, propriété absente retirée' : fixed.strategy;
              if (fixed.strategy === 'stop') {
                strategy = 'stop';
                break;
              }
              if (fixed.strategy === 'once' && attempt > 0) {
                strategy = 'stop';
                break;
              }
              const rewritten = fixed.code ? callIdentity(fixed.code)[0]?.method : '';
              if (fixed.code && rewritten && banned.has(rewritten)) fixed.code = null;
              if (fixed.code && !seen.has(attemptKey(rewritten || 'script', callIdentity(fixed.code)[0]?.args ?? '', [claim]))) code = stripTypeSuppression(fixed.code);
              else strategy = fixed.strategy === 'raw' || fixed.strategy === 'reinspect' || fixed.strategy === 'minimal' ? 'minimal' : strategy;
            }
            if (!code) {
              const raw = await writeCode(executeCodePrompt({
                prompt,
                tool: codeTool,
                docs: shown.length ? shown : docs,
                metaNames: meta,
                lastError,
                observed,
                claim,
                minimal: strategy === 'minimal',
                excluded: [...banned],
              }));
              code = stripTypeSuppression(stripCodeFence(raw));
              lastCorrection = strategy === 'minimal' ? 'appel minimal, retour brut' : 'nouvel appel ciblé';
            }
            const fact = callIdentity(code)[0];
            const method = fact?.method ?? '';
            const args = fact?.args ?? '';
            const known = method ? registry.find((item) => item.method === method) : undefined;
            const unfit = known ? methodFits(known, req) : null;
            if (method && (banned.has(method) || (unfit && !unfit.ok))) {
              banned.add(method);
              selectionLog += methodJournal({ method, args, scope: req.scope, expected: req.measures.concat(req.entities).join(', ') || claim, obtained: known?.fields.join(', ') || '', decision: `rejetée avant l’appel, ${unfit?.reason ?? 'méthode hors périmètre'}` }) + '\n';
              lastCode = '';
              lastError = `méthode ${method} exclue`;
              spent.set(claim, (spent.get(claim) ?? 0) + 1);
              continue;
            }
            const gate = admitExecute(code, shown.length ? shown : docs);
            if (!gate.ok) {
              lastError = gate.reason;
              lastCode = '';
              stagnant += 1;
              if (stagnant >= 2) strategy = 'stop';
              continue;
            }
            const key = attemptKey(method || 'script', args, [claim]);
            if (seen.has(key)) {
              strategy = strategy === 'rewrite' ? 'minimal' : 'stop';
              continue;
            }
            seen.add(key);
            lastCode = code;
            const extra = await runReads([{ tool: codeTool.id, args: { code, intent: claim.slice(0, 160) } }], call, admitCall);
            done = keepFootholds(done, extra);
            const fresh = extra.find((read) => read.raw != null);
            if (fresh?.raw != null) observed = observeShape(fresh.raw);
            const businessRows = extra.flatMap((read) => read.ok ? read.rows.filter((row) => !isDocumentationRow(row)) : []);
            const verdict = businessRows.length ? responseInScope(businessRows, req) : null;
            if (verdict) {
              selectionLog += methodJournal({
                method,
                args,
                scope: `${req.scope}/${req.grain}`,
                expected: req.measures.concat(req.entities).join(', ') || claim,
                obtained: verdict.obtained.join(', '),
                decision: verdict.ok ? 'acceptée' : `rejetée, ${verdict.reason}`,
              }) + '\n';
            }
            const dated = businessRows.some((row) => Object.keys(row).some((key) => /date|time|timestamp|jour/i.test(key)));
            const historyLeft = req.grain === 'serie' && registry.some((item) => item.scope === 'historique' && item.method !== method && !banned.has(item.method));
            if (verdict?.ok && historyLeft && !dated && method) {
              banned.add(method);
              selectionLog += methodJournal({ method, args, scope: `${req.scope}/${req.grain}`, expected: req.measures.concat(req.entities).join(', ') || claim, obtained: verdict.obtained.join(', '), decision: 'rejetée, granularité point alors qu’une série est documentée' }) + '\n';
              lastCode = '';
              lastError = 'granularité : série attendue';
              spent.set(claim, (spent.get(claim) ?? 0) + 1);
              continue;
            }
            if (verdict && !verdict.ok && method) {
              banned.add(method);
              lastCode = '';
              lastError = verdict.reason;
              spent.set(claim, (spent.get(claim) ?? 0) + 1);
              if (verdict.scopeMismatch) strategy = 'rewrite';
              continue;
            }
            owner = reviewSource(prompt, catalog, done);
            const next = progress();
            selectionLog += `progression : ${held} → ${next.held.length} exigences tenues\n`;
            if (extra.some((read) => read.diagnostic === 'auth' || read.diagnostic === 'quota')) {
              strategy = 'stop';
              lastCorrection = extra.find((read) => read.diagnostic)?.diagnostic ?? 'stop';
              break;
            }
            if (!owner.ok && next.held.length <= held) {
              if (method && verdict) banned.add(method);
              blocked.push(claim);
              spent.set(claim, (spent.get(claim) ?? 0) + 1);
              stagnant += 1;
              strategy = strategy === 'rewrite' ? 'minimal' : 'stop';
            } else {
              held = next.held.length;
              stagnant = 0;
            }
            if (owner.ok || stagnant >= 2) break;
            lastError = extra.map((read) => read.error).filter(Boolean).join('\n')
              || (verdict && !verdict.ok ? verdict.reason : '')
              || (extra.some((read) => read.ok && read.rows.length) ? 'lignes présentes mais hors intention' : 'réponse vide ou hors mesures');
          } catch (error) {
            lastError = (error as Error).message;
            if (correctAcquisition('', lastError).strategy === 'stop') strategy = 'stop';
          }
        }
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
    const { skip: skipShow } = mentionedServers(prompt, catalog);
    const visible = done.filter((read) => !skipShow.includes(serverOf(read.tool)) && !(/^demo/.test(serverOf(read.tool)) && skipShow.some((id) => /^demo/.test(id))));
    const offer = offerFromReads(prompt, visible.length ? visible : done.filter((read) => !/^demo/.test(serverOf(read.tool))), page);
    const missing = owner.ok ? 'aucune' : (owner.missing.filter((item) => item !== 'lecture métier').join(', ') || gap || 'lecture exploitable');
    const result = owner.ok && offer.canBuild ? 'exigences tenues' : gap || (offer.samples.length ? 'acquisitions réussies conservées, exigences encore ouvertes' : 'rien ne peut être généré');
    const text = [
      selectLine,
      offer.text.replace('Données manquantes : aucune.', `Données manquantes : ${missing}.`).replace('Données manquantes : lecture exploitable.', `Données manquantes : ${missing}.`).replace('Correction : aucune.', `Correction : ${lastCorrection}.`).replace('Résultat : lecture exploitable.', `Résultat : ${result}.`).replace('Résultat : rien ne peut être généré.', `Résultat : ${result}.`),
    ].filter(Boolean).join('\n\n');
    const focus = <T extends { rows: Array<Record<string, unknown>> }>(samples: T[]): T[] => {
      const needles = claimsFromPrompt(prompt).filter((claim) => claim.kind === 'entite' || claim.kind === 'filtre').map((claim) => claim.text);
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
    return offerFromReads(prompt, [{ tool: 'mcp', args: {}, ok: false, error: (error as Error).message, rows: [] }], page);
  }
}
