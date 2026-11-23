import { setupTool } from './create-tool.ts';
import type { AgentTool } from './types.ts';

const text = (output: unknown) => (typeof output === 'string' ? output : JSON.stringify(output));
const roleOf = (name: string) => (name === 'liaison' ? 'data' : 'dev') as 'data' | 'dev';

export const ReadFile: AgentTool = setupTool({
  name: 'read_file',
  readOnly: true,
  timeoutMs: 30_000,
  agents: ['main', 'liaison'],
  description: () => 'Lit un fichier du projet (chemin relatif, ex. src/App.tsx).',
  parameters: { properties: { path: { type: 'string' } }, required: ['path'] },
  execute: async ({ agentName, toolbox, input }) => {
    try {
      const body = await toolbox.readFile(roleOf(agentName), String(input.path ?? ''));
      return { ok: true, output: body.slice(0, 12_000) };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  toModelOutput: text,
});

export const WriteFile: AgentTool = setupTool({
  name: 'write_file',
  readOnly: false,
  timeoutMs: 30_000,
  agents: ['main'],
  description: () => 'Écrit un fichier entier du projet. Le code va ici, pas dans le message.',
  parameters: { properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  execute: async ({ toolbox, input }) => {
    try {
      const written = await toolbox.writeFile(String(input.path ?? ''), String(input.content ?? ''));
      return { ok: true, output: written };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  toModelOutput: (output) => text(output).slice(0, 500),
});

export const EditFile: AgentTool = setupTool({
  name: 'edit_file',
  readOnly: false,
  timeoutMs: 30_000,
  agents: ['main'],
  description: () => 'Remplace un extrait exact d\'un fichier. find doit être présent tel quel.',
  parameters: { properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } }, required: ['path', 'find', 'replace'] },
  execute: async ({ toolbox, input }) => {
    try {
      const edited = await toolbox.editFile(String(input.path ?? ''), [{ find: String(input.find ?? ''), replace: String(input.replace ?? '') }]);
      return { ok: true, output: edited };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  toModelOutput: (output) => text(output).slice(0, 500),
});

export const Grep: AgentTool = setupTool({
  name: 'grep',
  readOnly: true,
  timeoutMs: 30_000,
  agents: ['main'],
  description: () => 'Cherche un motif dans les fichiers du projet.',
  parameters: { properties: { pattern: { type: 'string' } }, required: ['pattern'] },
  execute: async ({ agentName, toolbox, input }) => {
    try {
      const hits = await toolbox.searchCode(roleOf(agentName), String(input.pattern ?? ''));
      return { ok: true, output: hits.slice(0, 40) };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  toModelOutput: text,
});

export const Glob: AgentTool = setupTool({
  name: 'glob',
  readOnly: true,
  timeoutMs: 30_000,
  agents: ['main'],
  description: () => 'Liste les fichiers sous src/ et server/tools.ts.',
  parameters: { properties: {}, required: [] },
  execute: async ({ agentName, toolbox }) => {
    try {
      const files = await toolbox.listFiles(roleOf(agentName));
      return { ok: true, output: files };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  toModelOutput: text,
});

export const ShadcnAdd: AgentTool = setupTool({
  name: 'shadcn_add',
  readOnly: false,
  timeoutMs: 90_000,
  agents: ['main'],
  description: () => 'Ajoute des composants shadcn/ui déjà prévus par le projet.',
  parameters: { properties: { components: { type: 'array', items: { type: 'string' } } }, required: ['components'] },
  execute: async ({ toolbox, input }) => {
    const components = Array.isArray(input.components) ? input.components.map(String) : [];
    try {
      const added = await toolbox.shadcnAdd(components);
      return { ok: true, output: added };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  toModelOutput: text,
});

export const TestBackend: AgentTool = setupTool({
  name: 'test_backend',
  readOnly: true,
  timeoutMs: 30_000,
  agents: ['main'],
  description: () => 'Exécute server/tools.ts dans un bac à sable et signale les erreurs.',
  parameters: { properties: {}, required: [] },
  execute: async ({ toolbox }) => {
    try {
      const report = await toolbox.testBackend('dev', null);
      return { ok: true, output: { ok: report.ok, problems: report.problems, tools: report.tools } };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  toModelOutput: text,
});

export const Build: AgentTool = setupTool({
  name: 'build',
  readOnly: false,
  timeoutMs: 120_000,
  agents: ['main'],
  description: () => 'Construit l\'interface (vite). À relancer après chaque correction jusqu\'au succès.',
  parameters: { properties: {}, required: [] },
  execute: async ({ toolbox }) => {
    try {
      const built = await toolbox.build();
      return { ok: true, output: built };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  toModelOutput: text,
});
