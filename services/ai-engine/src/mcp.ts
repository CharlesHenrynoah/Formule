/** Client vers le mcp-hub. La reprise vit dans le hub : ici on conserve le diagnostic. */
import { randomUUID } from 'node:crypto';
import type { RuntimeTool } from './types.ts';
import { classifyLink, delayMs, scrub } from '../../mcp-hub/src/link-state.ts';

export type McpClient = {
  listTools(): Promise<RuntimeTool[]>;
  call(tool: string, args: unknown, opts?: { timeoutMs?: number }): Promise<{ data: unknown; isError?: boolean; ms?: number; resolvedTool?: string; correlationId?: string }>;
};

export function mcpFailure(error: unknown): Error {
  const message = scrub(error instanceof Error ? error.message : String(error ?? ''));
  const code = typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : undefined;
  const { obstacle } = classifyLink(message, code);
  return Object.assign(error instanceof Error ? error : new Error(message), { message, obstacle });
}

export function httpMcpClient(baseUrl = process.env.MCP_HUB_URL ?? 'http://localhost:4004'): McpClient {
  return {
    async listTools() {
      let last: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(`${baseUrl}/tools?allowedOnly=1`, { signal: AbortSignal.timeout(10_000) });
          if (!r.ok) throw new Error(`mcp-hub ${r.status}`);
          const body = await r.json();
          return Array.isArray(body) ? body as RuntimeTool[] : [];
        } catch (error) {
          last = error;
          const kind = classifyLink(error instanceof Error ? error.message : String(error));
          if (!kind.recoverable || attempt === 2) break;
          await new Promise((resolve) => setTimeout(resolve, delayMs(attempt)));
        }
      }
      throw mcpFailure(last);
    },
    async call(tool, args, opts) {
      // Le hub rejoue les lectures. Un POST n'est pas relancé ici : une écriture au résultat incertain ne part pas deux fois.
      const timeoutMs = Math.min(120_000, Math.max(1_000, opts?.timeoutMs ?? 20_000));
      const correlationId = randomUUID();
      const r = await fetch(`${baseUrl}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-formule-correlation': correlationId },
        body: JSON.stringify({ tool, args, timeoutMs }),
        signal: AbortSignal.timeout(timeoutMs + 2_000),
      });
      const j = (await r.json()) as { data?: unknown; isError?: boolean; ms?: number; error?: string; resolvedTool?: string; correlationId?: string; obstacle?: string };
      if (!r.ok) throw Object.assign(mcpFailure(new Error(j.error ?? `mcp-hub ${r.status}`)), { correlationId: j.correlationId ?? correlationId, obstacle: j.obstacle });
      if (j.isError) throw Object.assign(mcpFailure(new Error(typeof j.data === 'string' ? j.data : (j.error ?? `erreur MCP : ${tool}`))), { correlationId: j.correlationId ?? correlationId, obstacle: j.obstacle });
      return { data: j.data, isError: false, ms: j.ms, resolvedTool: j.resolvedTool, correlationId: j.correlationId ?? correlationId };
    },
  };
}
