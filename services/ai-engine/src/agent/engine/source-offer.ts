/**
 * Étape de sourcing, avant tout développement.
 * L’agent Sélecteur choisit le MCP ; le déterministe ne sert qu’en repli.
 * Le dépôt et les garde-fous (keepNamedServer, Product Owner) restent déterministes.
 */
import { keepNamedServer, mentionedServers, readsForCollections, readsForUnmatched, type SourceTool } from '../../app-agents/ingest.ts';
import {
  correctAcquisition,
  ensureRunClient,
  executeCodePrompt,
  findCodeTool,
  findDocsTool,
  mcpMetaNames,
  observeShape,
  planAcquisitions,
  sdkHintsFromDocs,
  stripCodeFence,
  stripTypeSuppression,
  type DiagnosticClass,
} from './execute-code.ts';
import { reviewSource } from './product-owner.ts';
import { readsFromSelector, selectorPrompt } from './select-mcp.ts';
import { routeDemand } from './pose.ts';
import { splitAcquisition } from '../../discovery/acquire.ts';
import { withinBudget } from '../../runtime/resilience.ts';
import { alignPairSeries, keepSpan } from './series.ts';

export type SourceRead = { tool: string; args: Record<string, unknown>; ok: boolean; error?: string; rows: Array<Record<string, unknown>>; raw?: unknown; diagnostic?: DiagnosticClass };
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
  return null;
}

function rowsOf(data: unknown): Array<Record<string, unknown>> {
  const chart = chartRows(data);
  if (chart) return chart;
  if (typeof data === 'string' && data.trim()) {
    const lines = data.split('\n').map((line) => line.replace(/^\s*[-*]\s*/, '').replace(/^\d+(?:\.\d+)*\s+/, '').trim()).filter((line) => line.length > 2 && line.length < 120 && !line.endsWith(':'));
    if (lines.length > 1) return keepSpan(lines, 80).map((titre) => ({ titre }));
    return [{ texte: data.trim().slice(0, 280) }];
  }
  if (Array.isArray(data)) return keepSpan(data.filter((row) => row && typeof row === 'object') as Array<Record<string, unknown>>, 240);
  if (data && typeof data === 'object') {
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(value) && value[0] && typeof value[0] === 'object') return keepSpan(value.filter((row) => row && typeof row === 'object') as Array<Record<string, unknown>>, 240);
    }
  }
  return [];
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
  const lines = !route.data
    ? ['Aucune collection à lire pour cette demande.']
    : reads.length
    ? reads.map((read) => {
      const where = [read.args.owner, read.args.repo].filter(Boolean).join('/') || String(Object.values(read.args).find((value) => typeof value === 'string' && value.length > 0 && value.length < 80 && !/function|=>|client\./.test(value)) ?? '');
      if (!read.ok) return `${read.tool}${where ? ` sur ${where}` : ''} a échoué : ${read.error ?? 'lecture impossible'}.`;
      return `${read.tool}${where ? ` sur ${where}` : ''} : ${read.rows.length} ligne${read.rows.length > 1 ? 's' : ''}. Champs : ${fieldsOf(read.rows[0])}.`;
    })
    : ['Aucune lecture ne correspond à cette demande.'];
  const ready = !route.data || reads.some((read) => read.ok && read.rows.length > 0);
  const element = `Ce qui peut être généré : ${route.kind} « ${route.title} ».`;
  const obtained = reads.filter((read) => read.ok && read.rows.length);
  const failed = reads.filter((read) => !read.ok);
  const summary = [
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
    ready ? element : 'Rien ne peut être généré tant qu’une lecture ne renvoie pas de lignes.',
  ].join('\n');
  const brief = [`Sourcing validé. ${element}`, ...lines, 'Respecte le rôle de chaque champ : une date reste une date, un libellé reste un libellé.'].join('\n');
  const samples = reads.filter((read) => read.ok && read.rows.length).slice(0, 3).map((read) => ({
    tool: read.tool,
    args: read.args,
    rows: splitAcquisition(read.rows).stored.map((row) => {
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
): Promise<SourceRead[]> {
  const done: SourceRead[] = [];
  for (const read of reads) {
    try {
      const result = await call(read.tool, read.args);
      const failed = failureText(result);
      if (failed) {
        done.push({ ...read, ok: false, error: failed, rows: [], raw: result, diagnostic: correctAcquisition('', failed).diagnostic });
        continue;
      }
      const rows = rowsOf(result);
      done.push({ ...read, ok: rows.length > 0, error: rows.length ? undefined : 'réponse vide', rows, raw: result });
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

    let done = await runReads(reads, call);
    let owner = reviewSource(prompt, catalog, done);
    let lastCorrection = 'aucune';

    // Une acquisition à la fois. Une erreur ne retire pas les appuis déjà validés.
    if (!owner.ok && writeCode) {
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
        const planned = planAcquisitions(prompt, docs);
        let lastError: string | undefined;
        let lastCode = '';
        let observed = '';
        let signature = '';
        let stagnant = 0;
        let strategy: 'rewrite' | 'minimal' | 'stop' = 'rewrite';
        const tried = new Set<string>();
        const prior = done.find((read) => read.tool === codeTool.id && read.error && typeof read.args.code === 'string');
        if (prior?.error && prior.raw != null) observed = observeShape(prior.raw);
        for (let attempt = 0; withinBudget(attempt, 3) && strategy !== 'stop'; attempt++) {
          const claim = owner.missing[0] ?? planned[Math.min(attempt, planned.length - 1)]?.claim ?? prompt.slice(0, 80);
          const hint = planned.find((item) => item.claim === claim)?.hint ?? planned[0]?.hint;
          try {
            let code = '';
            if (lastCode && lastError && strategy === 'rewrite') {
              const fixed = correctAcquisition(lastCode, lastError, observed);
              lastCorrection = fixed.strategy;
              if (fixed.strategy === 'stop') {
                strategy = 'stop';
                break;
              }
              if (fixed.strategy === 'once' && attempt > 0) {
                strategy = 'stop';
                break;
              }
              if (fixed.code && !tried.has(fixed.code)) code = ensureRunClient(fixed.code);
              else strategy = fixed.strategy === 'raw' || fixed.strategy === 'reinspect' || fixed.strategy === 'minimal' ? 'minimal' : strategy;
            }
            if (!code) {
              const raw = await writeCode(executeCodePrompt({
                prompt,
                tool: codeTool,
                docs: hint ? [hint] : docs,
                metaNames: meta,
                lastError,
                observed,
                claim,
                minimal: strategy === 'minimal',
              }));
              code = ensureRunClient(stripTypeSuppression(stripCodeFence(raw)));
              lastCorrection = strategy === 'minimal' ? 'appel minimal, retour brut' : 'nouvel appel ciblé';
            }
            if (code.length < 40 || tried.has(code)) {
              if (tried.has(code)) strategy = strategy === 'rewrite' ? 'minimal' : 'stop';
              continue;
            }
            tried.add(code);
            lastCode = code;
            const extra = await runReads([{ tool: codeTool.id, args: { code, intent: claim.slice(0, 160) } }], call);
            done = keepFootholds(done, extra);
            const fresh = extra.find((read) => read.raw != null);
            if (fresh?.raw != null) observed = observeShape(fresh.raw);
            owner = reviewSource(prompt, catalog, done);
            const mark = `${extra.map((read) => read.diagnostic ?? (read.ok ? 'ok' : 'vide')).join(',')}|${owner.missing.length}`;
            if (mark === signature) {
              stagnant += 1;
              strategy = strategy === 'rewrite' ? 'minimal' : 'stop';
            } else stagnant = 0;
            signature = mark;
            if (owner.ok || stagnant >= 2) break;
            lastError = extra.map((read) => read.error).filter(Boolean).join('\n')
              || (extra.some((read) => read.ok && read.rows.length) ? 'lignes présentes mais hors intention (souvent de la doc)' : 'réponse vide ou hors mesures');
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
    const missing = owner.ok ? 'aucune' : (owner.missing.join(', ') || 'lecture exploitable');
    const result = owner.ok && offer.canBuild ? 'exigences tenues' : offer.samples.length ? 'acquisitions réussies conservées, exigences encore ouvertes' : 'rien ne peut être généré';
    const text = [
      selectLine,
      offer.text.replace('Données manquantes : aucune.', `Données manquantes : ${missing}.`).replace('Données manquantes : lecture exploitable.', `Données manquantes : ${missing}.`).replace('Correction : aucune.', `Correction : ${lastCorrection}.`).replace('Résultat : lecture exploitable.', `Résultat : ${result}.`).replace('Résultat : rien ne peut être généré.', `Résultat : ${result}.`),
    ].filter(Boolean).join('\n\n');
    const log = [offer.log, owner.text, lastCorrection !== 'aucune' ? `correction ${lastCorrection}` : ''].filter(Boolean).join('\n\n');
    if (!owner.ok) {
      return { canBuild: false, text, brief: owner.brief, samples: offer.samples, log };
    }
    return {
      canBuild: offer.canBuild,
      text,
      brief: [selectLine, offer.brief, owner.brief].filter(Boolean).join('\n\n'),
      samples: owner.samples.length ? owner.samples : offer.samples,
      log,
    };
  } catch (error) {
    return offerFromReads(prompt, [{ tool: 'mcp', args: {}, ok: false, error: (error as Error).message, rows: [] }], page);
  }
}
