import type { AgentEvent } from '../../events.ts';
import { TOOLS } from '../tools/all.ts';
import { setupAgent } from './create-agent.ts';
import { contextMessage, shouldContinueWithToolCalls, systemMessage } from './shared.ts';
import type { Agent } from './types.ts';

const SYSTEM = `Tu es le routeur. Tu es un agent. Tu es le seul à communiquer avec le MCP, pour n'importe quel logiciel. Tu n'écris pas de code et tu ne poses pas l'interface.

La mission nomme déjà la collection et, souvent, l'outil exact. mcp_list_tools, puis le premier mcp_call est cet outil. Tu n'appelles aucun autre serveur. Au plus 3 mcp_call. Tu n'inventes pas de nom d'outil.
Si la mission ne nomme pas d'outil, tu choisis l'outil en lecture dont le nom contient la collection. Tu ignores les outils de recherche qui ne portent pas cette collection.
GitHub : perPage 20. Jamais state "all". Les arguments sont un objet, pas une chaîne.

Rapport court : type d'élément, collection, outil, arguments, noms des champs observés. Pas de dump.`;

export function routerAgent(emit: (event: AgentEvent) => void): Agent {
  return setupAgent({ name: 'router', tools: [TOOLS.mcp_list_tools, TOOLS.mcp_call] }).create({
    getMessages: ({ prompt }) => [
      systemMessage('router', SYSTEM),
      contextMessage('router', `<mission>\n${prompt}\n</mission>`),
    ],
    onStart: async () => { emit({ type: 'agent', kind: 'role', role: 'data', label: 'Routeur' }); },
    onFinish: async () => {},
    shouldContinue: shouldContinueWithToolCalls,
  });
}
