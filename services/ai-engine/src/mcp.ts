/** Client minimal vers le mcp-hub (liste et appel d'outils). */
import type { RuntimeTool } from './types.ts';

export type McpClient = {
  listTools(): Promise<RuntimeTool[]>;
  call(tool: string, args: unknown, opts?: { timeoutMs?: number }): Promise<{ data: unknown; isError?: boolean; ms?: number; resolvedTool?: string }>;
};

export function httpMcpClient(baseUrl = process.env.MCP_HUB_URL ?? 'http://localhost:4004'): McpClient {
  return {
    async listTools() {
      try {
        const r = await fetch(`${baseUrl}/tools?allowedOnly=1`, { signal: AbortSignal.timeout(3000) });
        return r.ok ? ((await r.json()) as RuntimeTool[]) : [];
      } catch { return []; }
    },
    async call(tool, args, opts) {
      // Pendant la génération, seuls les outils en LECTURE sont proposés au modèle : jamais de `confirmed`.
      // L'interprète d'un tableau peut attendre jusqu'à 2 minutes : le hub applique timeoutMs.
      const timeoutMs = Math.min(120_000, Math.max(1_000, opts?.timeoutMs ?? 20_000));
      const r = await fetch(`${baseUrl}/call`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool, args, timeoutMs }), signal: AbortSignal.timeout(timeoutMs + 2_000),
      });
      const j = (await r.json()) as { data?: unknown; isError?: boolean; ms?: number; error?: string; resolvedTool?: string };
      if (!r.ok) throw new Error(j.error ?? `mcp-hub ${r.status}`);
      if (j.isError) throw new Error(typeof j.data === 'string' ? j.data : (j.error ?? `erreur MCP : ${tool}`));
      return { data: j.data, isError: false, ms: j.ms, resolvedTool: j.resolvedTool };
    },
  };
}
