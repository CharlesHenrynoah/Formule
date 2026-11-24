/**
 * Un outil est choisi pour ce qu'il fait.
 * Un paramètre `code` ne prouve jamais, à lui seul, qu'il exécute un SDK de lecture.
 */
import { hitsInRows, type ValueHit } from './chain.ts';

export type Capability = 'DISCOVER' | 'SEARCH' | 'READ' | 'VALIDATE' | 'SDK_EXECUTE' | 'WRITE' | 'TRIGGER';

export type ToolShape = {
  id: string;
  name: string;
  description?: string;
  write?: boolean;
  inputSchema?: { required?: string[]; properties?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
  outputSchema?: unknown;
};

export type ToolProfile = { id: string; capability: Capability; reasons: string[] };

export type SearchGap = 'correspondance' | 'absence' | 'incomplet' | 'pagination' | 'erreur';

const RETRIEVAL = new Set<Capability>(['DISCOVER', 'SEARCH', 'READ']);

function textOf(tool: ToolShape): string {
  const title = tool.annotations?.title ?? '';
  return `${tool.name} ${title} ${tool.description ?? ''}`.toLowerCase();
}

function hasCodeParam(tool: ToolShape): boolean {
  return Object.keys(tool.inputSchema?.properties ?? {}).some((key) => /^(code|script|source)$/i.test(key));
}

/** Capacité déduite du nom, de la description, du schéma et des annotations. Jamais d'un fournisseur. */
export function profileTool(tool: ToolShape): ToolProfile {
  const text = textOf(tool);
  const name = tool.name.toLowerCase();
  const description = (tool.description ?? '').trim().toLowerCase();
  const reasons: string[] = [];
  const code = hasCodeParam(tool);
  if (code) reasons.push('paramètre code présent, preuve insuffisante');
  if (/\b(validat\w*|lint\w*|typecheck\w*|dry[-_ ]?run)\b/.test(name) || /^(validat\w*|lint\w*|typecheck\w*|dry[-_ ]?run)\b/.test(description)) {
    reasons.unshift('le nom ou la description décrit une validation');
    return { id: tool.id, capability: 'VALIDATE', reasons };
  }
  if (/\b(trigger\w*|dispatch\w*|execute_workflow|run_workflow|start_run)\b/.test(text) || /\bdéclench|\bdeclench/.test(text)) {
    reasons.unshift('le nom ou la description décrit un déclenchement');
    return { id: tool.id, capability: 'TRIGGER', reasons };
  }
  if (tool.write || tool.annotations?.destructiveHint || /^(create|update|delete|remove|archive|publish|unpublish|mutate|send|set|add|insert|patch|put|post)_/.test(tool.name)) {
    reasons.unshift(tool.write ? 'permission d’écriture' : 'le nom décrit une mutation');
    return { id: tool.id, capability: 'WRITE', reasons };
  }
  const sdkName = /^(execute|run_code|eval_code|sdk_execute)$/.test(tool.name);
  const sdkText = /runs? [\s\S]{0,80}(javascript|typescript)[\s\S]{0,80}(api|sdk)/i.test(tool.description ?? '');
  if (code && (sdkName || sdkText) && !/validat|create_|update_/.test(tool.name)) {
    reasons.unshift(sdkName ? 'le nom désigne un exécuteur de code' : 'la description dit que le code interroge une API');
    return { id: tool.id, capability: 'SDK_EXECUTE', reasons };
  }
  if (/search_docs|list_docs|read_docs|get_docs|list_tools|sdk_reference|describe_/.test(tool.name)) {
    reasons.unshift('le nom décrit une découverte de documentation');
    return { id: tool.id, capability: 'DISCOVER', reasons };
  }
  if (/^(search|find|query)_/.test(tool.name)) {
    reasons.unshift('le nom décrit une recherche');
    return { id: tool.id, capability: 'SEARCH', reasons };
  }
  if (/^(list|get|read|fetch|show)_/.test(tool.name) || tool.annotations?.readOnlyHint === true) {
    reasons.unshift(tool.annotations?.readOnlyHint ? 'annotation lecture seule' : 'le nom décrit une lecture');
    return { id: tool.id, capability: 'READ', reasons };
  }
  reasons.unshift('aucune capacité explicite, lecture par défaut');
  return { id: tool.id, capability: 'READ', reasons };
}

export function isRetrieval(profile: ToolProfile): boolean {
  return RETRIEVAL.has(profile.capability);
}

const PAGE_KEYS = ['cursor', 'page', 'after', 'nextcursor', 'offset'];
const FILTER_KEYS = ['query', 'q', 'search', 'name', 'filter', 'nom'];

/** Une recherche vide n'est pas une raison d'écrire du code. */
export function classifySearch(input: {
  ok: boolean;
  rows: Array<Record<string, unknown>>;
  args: Record<string, unknown>;
  properties?: Record<string, unknown>;
  needle: string;
}): { gap: SearchGap; hits: ValueHit[] } {
  if (!input.ok) return { gap: 'erreur', hits: [] };
  const hits = hitsInRows(input.rows, [input.needle]);
  if (hits.length) return { gap: 'correspondance', hits };
  const props = input.properties ?? {};
  const hasPage = Object.keys(props).some((key) => PAGE_KEYS.includes(key.toLowerCase()));
  const usedPage = Object.entries(input.args).some(([key, value]) => PAGE_KEYS.includes(key.toLowerCase()) && value != null && value !== '' && value !== 1 && value !== '1');
  if (hasPage && !usedPage && input.rows.length > 0) return { gap: 'pagination', hits: [] };
  const limit = Number(input.args.limit ?? input.args.perPage ?? input.args.per_page);
  if (Number.isFinite(limit) && limit > 0 && input.rows.length >= limit) return { gap: 'incomplet', hits: [] };
  const sent = Object.entries(input.args).some(([key, value]) => FILTER_KEYS.includes(key.toLowerCase()) && String(value).toLowerCase().includes(input.needle.toLowerCase()));
  if (!sent) return { gap: 'incomplet', hits: [] };
  return { gap: 'absence', hits: [] };
}
