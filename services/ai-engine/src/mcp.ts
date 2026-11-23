/** Client minimal vers le mcp-hub (liste et appel d'outils). */
import type { RuntimeTool } from './types.ts';

export type McpClient = {
  listTools(): Promise<RuntimeTool[]>;
  call(tool: string, args: unknown, opts?: { timeoutMs?: number }): Promise<{ data: unknown; isError?: boolean; ms?: number; resolvedTool?: string }>;
};

const TRANSIENT = /terminated|fetch failed|econnreset|econnrefused|socket hang up|network|und_err_|mcp-hub 5\d\d/i;

function liaisonError(error: unknown): Error {
  const msg = String((error as Error)?.message ?? error);
  if (TRANSIENT.test(msg)) return new Error('La liaison MCP a été coupée. Relance la lecture.');
  return error instanceof Error ? error : new Error(msg);
}

export function httpMcpClient(baseUrl = process.env.MCP_HUB_URL ?? 'http://localhost:4004'): McpClient {
  async function attempt<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (error) {
      if (!TRANSIENT.test(String((error as Error)?.message ?? error))) throw liaisonError(error);
      try { return await fn(); }
      catch (again) { throw liaisonError(again); }
    }
  }

  return {
    async listTools() {
      return attempt(async () => {
        const r = await fetch(`${baseUrl}/tools?allowedOnly=1`, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(`mcp-hub ${r.status}`);
        const body = await r.json();
        return Array.isArray(body) ? body as RuntimeTool[] : [];
      });
    },
    async call(tool, args, opts) {
      // Pendant la génération, seuls les outils en LECTURE sont proposés au modèle : jamais de `confirmed`.
      // L'interprète d'un tableau peut attendre jusqu'à 2 minutes : le hub applique timeoutMs.
      const timeoutMs = Math.min(120_000, Math.max(1_000, opts?.timeoutMs ?? 20_000));
      return attempt(async () => {
        const r = await fetch(`${baseUrl}/call`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool, args, timeoutMs }), signal: AbortSignal.timeout(timeoutMs + 2_000),
        });
        const j = (await r.json()) as { data?: unknown; isError?: boolean; ms?: number; error?: string; resolvedTool?: string };
        if (!r.ok) throw new Error(j.error ?? `mcp-hub ${r.status}`);
        if (j.isError) throw new Error(typeof j.data === 'string' ? j.data : (j.error ?? `erreur MCP : ${tool}`));
        return { data: j.data, isError: false, ms: j.ms, resolvedTool: j.resolvedTool };
      });
    },
  };
}
