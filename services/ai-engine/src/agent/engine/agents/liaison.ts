import type { AgentEvent } from '../../events.ts';
import { setupAgent } from './create-agent.ts';
import { contextMessage, shouldContinueWithToolCalls, systemMessage } from './shared.ts';
import type { Agent } from './types.ts';

const SYSTEM = `Tu es l'agent de liaison. Tu ne parles pas au MCP : c'est le routeur qui échantillonne. Tu n'écris pas de code.

Tu reçois le rapport du routeur. Tu le résumes : collection, champs observés, ce que l'écran peut lire. Tu n'inventes aucun champ. Pas de dump.`;

export function liaisonAgent(emit: (event: AgentEvent) => void): Agent {
  return setupAgent({ name: 'liaison', tools: [] }).create({
    getMessages: ({ prompt }) => [
      systemMessage('liaison', SYSTEM),
      contextMessage('liaison', `<mission>\n${prompt}\n</mission>`),
    ],
    onStart: async () => { emit({ type: 'agent', kind: 'role', role: 'data', label: 'Data Engineer' }); },
    onFinish: async () => {},
    shouldContinue: shouldContinueWithToolCalls,
  });
}
