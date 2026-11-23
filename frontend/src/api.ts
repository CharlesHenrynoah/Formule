const j = async <T,>(r: Response): Promise<T> => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body?.error ?? `HTTP ${r.status}`), { status: r.status, body });
  return body as T;
};

export const api = {
  config: () => fetch('/api/config').then((r) => j<any>(r)),
  health: () => fetch('/health').then((r) => j<any>(r)),
  projects: () => fetch('/api/projects').then((r) => j<any[]>(r)),
  project: (id: string) => fetch(`/api/projects/${id}`).then((r) => j<any>(r)),
  deleteProject: (id: string) => fetch(`/api/projects/${id}`, { method: 'DELETE' }).then((r) => j<any>(r)),
  saveVersion: (id: string, code: string, prompt?: string) =>
    fetch(`/api/projects/${id}/versions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, prompt }) }).then((r) => j<any>(r)),
  mcpServers: () => fetch('/api/mcp/servers').then((r) => j<any[]>(r)),
  mcpTools: () => fetch('/api/mcp/tools').then((r) => j<any[]>(r)),
  mcpAdd: (cfg: unknown) => fetch('/api/mcp/servers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) }).then((r) => j<any>(r)),
  mcpPatch: (id: string, patch: unknown) => fetch(`/api/mcp/servers/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then((r) => j<any>(r)),
  mcpReconnect: (id: string) => fetch(`/api/mcp/servers/${id}/reconnect`, { method: 'POST' }).then((r) => j<any>(r)),
  mcpDelete: (id: string) => fetch(`/api/mcp/servers/${id}`, { method: 'DELETE' }).then((r) => j<any>(r)),
  mcpCall: (tool: string, args: unknown, confirmed: boolean) =>
    fetch('/api/mcp/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, args, confirmed }) }).then((r) => j<any>(r)),
  appEnsure: (id: string, version?: number) => fetch(`/api/apps/${id}/ensure`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }) }).then((r) => j<any>(r)),
  appCall: (id: string, body: { tool: string; args: unknown; version?: number; source: 'ui' | 'studio'; confirmed?: boolean }) =>
    fetch(`/api/apps/${id}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<any>(r)),
  appConfirm: (id: string, callId: string, ok: boolean) => fetch(`/api/apps/${id}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ callId, ok }) }).then((r) => j<any>(r)),
  /** Source n8n : exécution manuelle → attente → ingestion (pad « Rafraîchir »). */
  appRefresh: (id: string, body: { confirmed: boolean; workflowId?: string; triggerNodeName?: string; webhookData?: unknown; executionId?: string; version?: number }) =>
    fetch(`/api/apps/${id}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<any>(r)),
  appLog: (id: string) => fetch(`/api/apps/${id}/log`).then((r) => j<any[]>(r)),
  appMemory: (id: string) => fetch(`/api/apps/${id}/memory`).then((r) => j<any>(r)),
  appMemoryEdit: (id: string, body: { fact?: string; forget?: number }) => fetch(`/api/apps/${id}/memory`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<any>(r)),
  dashboards: (id: string) => fetch(`/api/projects/${id}/dashboards`).then((r) => j<any[]>(r)),
  interpret: (body: { tool: string; args: Record<string, unknown>; x: string; y: string }) =>
    fetch('/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => j<{ rows: Array<Record<string, string | number>>; ms: number | null }>(r)),
};

/** Lecture d'un flux SSE (POST). */
async function readSse(res: Response, onEvent: (e: any) => void) {
  if (!res.ok || !res.body) { const b = await res.json().catch(() => ({})); throw new Error((b as any)?.error ?? `HTTP ${res.status}`); }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split('\n')) if (line.startsWith('data:')) onEvent(JSON.parse(line.slice(5).trim()));
    }
  }
}

/** Question au sous-agent d'une app (SSE : delta, tool_call, tool_result, confirm, done, error). */
export async function streamAsk(appId: string, body: { message: string; history?: unknown[]; version?: number; context?: string; voice?: boolean; mode?: 'ask' | 'agent' }, onEvent: (e: any) => void, signal?: AbortSignal) {
  const res = await fetch(`/api/apps/${appId}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  await readSse(res, onEvent);
}

/** POST + lecture SSE (EventSource ne supporte pas POST). */
export async function streamDashboard(body: unknown, onEvent: (e: any) => void, signal: AbortSignal) {
  const res = await fetch('/api/dashboards/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  await readSse(res, onEvent);
}

const LIAISON = 'La liaison a été coupée pendant la construction. Relance la génération.';
const netDown = (e: unknown) => /failed to fetch|fetch failed|networkerror|load failed|network request failed/i.test(String((e as Error)?.message ?? e ?? ''));

async function readGenerate(body: unknown, onEvent: (e: any) => void, signal: AbortSignal) {
  const res = await fetch('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split('\n')) if (line.startsWith('data:')) onEvent(JSON.parse(line.slice(5).trim()));
    }
  }
}

export async function streamGenerate(body: unknown, onEvent: (e: any) => void, signal: AbortSignal) {
  let seen = false;
  const watch = (e: any) => { seen = true; onEvent(e); };
  try {
    await readGenerate(body, watch, signal);
  } catch (e) {
    if (signal.aborted || !netDown(e)) throw e;
    if (seen) throw new Error(LIAISON);
    await new Promise((r) => setTimeout(r, 1200));
    if (signal.aborted) throw e;
    try { await readGenerate(body, watch, signal); }
    catch (e2) { throw netDown(e2) ? new Error(LIAISON) : e2; }
  }
}
