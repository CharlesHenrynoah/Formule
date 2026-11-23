export type Role = 'system' | 'user' | 'assistant' | 'tool';
export type ToolCall = { id: string; name: string; arguments: string };
export type ChatMessage = {
  role: Role;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
};
export type ToolDef = { name: string; description?: string; parameters: Record<string, unknown> };

/** Indications passées au provider (utilisées par le mock, ignorées par les vrais LLM). */
export type TaskHint = {
  task: 'plan' | 'code' | 'fix' | 'tools' | 'dashboard';
  prompt: string;
  previousCode?: string;
  errors?: Array<{ message: string }>;
  toolResults?: Array<{ name: string; result: unknown }>;
  /** Outils MCP proposés au constructeur de tableaux (mode démo). */
  tools?: Array<{ id: string; description?: string; write?: boolean }>;
  dashboardMode?: 'create' | 'chart' | 'add' | 'filters';
  chartId?: string;
};

export type StreamOptions = {
  onDelta?: (text: string) => void;      // mode streaming : morceau à ajouter
  onSnapshot?: (full: string) => void;   // mode diffusion : texte complet débruité à l'étape courante
  diffusing?: boolean;
  maxTokens?: number;
  signal?: AbortSignal;
  hint: TaskHint;
};

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly supportsDiffusion: boolean;
  readonly supportsTools: boolean;
  /** Génère en streaming et renvoie le texte final. */
  stream(messages: ChatMessage[], opts: StreamOptions): Promise<string>;
  /** Un tour de tool calling (non streamé). */
  chatWithTools(messages: ChatMessage[], tools: ToolDef[], opts: { hint: TaskHint; signal?: AbortSignal; maxTokens?: number }): Promise<{ content: string; toolCalls: ToolCall[] }>;
}

export type EngineEvent =
  | { type: 'meta'; provider: string; model: string; diffusing: boolean; fallback?: string; tools: number }
  | { type: 'phase'; phase: 'tools' | 'plan' | 'code' | 'fix'; label: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: unknown; error?: string; ms?: number }
  | { type: 'plan_delta'; text: string }
  | { type: 'plan_done'; plan: string }
  | { type: 'code_delta'; text: string }
  | { type: 'code_snapshot'; text: string; step: number }
  | { type: 'code_done'; code: string }
  | { type: 'error'; message: string };

export type RuntimeTool = { id: string; name: string; description?: string; inputSchema?: unknown; write: boolean; server: string };
