import { canonicalJson } from '@formule/contracts';
import { packReads, rankTools, resolveArgs, type CatalogServer, type ToolRef } from '../discovery/catalog.js';
import { norm, type ReqTemplate } from './lexicon.js';

export interface PlannedAcquisition { ref: ToolRef; args: Record<string, unknown>; forReqIds: string[] }
export const acquisitionKey = (ref: ToolRef, args: Record<string, unknown>) => `${ref.serverId}__${ref.tool.name}__${canonicalJson(args)}`;

export type AcquisitionHints = {
  toolHints?: Map<string, string[]>;
  argHints?: Map<string, Record<string, unknown>>;
};

/**
 * Planifie les lectures MCP par exigence et combinaison d'arguments.
 * Les hints IA (outils / arguments) priorisent le classement ; permissions, schéma et quotas restent déterministes.
 */
export async function planAcquisitions(
  reqs: ReqTemplate[],
  catalog: CatalogServer[],
  prompt: string,
  fileIds: string[] = [],
  excluded: ReadonlySet<string> = new Set(),
  hints: AcquisitionHints = {},
): Promise<{ planned: PlannedAcquisition[]; unresolved: string[] }> {
  const preamble = prompt.split(/\n\s*(?:#{1,4}\s*)?(?:\*\*)?(?:\d{1,2}[.)]\s+|[-•*]\s+)/)[0].trim();
  const global = preamble.length < 500 && preamble !== prompt ? preamble : '';
  const packed = await packReads(catalog, global || prompt);
  const planned: PlannedAcquisition[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  const add = (ref: ToolRef, args: Record<string, unknown>, reqId: string) => {
    const key = acquisitionKey(ref, args);
    if (excluded.has(key)) return false;
    const existing = planned.find((p) => acquisitionKey(p.ref, p.args) === key);
    if (existing) { if (!existing.forReqIds.includes(reqId)) existing.forReqIds.push(reqId); return true; }
    if (seen.has(key)) return true;
    seen.add(key);
    planned.push({ ref, args, forReqIds: [reqId] });
    return true;
  };

  for (const req of reqs) {
    if (req.view === 'note') continue;
    const text = [req.label, req.population, req.period, ...(req.entities ?? []), ...(req.measures ?? req.measure ?? [])].filter(Boolean).join(' ');
    // Le numérateur d'un ratio n'est pas le périmètre de l'acquisition.
    const scopeText = (req.operation ?? req.agg) === 'ratio' && req.scopeSize != null
      ? (req.entities ?? []).reduce((str, e) => str.replaceAll(e, '').replaceAll(e.toLowerCase(), ''), text)
      : text;
    const local = [scopeText, req.scopeSize != null ? 'top ' + req.scopeSize : undefined, req.period, req.measureWindow, req.inputUnit ?? (req.unit === '%' ? undefined : req.unit), global].filter(Boolean).join('\n');
    const hintNames = (hints.toolHints?.get(req.id) ?? req.tool.filter((t) => t !== '*')).map(norm);
    const hinted = hintNames.length
      ? catalog.flatMap((s) => s.tools.filter((t) => t.permission === 'read' && hintNames.some((h) => norm(t.name) === h || norm(t.name).includes(h) || h.includes(norm(t.name)))).map((tool) => ({ serverId: s.serverId, serverName: s.name, demo: s.demo, tool })))
      : [];
    const isDocs = (name: string) => /search_docs|documentation|readme|^docs?$/i.test(name);
    const ranked = [
      ...hinted.filter((r) => !isDocs(r.tool.name)),
      ...rankTools(catalog, local || prompt, fileIds).filter((r) => !isDocs(r.tool.name)),
      ...packed.filter((r) => !isDocs(r.tool.name)),
      ...rankTools(catalog, prompt, fileIds).filter((r) => !isDocs(r.tool.name)),
      // Documentation en dernier recours uniquement.
      ...hinted.filter((r) => isDocs(r.tool.name)),
      ...rankTools(catalog, local || prompt, fileIds).filter((r) => isDocs(r.tool.name)),
    ];
    const tried = new Set<string>();
    let ok = false;
    const seedArgs = hints.argHints?.get(req.id) ?? {};
    for (const ref of ranked) {
      const id = `${ref.serverId}__${ref.tool.name}`;
      if (tried.has(id) || ref.tool.permission !== 'read') continue;
      tried.add(id);
      const props = ref.tool.inputSchema?.properties ?? {};
      const { args: resolved, missing } = Object.keys(props).length
        ? await resolveArgs(ref, local || prompt, catalog)
        : { args: {}, missing: [] as string[] };
      // Hints IA : uniquement les clés du schéma, jamais d'override hors schéma.
      const args = { ...resolved };
      for (const [k, v] of Object.entries(seedArgs)) {
        if (k in props && args[k] === undefined) args[k] = v;
      }
      const stillMissing = (ref.tool.inputSchema?.required ?? []).filter((r) => args[r] === undefined);
      if (stillMissing.length) {
        if (unresolved.length < 6) unresolved.push(`${req.id} · ${ref.serverName} · ${ref.tool.name} : ${(stillMissing.length ? stillMissing : missing).join(', ')}`);
        continue;
      }
      if (!add(ref, args, req.id)) continue;
      ok = true;
      break;
    }
    if (!ok && unresolved.length < 8) unresolved.push(`${req.id} : aucune lecture autorisée compatible`);
  }

  // Au moins une lecture générique si le contrat est vide d'acq réussie mais le prompt a des outils.
  if (!planned.length && !excluded.size) {
    for (const ref of (packed.length ? packed : rankTools(catalog, prompt, fileIds)).slice(0, 2)) {
      if (ref.tool.permission !== 'read') continue;
      const { args, missing } = Object.keys(ref.tool.inputSchema?.properties ?? {}).length
        ? await resolveArgs(ref, prompt, catalog)
        : { args: {}, missing: [] as string[] };
      if (missing.length) continue;
      add(ref, args, '*');
    }
  }

  return { planned, unresolved };
}
