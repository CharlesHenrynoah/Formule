import { TASK_AGENT_NAMES, type TaskAgentName } from '../agents/types.ts';
import { textOf } from '../agents/shared.ts';
import { setupTool } from './create-tool.ts';
import type { AgentTool } from './types.ts';

const DESCRIPTIONS: Record<TaskAgentName, string> = {
  router: `Agent routeur. Il est le seul à parler au MCP : il choisit l'outil de lecture et l'échantillonne (3 appels maximum). Il ne écrit pas l'interface. Le prompt dit la collection et l'outil, et interdit les autres serveurs.`,
};

export const Task: AgentTool = setupTool({
  name: 'task',
  readOnly: false,
  timeoutMs: 10 * 60_000,
  agents: ['main'],
  description: (agentName) => {
    if (agentName !== 'main') return "Seul l'agent principal peut lancer un sous-agent.";
    const list = TASK_AGENT_NAMES.map((name) => `- ${name} : ${DESCRIPTIONS[name]}`).join('\n');
    return `Lance un sous-agent et attend son rapport.\n\nAgents disponibles :\n${list}\n\nLe prompt contient la mission. Le sous-agent renvoie un seul texte.`;
  },
  parameters: {
    properties: {
      prompt: { type: 'string', description: 'Mission du sous-agent.' },
      subagent_type: { type: 'string', description: 'Type du sous-agent. À produire en premier.' },
    },
    required: ['prompt', 'subagent_type'],
  },
  execute: async ({ agentName, input, signal, spawnAgent }) => {
    if (agentName !== 'main') return { ok: false, error: "Seul l'agent principal peut lancer un sous-agent." };
    const requested = String(input.subagent_type ?? '') as TaskAgentName;
    if (!TASK_AGENT_NAMES.includes(requested)) {
      return { ok: false, error: `Agent inconnu : ${requested}. Disponibles : ${TASK_AGENT_NAMES.join(', ')}` };
    }
    try {
      const spawned = await spawnAgent({ agentName: requested, prompt: String(input.prompt ?? ''), signal });
      const last = [...spawned.messages].reverse().find((message) => message.role === 'assistant');
      const result = last ? textOf(last) : spawned.text;
      return { ok: true, output: { result: result || 'Le sous-agent n\'a rien écrit.', summary: requested } };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  toModelOutput: (output) => {
    const row = output as { result?: string };
    return String(row?.result ?? '');
  },
});
