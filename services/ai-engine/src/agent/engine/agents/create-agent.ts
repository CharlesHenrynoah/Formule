import type { Agent, AgentName } from './types.ts';
import type { AgentTool } from '../tools/types.ts';

/** Fabrique d'agent : le nom et les outils sont fixés, le comportement est fourni par create. */
export function setupAgent(options: { name: AgentName; tools: AgentTool[] }) {
  return {
    create(behavior: Omit<Agent, 'name' | 'getTools'>): Agent {
      const allowed = options.tools.filter((tool) => tool.agents.includes(options.name));
      return {
        ...behavior,
        name: options.name,
        getTools: () => allowed,
      };
    },
  };
}
