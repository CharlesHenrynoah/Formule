import { setupTool } from './create-tool.ts';
import type { AgentTool } from './types.ts';

const text = (output: unknown) => (typeof output === 'string' ? output : JSON.stringify(output));
const roleOf = (name: string) => (name === 'liaison' || name === 'router' ? 'data' : 'dev') as 'data' | 'dev';

export const ReadFile: AgentTool = setupTool({
  name: 'read_file',
  readOnly: true,
  timeoutMs: 30_000,
  agents: ['main', 'liaison'],
  description: () => 'Lit un fichier. from et to (lignes) renvoient le texte exact, sans numéros : c\'est ce texte qui va dans edit_file.',
  parameters: { properties: { path: { type: 'string' }, from: { type: 'number' }, to: { type: 'number' } }, required: ['path'] },
  execute: async ({ agentName, toolbox, input }) => {
    try {
      const path = String(input.path ?? '');
      const from = Number(input.from);
      const to = Number(input.to);
      if (Number.isFinite(from)) {
        const end = Number.isFinite(to) ? to : from + 119;
        const range = await toolbox.readRange(roleOf(agentName), path, from, Math.min(end, from + 119));
        return { ok: true, output: { text: range.text, total: range.total, from: range.from, to: range.to } };
      }
      const body = await toolbox.readFile(roleOf(agentName), path);
      const lines = body.split('\n');
      if (lines.length <= 160 && body.length <= 7000) return { ok: true, output: body };
      const head = lines.slice(0, 40).map((line, i) => `${i + 1}| ${line}`).join('\n');
      const tailFrom = Math.max(41, lines.length - 39);
      const tail = lines.slice(tailFrom - 1).map((line, i) => `${tailFrom + i}| ${line}`).join('\n');
      return { ok: true, output: { text: `${head}\n…\n${tail}`, total: lines.length, note: `fichier de ${lines.length} lignes : relis la zone avec from et to` } };
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
  description: () => 'Remplace un extrait exact. find est le texte du fichier, sans numéros de ligne.',
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
  description: () => 'Cherche un texte littéral, pas une expression régulière.',
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
  description: () => 'Construit l\'interface (vite), une fois, après un backend conforme.',
  parameters: { properties: {}, required: [] },
  execute: async ({ toolbox }) => {
    try {
      const built = await toolbox.build();
      return { ok: true, output: built };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  },
  toModelOutput: text,
});
