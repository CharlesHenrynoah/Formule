import type { AgentTool } from '../tools/types.ts';

/**
 * Forme d'un agent, calquée sur le moteur Quests :
 * messages d'ouverture, outils, onStart, onFinish, shouldContinue.
 * Les bibliothèques et les API restent les nôtres.
 */

export const AGENT_NAMES = ['main', 'liaison'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

/** Sous-agents que l'outil task peut lancer. Le principal n'en fait pas partie. */
export const TASK_AGENT_NAMES = ['liaison'] as const satisfies readonly AgentName[];
export type TaskAgentName = (typeof TASK_AGENT_NAMES)[number];

export type TextPart = { type: 'text'; text: string };
export type ToolPart = {
  type: 'tool';
  name: string;
  toolCallId: string;
  state: 'output-available' | 'output-error';
  input: unknown;
  output?: unknown;
  errorText?: string;
};
export type SessionPart = TextPart | ToolPart;

export type SessionMessage = {
  role: 'system' | 'user' | 'assistant' | 'session-context';
  parts: SessionPart[];
};

export type Opening = {
  prompt: string;
  files: string[];
  incremental: boolean;
  datasets: string;
};

export interface Agent {
  name: AgentName;
  getMessages: (opening: Opening) => SessionMessage[];
  getTools: () => AgentTool[];
  onStart: () => Promise<void>;
  onFinish: () => Promise<void>;
  shouldContinue: (options: { messages: SessionMessage[] }) => boolean;
}
