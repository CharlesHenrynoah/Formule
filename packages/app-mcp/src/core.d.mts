export type FieldSpec = { type?: string; description?: string; enum?: unknown[]; optional?: boolean; items?: unknown } | string;
export type ToolKind = 'read' | 'simulate' | 'store' | 'action';
export type ContractTool = { name: string; description: string; kind: ToolKind; input: Record<string, FieldSpec>; write: boolean; safe: boolean; output?: unknown };
/** Console « mindset DJ » : decks (sources MCP), knobs (paramètres de simulation), pads (actions), crossfader, cadence. */
export type ConsoleCfg = {
  decks: Array<{ label: string; tool: string; args: Record<string, unknown> }>;
  knobs: Array<{ param: string; label: string; min: number; max: number; step: number; default: number }>;
  pads: Array<{ key: string; label: string; tool: string }>;
  crossfader: string; refreshSec: number;
};
export type Contract = {
  entities: unknown[]; tools: ContractTool[];
  agent: { name: string; persona: string; capabilities: string[]; guardrails: string[]; tools: string[] };
  charts: string[]; externalTools: string[]; console?: ConsoleCfg;
  /** Zone DASHBOARD : panneaux visuels + état pilotable par l'agent (set_dashboard). */
  dashboard?: { panels: Array<{ id: string; type: string; title: string; tools: string[] }>; state: Record<string, string> };
  /** Zone CHAT : ordres en langage naturel supportés. */
  chat?: { commands: Array<{ example: string; does: string }> };
};
export type AgentDef = { name: string; title: string; instructions: string; tools: string[]; externalTools: string[]; guardrails: string[]; capabilities: string[]; confirm: string[]; framework: string };
export type BackendTool = { name: string; description: string; kind?: ToolKind; write: boolean; safe: boolean; input: Record<string, FieldSpec>; inputSchema: { type: 'object'; properties: Record<string, any>; required: string[]; additionalProperties: false } };
export type Backend = { tools: BackendTool[]; call(name: string, args?: Record<string, unknown>): any; data(): Record<string, unknown> };
export type BackendTest = { ok: boolean; problems: string[]; tools: string[]; smoke: Array<{ tool: string; args: unknown; ok: boolean; write?: boolean; result?: string; data?: unknown; error?: string }>; defs?: Array<{ name: string; write: boolean; safe: boolean; kind?: string; description: string; input: Record<string, FieldSpec> }> };
export declare const KINDS: Set<ToolKind>;
export declare const MAX_DB_BYTES: number;
export declare const CALL_TIMEOUT_MS: number;
export declare function compileTools(tsSource: string): Promise<string>;
export declare function inputToJsonSchema(input?: Record<string, FieldSpec>): BackendTool['inputSchema'];
export declare function loadBackend(jsCode: string, initialData?: Record<string, unknown>, opts?: { timeoutMs?: number }): Backend;
export declare function testBackend(tsSource: string, contract: Partial<Contract> | null): Promise<BackendTest>;
export declare function parseContract(spec: string): Contract | null;
export declare function normalizeContract(c: unknown): Contract | null;
export declare function buildAgentDef(contract: Contract, opts?: { title?: string; spec?: string }): AgentDef;
export declare function frontToolsUsed(code: string): string[];
export declare function coherence(x: { contract: Contract; appCode: string; backendTools: string[] }): {
  front: { ok: boolean; used: string[]; unknown: string[] }; backend: { ok: boolean; missing: string[] }; agent: { ok: boolean; unknown: string[] }; usesAgent: boolean; usesChart: boolean; live: boolean; knobs: boolean; pads: boolean; shell: boolean;
};
