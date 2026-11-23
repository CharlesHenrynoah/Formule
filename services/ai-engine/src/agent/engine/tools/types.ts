import type { Toolbox } from '../../toolbox.ts';
import type { AgentName, SessionMessage } from '../agents/types.ts';

export type ToolResult = { ok: true; output: unknown } | { ok: false; error: string };

export type SpawnAgent = (params: {
  agentName: AgentName;
  prompt: string;
  signal: AbortSignal;
}) => Promise<{ text: string; messages: SessionMessage[] }>;

export interface ToolExec {
  agentName: AgentName;
  toolbox: Toolbox;
  signal: AbortSignal;
  spawnAgent: SpawnAgent;
  input: Record<string, unknown>;
}

export interface AgentTool {
  name: string;
  readOnly: boolean;
  timeoutMs: number;
  /** Agents autorisés à voir cet outil. */
  agents: readonly AgentName[];
  description: (agentName: AgentName) => string;
  parameters: Record<string, unknown>;
  execute: (ctx: ToolExec) => Promise<ToolResult>;
  toModelOutput: (output: unknown) => string;
}
