import type { AgentEvent } from '../../events.ts';
import { setupAgent } from './create-agent.ts';
import { contextMessage, shouldContinueWithToolCalls, systemMessage } from './shared.ts';
import type { Agent } from './types.ts';

const SYSTEM = `Tu es le Product Owner. Tu raisonnes avant le Développeur, pour n'importe quel logiciel.

Chaîne de pensée obligatoire (courte) :
1. Quel est le sujet réel de la demande ?
2. Quel écran l'utilisateur attend (cartes, courbe, tableau, catalogue…) ?
3. Quelle nature de données faut-il (live/métier vs documentation d'API) ?
4. Les champs observés suffisent-ils, ou n'a-t-on que method/summary/endpoint ?

Tu ne parles pas au MCP. Tu n'écris pas de code.
Tu refuses un écran live nourri uniquement par de la doc. search_docs sert à découvrir des méthodes, pas à peupler le dashboard.
Tu réponds en français, structuré.`;

export function ownerAgent(emit: (event: AgentEvent) => void): Agent {
  return setupAgent({ name: 'owner', tools: [] }).create({
    getMessages: ({ prompt, liaison }) => [
      systemMessage('owner', SYSTEM),
      contextMessage('owner', [
        liaison ? `<lectures>\n${liaison}\n</lectures>` : '',
        `<demande>\n${prompt}\n</demande>`,
      ].filter(Boolean).join('\n\n')),
    ],
    onStart: async () => { emit({ type: 'agent', kind: 'role', role: 'po', label: 'Product Owner' }); },
    onFinish: async () => {},
    shouldContinue: shouldContinueWithToolCalls,
  });
}
