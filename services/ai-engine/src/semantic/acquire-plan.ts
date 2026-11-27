import { canonicalJson } from '@formule/contracts';
import { packReads, rankTools, resolveArgs, type CatalogServer, type ToolRef } from '../discovery/catalog.js';
import { norm, type ReqTemplate } from './lexicon.js';
import type { AcquisitionGroup } from './hybrid.js';

export interface PlannedAcquisition { ref: ToolRef; args: Record<string, unknown>; forReqIds: string[] }
export const acquisitionKey = (ref: ToolRef, args: Record<string, unknown>) => `${ref.serverId}__${ref.tool.name}__${canonicalJson(args)}`;

export type AcquisitionHints = {
  toolHints?: Map<string, string[]>;
  argHints?: Map<string, Record<string, unknown>>;
  /** Groupes IA : mutualisation + décomposition multi-entités. */
  groups?: AcquisitionGroup[];
};

const isDocs = (name: string) => /search_docs|documentation|readme|^docs?$/i.test(name);

/**
 * Planifie les lectures MCP.
 * Les groupes IA priorisent mutualisation et décomposition ; permissions / schéma / quotas restent déterministes.
 * Les outils documentaires sont exclus sauf si le groupe l'autorise explicitement.
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
  const covered = new Set<string>();

  const add = (ref: ToolRef, args: Record<string, unknown>, reqIds: string[]) => {
    const key = acquisitionKey(ref, args);
    if (excluded.has(key)) return false;
    const existing = planned.find((p) => acquisitionKey(p.ref, p.args) === key);
    if (existing) {
      for (const id of reqIds) if (!existing.forReqIds.includes(id)) existing.forReqIds.push(id);
      for (const id of reqIds) covered.add(id);
      return true;
    }
    if (seen.has(key)) {
      for (const id of reqIds) covered.add(id);
      return true;
    }
    seen.add(key);
    planned.push({ ref, args, forReqIds: [...reqIds] });
    for (const id of reqIds) covered.add(id);
    return true;
  };

  const tryResolve = async (ref: ToolRef, local: string, seed: Record<string, unknown>) => {
    const props = ref.tool.inputSchema?.properties ?? {};
    const { args: resolved, missing } = Object.keys(props).length
      ? await resolveArgs(ref, local || prompt, catalog)
      : { args: {} as Record<string, unknown>, missing: [] as string[] };
    const args = { ...resolved };
    for (const [k, v] of Object.entries(seed)) {
      if (k in props && (args[k] === undefined || seed[k] !== undefined && typeof seed[k] !== 'undefined')) {
        // Hints IA remplissent les manques ; n'écrasent pas une valeur déjà résolue sauf si manquante.
        if (args[k] === undefined) args[k] = v;
      }
    }
    const stillMissing = (ref.tool.inputSchema?.required ?? []).filter((r) => args[r] === undefined);
    return { args, missing: stillMissing.length ? stillMissing : missing };
  };

  // 1) Groupes d'acquisition IA (mutualisés / multi-entités).
  for (const g of hints.groups ?? []) {
    const reqIds = g.forRequirementIds.filter((id) => reqs.some((r) => r.id === id && r.view !== 'note'));
    if (!reqIds.length) continue;
    const sample = reqs.find((r) => r.id === reqIds[0])!;
    const local = [g.purpose, g.entity, sample.label, sample.population, sample.period, global].filter(Boolean).join('\n');
    const hintNames = (g.toolHints ?? []).map(norm);
    const allowDocs = g.dataNotDocs === false;
    const hinted = hintNames.length
      ? catalog.flatMap((s) => s.tools
        .filter((t) => t.permission === 'read' && hintNames.some((h) => norm(t.name) === h || norm(t.name).includes(h) || h.includes(norm(t.name))))
        .filter((t) => allowDocs || !isDocs(t.name))
        .map((tool) => ({ serverId: s.serverId, serverName: s.name, demo: s.demo, tool })))
      : [];
    const ranked = [
      ...hinted,
      ...rankTools(catalog, local || prompt, fileIds).filter((r) => allowDocs || !isDocs(r.tool.name)),
      ...packed.filter((r) => allowDocs || !isDocs(r.tool.name)),
    ];
    const seed = { ...(g.argHints ?? {}) };
    if (g.entity) {
      for (const [k, v] of Object.entries(seed)) {
        if (typeof v === 'string') seed[k] = v.replace(/\$entity|\{entity\}/gi, g.entity);
      }
    }
    let ok = false;
    const tried = new Set<string>();
    for (const ref of ranked) {
      const id = `${ref.serverId}__${ref.tool.name}`;
      if (tried.has(id) || ref.tool.permission !== 'read') continue;
      tried.add(id);
      const { args, missing } = await tryResolve(ref, local, seed);
      if (missing.length) {
        if (unresolved.length < 6) unresolved.push(`${g.id} · ${ref.serverName} · ${ref.tool.name} : ${missing.join(', ')}`);
        continue;
      }
      if (add(ref, args, reqIds)) { ok = true; break; }
    }
    if (!ok && unresolved.length < 8) unresolved.push(`${g.id} : aucune lecture compatible pour le groupe`);
  }

  // 2) Exigences non couvertes par un groupe.
  for (const req of reqs) {
    if (req.view === 'note' || covered.has(req.id)) continue;
    const text = [req.label, req.population, req.period, ...(req.entities ?? []), ...(req.measures ?? req.measure ?? [])].filter(Boolean).join(' ');
    const scopeText = (req.operation ?? req.agg) === 'ratio' && req.scopeSize != null
      ? (req.entities ?? []).reduce((str, e) => str.replaceAll(e, '').replaceAll(e.toLowerCase(), ''), text)
      : text;
    const local = [scopeText, req.scopeSize != null ? 'top ' + req.scopeSize : undefined, req.period, req.measureWindow, req.inputUnit ?? (req.unit === '%' ? undefined : req.unit), global].filter(Boolean).join('\n');

    // Décomposition multi-entités si plusieurs entités et pas encore de groupe.
    const entities = req.entities?.length && req.entities.length > 1 ? req.entities : [undefined];
    let anyOk = false;
    for (const entity of entities) {
      const hintNames = (hints.toolHints?.get(req.id) ?? req.tool.filter((t) => t !== '*')).map(norm);
      const hinted = hintNames.length
        ? catalog.flatMap((s) => s.tools.filter((t) => t.permission === 'read' && !isDocs(t.name) && hintNames.some((h) => norm(t.name) === h || norm(t.name).includes(h) || h.includes(norm(t.name)))).map((tool) => ({ serverId: s.serverId, serverName: s.name, demo: s.demo, tool })))
        : [];
      const ranked = [
        ...hinted,
        ...rankTools(catalog, [local, entity].filter(Boolean).join('\n') || prompt, fileIds).filter((r) => !isDocs(r.tool.name)),
        ...packed.filter((r) => !isDocs(r.tool.name)),
        ...rankTools(catalog, prompt, fileIds).filter((r) => !isDocs(r.tool.name)),
        ...rankTools(catalog, local || prompt, fileIds).filter((r) => isDocs(r.tool.name)),
      ];
      const seed = { ...(hints.argHints?.get(req.id) ?? {}) };
      if (entity) {
        const hasId = Object.keys(seed).some((k) => /id|coin|symbol|asset|slug|name/i.test(k));
        if (!hasId) seed.id = entity;
      }
      const tried = new Set<string>();
      let ok = false;
      for (const ref of ranked) {
        const id = `${ref.serverId}__${ref.tool.name}`;
        if (tried.has(id) || ref.tool.permission !== 'read') continue;
        tried.add(id);
        const { args, missing } = await tryResolve(ref, [local, entity].filter(Boolean).join('\n'), seed);
        if (missing.length) {
          if (unresolved.length < 6) unresolved.push(`${req.id} · ${ref.serverName} · ${ref.tool.name} : ${missing.join(', ')}`);
          continue;
        }
        if (!add(ref, args, [req.id])) continue;
        ok = true;
        anyOk = true;
        break;
      }
      if (!ok && entities.length === 1 && unresolved.length < 8) unresolved.push(`${req.id} : aucune lecture autorisée compatible`);
    }
    if (!anyOk && entities.length > 1 && unresolved.length < 8) unresolved.push(`${req.id} : décomposition multi-entités sans lecture compatible`);
  }

  if (!planned.length && !excluded.size) {
    for (const ref of (packed.length ? packed : rankTools(catalog, prompt, fileIds)).slice(0, 2)) {
      if (ref.tool.permission !== 'read' || isDocs(ref.tool.name)) continue;
      const { args, missing } = Object.keys(ref.tool.inputSchema?.properties ?? {}).length
        ? await resolveArgs(ref, prompt, catalog)
        : { args: {}, missing: [] as string[] };
      if (missing.length) continue;
      add(ref, args, ['*']);
    }
  }

  return { planned, unresolved };
}
