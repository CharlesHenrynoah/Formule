import type { AgentEvent } from '../../events.ts';
import type { Agent, AgentName } from './types.ts';
import { liaisonAgent } from './liaison.ts';
import { mainAgent } from './main.ts';
import { ownerAgent } from './owner.ts';
import { routerAgent } from './router.ts';

export function buildAgents(emit: (event: AgentEvent) => void): Record<AgentName, Agent> {
  return {
    main: mainAgent(emit),
    router: routerAgent(emit),
    liaison: liaisonAgent(emit),
    owner: ownerAgent(emit),
  };
}
