export type Issue = { code: string; message: string; line?: number };
export type Validation = { ok: boolean; errors: Issue[]; warnings: Issue[]; fixed?: boolean };
export type Version = {
  id: string; number: number; prompt: string; kind: 'generate' | 'iterate' | 'edit'; plan: string | null;
  code: string; provider: string | null; model: string | null; validation: Validation | null; created_at: string;
  files?: Record<string, string> | null; app?: AppMeta | null; agent?: { framework?: string; brief?: string; components?: string[]; iterations?: number; ms?: number; trace?: AgentEvent[] } | null;
};
export type ProjectSummary = { id: string; title: string; updated_at: string; version_count: number; first_prompt: string };
export type Project = { id: string; title: string; versions: Version[] };
export type EngineConfig = { provider: string; model: string; requested: string; fallback: string | null; supportsDiffusion: boolean; status: string; agent?: AgentInfo };
export type McpTool = { id: string; name: string; description?: string; write: boolean; allowed: boolean; server: string; inputSchema?: unknown };
export type McpServer = {
  id: string; name?: string; transport: 'stdio' | 'http' | 'sse'; command?: string; args?: string[]; url?: string;
  enabled: boolean; status: string; error?: string; allowedTools?: string[] | '*'; writeTools?: string[];
  tools: McpTool[];
  /** Métadonnées d'authentification (jamais la valeur du jeton). */
  auth?: McpAuth;
};
export type PhaseKey = 'tools' | 'plan' | 'code' | 'fix' | 'validate' | 'save';
export type PhaseState = { phase: PhaseKey; label: string; status: 'running' | 'done' | 'error' };
export type ToolEvent = { id: string; name: string; args: unknown; result?: unknown; error?: string; ms?: number; source: 'génération' | 'exécution'; status: 'en cours' | 'ok' | 'erreur' | 'refusé' };

export type AgentRole = 'data' | 'po' | 'dev';
export type AgentEvent = { type: 'agent'; kind: string; role?: AgentRole; [k: string]: any };
export type AgentInfo = { available: boolean; kind: 'llm' | 'scripted' | 'unavailable'; framework: string | null; roles: string[]; defaultMode: 'agent' | 'direct' };

export type ContractTool = { name: string; description: string; input: Record<string, any>; write: boolean; safe: boolean };
export type AppAgentDef = { name: string; title: string; instructions: string; tools: string[]; externalTools: string[]; guardrails: string[]; capabilities: string[]; confirm: string[]; framework: string };
export type AppMeta = { contract: { tools: ContractTool[]; charts: string[]; entities: unknown[]; agent: { name: string; capabilities: string[] }; externalTools: string[] }; agent: AppAgentDef; backend: string; backendOk?: boolean; title?: string };
export type AppTool = { id: string; name: string; description?: string; inputSchema?: { properties?: Record<string, any>; required?: string[] }; write: boolean; safe: boolean; server: string };
export type AppInfo = { appId: string; version: number; connId: string; status: string; tools: AppTool[]; agent: AppAgentDef; runtime: string };
export type AppLogEntry = { at: string; source: 'agent' | 'ui' | 'studio'; tool: string; args: unknown; ok: boolean; ms?: number; result?: string; error?: string; confirmed?: boolean };
export type AppMemory = { requests: Array<{ at: string; version: number; prompt: string }>; facts: Array<{ at: string; text: string; source: string }> };
export type Dataset = { name: string; rows: Array<Record<string, unknown>>; file: string };

export type McpAuth = { bearer: boolean; tokenHint?: string; headerNames: string[]; source: 'fichier' | 'env' | 'aucun' };
