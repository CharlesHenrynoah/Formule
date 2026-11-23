/** Point d'entrée de l'agent : équipe réelle (Agents SDK + LLM compatible OpenAI) ou équipe scriptée (démo). */
import type { McpClient } from '../mcp.ts';
import { INCEPTION_BASE_URL, INCEPTION_DEFAULT_MODEL } from '../providers/index.ts';
import { type CrewConfig, type CrewInput } from './crew.ts';
import { runEngine } from './engine/run.ts';
import { runScriptedCrew } from './scripted.ts';
import { Workspace } from './workspace.ts';

export type AgentBackend = { kind: 'llm'; cfg: CrewConfig; provider: string } | { kind: 'scripted'; provider: 'mock' } | { kind: 'unavailable'; reason: string };

export function agentBackend(env: NodeJS.ProcessEnv = process.env, providerName: string): AgentBackend {
  if (!Workspace.templateReady()) return { kind: 'unavailable', reason: 'template agent absent (bash scripts/setup-agent-template.sh)' };
  const maxRework = Number(env.AGENT_MAX_REWORK ?? 2);
  if (providerName === 'mock') return { kind: 'scripted', provider: 'mock' };
  if (providerName === 'inception') {
    return { kind: 'llm', provider: 'inception', cfg: { baseUrl: env.LLM_BASE_URL || INCEPTION_BASE_URL, apiKey: (env.INCEPTION_API_KEY || env.LLM_API_KEY)!, model: env.LLM_MODEL?.trim() || INCEPTION_DEFAULT_MODEL, reasoningEffort: env.LLM_REASONING_EFFORT || 'instant', maxRework } };
  }
  if (providerName === 'openai') {
    return { kind: 'llm', provider: 'openai', cfg: { baseUrl: env.LLM_BASE_URL || 'https://api.openai.com/v1', apiKey: (env.LLM_API_KEY || env.OPENAI_API_KEY)!, model: env.LLM_MODEL?.trim() || 'gpt-4o-mini', maxRework } };
  }
  return { kind: 'unavailable', reason: `provider ${providerName} non compatible OpenAI : pipeline direct` };
}

export async function runAgent(input: CrewInput, backend: AgentBackend, ctx: { mcp?: McpClient; emit: (e: Record<string, unknown>) => void; signal?: AbortSignal }) {
  if (backend.kind === 'llm') return runEngine(input, backend.cfg, ctx);
  if (backend.kind === 'scripted') return runScriptedCrew(input, ctx);
  throw new Error(backend.reason);
}
export { Workspace };
