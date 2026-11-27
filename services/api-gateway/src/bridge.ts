import type { AppSpec } from '@formule/contracts';
import { splitToolKey } from '@formule/contracts';

export const APP_TOOLS = ['app__decrire', 'app__agreger', 'app__simuler', 'app__journal'] as const;

/** Liste blanche du pont : les requêtes déclarées dans la spec certifiée + les outils de l'app. */
export function bridgeWhitelist(spec: AppSpec): string[] {
  return [...new Set([...spec.queries.map((q) => `${q.serverId}__${q.tool}`), ...APP_TOOLS])];
}

export type BridgeDecision =
  | { ok: true; target: 'hub'; serverId: string; tool: string; paginate?: AppSpec['queries'][number]['paginate'] }
  | { ok: true; target: 'app'; tool: (typeof APP_TOOLS)[number] }
  | { ok: false; status: number; message: string };

export function decideBridge(spec: AppSpec, name: string, args: unknown): BridgeDecision {
  if (typeof name !== 'string' || !bridgeWhitelist(spec).includes(name)) return { ok: false, status: 403, message: `outil ${String(name).slice(0, 60)} hors liste blanche` };
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { ok: false, status: 400, message: 'arguments : objet attendu' };
  if (JSON.stringify(args).length > 20 * 1024) return { ok: false, status: 413, message: 'arguments > 20 Ko' };
  if ((APP_TOOLS as readonly string[]).includes(name)) return { ok: true, target: 'app', tool: name as (typeof APP_TOOLS)[number] };
  const k = splitToolKey(name)!;
  const q = spec.queries.find((x) => x.serverId === k.serverId && x.tool === k.tool);
  // les arguments doivent rester ceux de la requête déclarée
  if (q && JSON.stringify(args) !== JSON.stringify(q.args)) return { ok: false, status: 403, message: 'arguments différents de la requête déclarée' };
  return { ok: true, target: 'hub', serverId: k.serverId, tool: k.tool, paginate: q?.paginate };
}

/** CSP de l'app générée : aucun réseau, aucun cadre, scripts inline du bundle seulement. */
export const APP_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "img-src data: blob:", "font-src data:",
  "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'self'",
].join('; ');
