export class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json?.code ?? 'error', json?.message ?? `Erreur ${res.status}`);
  return json as T;
}

export interface Project { id: string; title: string; created_at: string; updated_at: string; archived: number; active_version: number | null; latest_version: number; version_count: number; demo: number }
export interface VersionMeta { n: number; status: string; created_at: string; was_certified: boolean; certification: { certified: boolean; message: string; label: string; outcome: string; gates: { gate: string; passed: boolean; details: string[] }[] } | null; job_id?: string }
export interface Message { id: string; role: 'user' | 'agent'; content: Record<string, any>; created_at: string }
export interface JobEvent { eventId: string; jobId: string; seq: number; type: string; timestamp: string; payload: Record<string, any> }
export interface ServerInfo { id: string; name: string; transport: string; url?: string; enabled: boolean; demo: boolean; hasToken: boolean; tokenMask?: string; status?: string; error?: string; tools: Record<string, string> }
export interface CatalogServer { serverId: string; name: string; demo: boolean; status: string; error?: { kind: string; message: string }; tools: { name: string; description: string; permission: string; hint: string }[]; resources: { uri: string; name: string }[] }
export interface ActionCard { opId: string; label: string; effect: string; server: string; tool: string; args: Record<string, unknown>; demo: boolean; status: 'pending' | 'running' | 'done' | 'declined' | 'error' }
