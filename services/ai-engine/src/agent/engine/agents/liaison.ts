import type { AgentEvent } from '../../events.ts';
import { TOOLS } from '../tools/all.ts';
import { setupAgent } from './create-agent.ts';
import { contextMessage, shouldContinueWithToolCalls, systemMessage } from './shared.ts';
import type { Agent } from './types.ts';

const SYSTEM = `Tu es l'agent de liaison. Tu cherches et tu échantillons les outils MCP en lecture. Tu n'écris pas de code.

mcp_list_tools, puis au plus 3 mcp_call. Si la liste échoue, relance-la une fois. Tu n'inventes pas de nom d'outil.
GitHub : state "open", perPage 20, sort "created", direction "desc". Jamais state "all".
Un second appel state "closed" est permis s'il reste du quota.
Les arguments sont un objet, pas une chaîne.

Réponds par un court rapport : outil, arguments, noms des champs, et la collection parmi issues, pullRequests, commits, depots, profil. Pas de dump.`;

export function liaisonAgent(emit: (event: AgentEvent) => void): Agent {
  return setupAgent({ name: 'liaison', tools: [TOOLS.mcp_list_tools, TOOLS.mcp_call] }).create({
    getMessages: ({ prompt }) => [
      systemMessage('liaison', SYSTEM),
      contextMessage('liaison', `<mission>\n${prompt}\n</mission>`),
    ],
    onStart: async () => { emit({ type: 'agent', kind: 'role', role: 'data', label: 'Data Engineer' }); },
    onFinish: async () => {},
    shouldContinue: shouldContinueWithToolCalls,
  });
}
