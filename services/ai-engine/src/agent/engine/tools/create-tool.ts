import type { AgentTool } from './types.ts';

const EXPLANATION = {
  type: 'string',
  description: "Une courte phrase au présent continu, produite en premier. Exemple : « J'écris la page ».",
};

/** Même fabrique que Quests : le schéma, le nom et l'exécution vivent au même endroit. */
export function setupTool(tool: AgentTool): AgentTool {
  const parameters = tool.parameters;
  const properties = (parameters.properties && typeof parameters.properties === 'object' ? parameters.properties : {}) as Record<string, unknown>;
  return {
    ...tool,
    parameters: {
      type: 'object',
      properties: { explanation: EXPLANATION, ...properties },
      required: Array.isArray(parameters.required) ? parameters.required : [],
    },
  };
}
