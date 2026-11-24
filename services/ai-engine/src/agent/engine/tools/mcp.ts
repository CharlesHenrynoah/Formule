import { setupTool } from './create-tool.ts';
import type { AgentTool } from './types.ts';

export const McpListTools: AgentTool = setupTool({
  name: 'mcp_list_tools',
  readOnly: true,
  timeoutMs: 30_000,
  agents: ['router'],
  description: () => 'Liste les outils MCP autorisés, en lecture.',
  parameters: { properties: {}, required: [] },
  execute: async ({ toolbox }) => {
    try {
      const tools = await toolbox.listMcpTools('data');
      return { ok: true, output: tools };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  toModelOutput: (output) => JSON.stringify(output).slice(0, 4000),
});

export const McpCall: AgentTool = setupTool({
  name: 'mcp_call',
  readOnly: true,
  timeoutMs: 60_000,
  agents: ['router'],
  description: () => 'Échantillonne un outil du moteur choisi, en lecture. Au plus 3 appels. Args du schéma, pagination courte, jamais « all » si le schéma ne le liste pas.',
  parameters: {
    properties: {
      tool: { type: 'string', description: 'Identifiant serveur__outil du moteur choisi' },
      args: { type: 'object', description: 'Arguments courts.' },
    },
    required: ['tool'],
  },
  execute: async ({ toolbox, input }) => {
    try {
      const sample = await toolbox.sampleMcp('data', String(input.tool ?? ''), input.args ?? {});
      return { ok: true, output: sample };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  toModelOutput: (output) => JSON.stringify(output).slice(0, 4000),
});
