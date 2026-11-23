import { compileBackend, readOps } from '../backend/compile.ts';
import { setupTool } from './create-tool.ts';
import type { AgentTool } from './types.ts';

const text = (output: unknown) => (typeof output === 'string' ? output : JSON.stringify(output));

export const CompileBackend: AgentTool = setupTool({
  name: 'compile_backend',
  readOnly: false,
  timeoutMs: 30_000,
  agents: ['main'],
  description: () => 'Assemble server/tools.ts à partir d\'opérations déjà connues (list, get, aggregate, groupBy, sort, filter, simulate, insert). Exemple : {"name":"get_issue_stats","kind":"read","collection":"issues","operation":"aggregate","metric":"count","filter":{"state":"open"}}.',
  parameters: {
    properties: {
      operations: {
        type: 'array',
        description: 'Contrats d\'opérations. Une collection et des champs observés par la liaison.',
        items: { type: 'object' },
      },
    },
    required: ['operations'],
  },
  execute: async ({ toolbox, input }) => {
    const compiled = compileBackend(readOps(input.operations));
    if (!compiled.ok) {
      const tail = compiled.typescript ? ' — besoin typescript' : '';
      return { ok: false, error: `${compiled.problems.join(' ; ')}${tail}` };
    }
    try {
      const written = await toolbox.writeFile('server/tools.ts', compiled.source);
      const report = await toolbox.testBackend('dev', null);
      if (!report.ok) return { ok: false, error: report.problems.slice(0, 3).join(' ; ') };
      const n = report.tools.length;
      return { ok: true, output: { tools: report.tools, conformes: `${n}/${n}`, bytes: written.bytes } };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
  toModelOutput: (output) => text(output).slice(0, 1500),
});
