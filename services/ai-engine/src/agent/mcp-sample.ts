/**
 * Robustesse Data Engineer / sampling MCP :
 * - allège les arguments (évite « arguments trop volumineux » côté gateway) ;
 * - compacte les échantillons renvoyés au modèle (schéma + aperçu, pas de dump) ;
 * - propose des défauts de pagination depuis le schéma d'entrée.
 */

export const MCP_ARGS_SOFT = 8_000;
export const MCP_ARGS_HARD = 18_000;
export const MCP_SAMPLE_MAX = 6_000;

const PAGE_KEYS = /^(limit|per[_-]?page|page[_-]?size|pageSize|max[_-]?results?|count|take|top|n|size|first)$/i;
const PAGE_NUM = /^(page|offset|skip|cursor|after|before|since|from)$/i;
const ID_KEYS = /^(id|ids|owner|repo|repository|org|organization|user|username|login|city|ville|query|q|search|name|workflow[_-]?id|execution[_-]?id|node|path|uri|url)$/i;

export const isSizeError = (msg: string) =>
  /volumineux|too large|payload|413|entity too large|request entity|max.?size|tronqu/i.test(msg);

/** Erreur MCP soft (isError ou texte « failed to… ») — à ne pas traiter comme échantillon valide. */
export const isMcpDataError = (data: unknown, isError?: boolean): string | null => {
  if (isError) return typeof data === 'string' ? data : 'erreur outil MCP';
  if (typeof data === 'string' && /failed to |Validation Failed|cannot be searched|rate limit exceeded|API rate|403 Forbidden|422\b/i.test(data)) return data;
  return null;
};

/** Plafonne pagination pour éviter perPage:100 systématique. */
export function capPagination(args: Record<string, unknown>, max = 20) {
  const out = { ...args };
  for (const [k, v] of Object.entries(out)) {
    if (PAGE_KEYS.test(k) && typeof v === 'number' && v > max) out[k] = max;
  }
  return out;
}

/** Taille JSON sûre (jamais throw). */
export const jsonSize = (v: unknown) => {
  try { return JSON.stringify(v ?? {}).length; } catch { return Number.MAX_SAFE_INTEGER; }
};

/** Défauts de pagination / bornes lus dans le inputSchema MCP (échantillon léger). */
export function defaultsFromSchema(schema: unknown): Record<string, unknown> {
  const props = (schema as { properties?: Record<string, { type?: string; default?: unknown; enum?: unknown[] }> })?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(props)) {
    if (p?.default !== undefined) { out[k] = p.default; continue; }
    if (PAGE_KEYS.test(k)) { out[k] = 5; continue; }
    if (PAGE_NUM.test(k) && (p?.type === 'integer' || p?.type === 'number')) { out[k] = 1; continue; }
    if (Array.isArray(p?.enum) && p.enum.length) out[k] = p.enum[0];
  }
  return out;
}

/** Compacte un schéma d'outil pour mcp_list_tools (évite de noyer le modèle). */
export function compactToolSchema(schema: unknown, max = 1200): unknown {
  if (!schema || typeof schema !== 'object') return {};
  const s = jsonSize(schema);
  if (s <= max) return schema;
  const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
  const slim: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props).slice(0, 24)) {
    const p = v as { type?: string; description?: string; enum?: unknown[] };
    slim[k] = {
      type: p?.type ?? 'unknown',
      ...(p?.enum ? { enum: p.enum.slice(0, 8) } : {}),
      ...(typeof p?.description === 'string' ? { description: p.description.slice(0, 80) } : {}),
    };
  }
  return { type: 'object', properties: slim, truncated: true, keys: Object.keys(props).length };
}

/**
 * Allège les arguments MCP : priorise ids / pagination, tronque chaînes et tableaux.
 * Si encore trop gros → objet minimal (pagination seule ou {}).
 */
export function slimArgs(args: unknown, max = MCP_ARGS_HARD): { args: Record<string, unknown>; trimmed: boolean; bytes: number } {
  const base = (args && typeof args === 'object' && !Array.isArray(args)) ? { ...(args as Record<string, unknown>) } : {};
  let trimmed = false;

  const shrink = (v: unknown, depth: number): unknown => {
    if (v == null) return v;
    if (typeof v === 'string') {
      if (v.length > 400) { trimmed = true; return v.slice(0, 400) + '…'; }
      return v;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) {
      const n = depth > 1 ? 3 : 8;
      if (v.length > n) trimmed = true;
      return v.slice(0, n).map((x) => shrink(x, depth + 1));
    }
    if (typeof v === 'object') {
      const o: Record<string, unknown> = {};
      const entries = Object.entries(v as object);
      const cap = depth > 1 ? 12 : 40;
      for (const [k, val] of entries.slice(0, cap)) o[k] = shrink(val, depth + 1);
      if (entries.length > cap) trimmed = true;
      return o;
    }
    trimmed = true;
    return String(v).slice(0, 80);
  };

  let out = shrink(base, 0) as Record<string, unknown>;
  if (jsonSize(out) > max) {
    trimmed = true;
    const keep: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out)) {
      if (ID_KEYS.test(k) || PAGE_KEYS.test(k) || PAGE_NUM.test(k)) keep[k] = typeof v === 'string' ? v.slice(0, 200) : v;
    }
    out = keep;
  }
  if (jsonSize(out) > max) {
    trimmed = true;
    out = {};
  }
  return { args: out, trimmed, bytes: jsonSize(out) };
}

/** Fusionne défauts schéma + args agent, puis allège + plafonne la pagination. */
export function prepareCallArgs(raw: unknown, schema?: unknown, max = MCP_ARGS_HARD) {
  const defaults = defaultsFromSchema(schema);
  const user = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
  // L'agent gagne sur les défauts, sauf champs de pagination absents → on complète pour rester léger.
  const merged: Record<string, unknown> = { ...defaults, ...user };
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in user) && PAGE_KEYS.test(k)) merged[k] = v;
  }
  return slimArgs(capPagination(merged, 20), max);
}

/** Échantillon compact pour le brief : schéma + aperçu borné (pas le dump brut). */
export function compactSample(data: unknown, max = MCP_SAMPLE_MAX): { echantillon: unknown; bytes: number; truncated: boolean } {
  const shrink = (v: unknown, depth: number): unknown => {
    if (v == null) return v;
    if (typeof v === 'string') return v.length > 240 ? v.slice(0, 240) + '…' : v;
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v)) {
      const n = depth === 0 ? 5 : 3;
      const head = v.slice(0, n).map((x) => shrink(x, depth + 1));
      return v.length > n ? [...head, { _plus: v.length - n }] : head;
    }
    if (typeof v === 'object') {
      const o: Record<string, unknown> = {};
      const entries = Object.entries(v as object);
      for (const [k, val] of entries.slice(0, depth === 0 ? 30 : 12)) o[k] = shrink(val, depth + 1);
      if (entries.length > (depth === 0 ? 30 : 12)) o._champs_omises = entries.length - (depth === 0 ? 30 : 12);
      return o;
    }
    return String(v).slice(0, 80);
  };

  let echantillon = shrink(data, 0);
  let truncated = jsonSize(data) > jsonSize(echantillon);
  if (jsonSize(echantillon) > max) {
    truncated = true;
    const s = typeof echantillon === 'string' ? echantillon : JSON.stringify(echantillon);
    echantillon = { _apercu: s.slice(0, max - 40) + '…', _note: 'échantillon tronqué pour le brief' };
  }
  return { echantillon, bytes: jsonSize(echantillon), truncated };
}
