import type { AgentEvent } from '../../events.ts';
import { TOOLS } from '../tools/all.ts';
import { setupAgent } from './create-agent.ts';
import { contextMessage, shouldContinueWithToolCalls, systemMessage } from './shared.ts';
import type { Agent } from './types.ts';

const SYSTEM = `Tu es le routeur. Tu es un agent. Tu es le seul à communiquer avec le MCP, pour n'importe quel logiciel. Tu n'écris pas de code et tu ne poses pas l'interface.

La mission nomme déjà les collections et, souvent, chaque outil. mcp_list_tools, puis les mcp_call dans l'ordre de la mission. Tu n'appelles aucun autre serveur. Au plus 3 mcp_call. Tu n'inventes pas de nom d'outil. Une demande qui croise deux collections appelle l'outil de chacune.
Si la mission ne nomme pas d'outil, tu choisis l'outil en lecture dont le nom contient la collection. Tu ignores les outils de recherche qui ne portent pas cette collection.
GitHub : perPage 20. Jamais state "all". Les arguments sont un objet, pas une chaîne.

Rapport court : type d'élément, collection, outil, arguments, puis chaque champ observé avec son rôle. Pas de dump.
Rôles, pour toute demande : date (publishedAt, published_at, date, createdAt, mergedAt), libellé (tag, name, title, message), nombre (count, un entier), état (state, status). Un champ ne change pas de rôle. Un numéro de version n'est pas une date : 7.1.1 reste un libellé.`;

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
