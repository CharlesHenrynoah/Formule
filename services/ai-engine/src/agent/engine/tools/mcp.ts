import { setupTool } from './create-tool.ts';
import type { AgentTool } from './types.ts';

export const McpListTools: AgentTool = setupTool({
  name: 'mcp_list_tools',
  readOnly: true,
  timeoutMs: 30_000,
  agents: ['liaison'],
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
  agents: ['liaison'],
  description: () => 'Échantillonne un outil MCP en lecture. Au plus 3 appels. Jamais state all. GitHub : state open, perPage 20, sort created, direction desc.',
  parameters: {
    properties: {
      tool: { type: 'string', description: 'Identifiant, ex. github__list_issues' },
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
