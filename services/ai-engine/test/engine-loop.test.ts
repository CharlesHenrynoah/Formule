import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LLMProvider, ToolCall } from '../src/types.ts';
import type { Toolbox } from '../src/agent/toolbox.ts';
import { shouldContinueWithToolCalls } from '../src/agent/engine/agents/shared.ts';
import { mainAgent } from '../src/agent/engine/agents/main.ts';
import { locateAnchor } from '../src/agent/workspace.ts';
import { ReadFile } from '../src/agent/engine/tools/workspace.ts';
import { runAgentLoop } from '../src/agent/engine/loop.ts';
import { Task } from '../src/agent/engine/tools/task.ts';
import type { SessionMessage } from '../src/agent/engine/agents/types.ts';

function scripted(turns: Array<{ content?: string; toolCalls?: ToolCall[] }>): LLMProvider {
  let i = 0;
  return {
    name: 'fake', model: 'fake', supportsDiffusion: false, supportsTools: true,
    stream: async () => '',
    chatWithTools: async () => {
      const turn = turns[Math.min(i, turns.length - 1)];
      i += 1;
      return { content: turn.content ?? '', toolCalls: turn.toolCalls ?? [] };
    },
  };
}

test('la boucle continue tant que le dernier message appelle un outil', () => {
  const withTool: SessionMessage = { role: 'assistant', parts: [{ type: 'tool', name: 'glob', toolCallId: '1', state: 'output-available', input: {} }] };
  const plain: SessionMessage = { role: 'assistant', parts: [{ type: 'text', text: 'fini' }] };
  assert.equal(shouldContinueWithToolCalls({ messages: [withTool] }), true);
  assert.equal(shouldContinueWithToolCalls({ messages: [withTool, plain] }), false);
});

test('les outils s\'exécutent un par un, puis l\'agent s\'arrête sans nouvel appel', async () => {
  const writes: string[] = [];
  const toolbox = { writeFile: async (_path: string, content: string) => { writes.push(content); return { path: 'src/App.tsx', lines: 1, bytes: content.length }; } } as unknown as Toolbox;
  const llm = scripted([
    { toolCalls: [{ id: 'a', name: 'write_file', arguments: JSON.stringify({ path: 'src/App.tsx', content: 'export default function App(){return null}' }) }, { id: 'b', name: 'glob', arguments: '{}' }] },
    { content: 'Interface prête.' },
  ]);
  const agent = mainAgent(() => {});
  const result = await runAgentLoop({
    agent,
    opening: agent.getMessages({ prompt: 'un tableau', files: [], incremental: false, datasets: '' }),
    llm, toolbox, spawnAgent: async () => { throw new Error('pas de sous-agent'); },
    maxStepCount: 8,
  });
  assert.equal(writes.length, 1);
  assert.equal(result.stopped, 'finish');
  assert.equal(result.steps, 2);
  assert.match(result.messages.at(-1)?.parts.find((part) => part.type === 'text' && 'text' in part)?.text ?? '', /prête/);
});

test('le plafond d\'étapes arrête la boucle', async () => {
  const llm = scripted([{ toolCalls: [{ id: 'a', name: 'glob', arguments: '{}' }] }]);
  const toolbox = { listFiles: async () => ['src/App.tsx'] } as unknown as Toolbox;
  const agent = mainAgent(() => {});
  const result = await runAgentLoop({
    agent,
    opening: [],
    llm, toolbox, spawnAgent: async () => { throw new Error('non'); },
    maxStepCount: 1,
  });
  assert.equal(result.stopped, 'max-steps');
  const closing = result.messages.at(-1)?.parts.find((part) => part.type === 'text');
  assert.match(closing && closing.type === 'text' ? closing.text : '', /étapes/);
});

test('le tableau suit la composition shadcn-admin, sans sidebar', () => {
  const agent = mainAgent(() => {});
  const text = agent.getMessages({ prompt: 'activité', files: [], incremental: false, datasets: '' }).map((message) => message.parts.map((part) => part.type === 'text' ? part.text : '').join('\n')).join('\n');
  assert.match(text, /BoardStack/);
  assert.match(text, /src\/components\/es\/board\.tsx/);
  assert.match(text, /Sidebar/);
  assert.match(text, /sans sa barre latérale/);
  assert.match(text, /data_list/);
  assert.match(text, /compile_backend/);
  assert.match(text, /h-\[260px\]/);
  assert.match(text, /var\(--chart-1\)/);
  assert.match(text, /Pas de Chart\.js/);
});

test('une page longue se relit par plage de lignes', async () => {
  const lines = Array.from({ length: 400 }, (_, i) => `ligne ${i + 1} du tableau`);
  const toolbox = {
    readFile: async () => lines.join('\n'),
    readRange: async (_role: string, _path: string, from: number, to: number) => ({
      text: lines.slice(from - 1, to).map((line, i) => `${from + i}| ${line}`).join('\n'),
      total: lines.length, from, to,
    }),
  };
  const ctx = { agentName: 'main' as const, toolbox: toolbox as never, signal: new AbortController().signal, spawnAgent: async () => ({ text: '', messages: [] }) };
  const wide = await ReadFile.execute({ ...ctx, input: { path: 'src/App.tsx' } });
  assert.equal(wide.ok, true);
  if (wide.ok) assert.match(JSON.stringify(wide.output), /from et to/);
  const slice = await ReadFile.execute({ ...ctx, input: { path: 'src/App.tsx', from: 330, to: 360 } });
  assert.equal(slice.ok, true);
  if (slice.ok) {
    const body = JSON.stringify(slice.output);
    assert.match(body, /ligne 330/);
    assert.match(body, /"from":330/);
  }
});

test('un ancrage copié avec des numéros de ligne retrouve le texte', () => {
  const page = '<h3>Top 10 des contributeurs</h3>\n<Chart />';
  const hit = locateAnchor(page, '462| <h3>Top 10 des contributeurs</h3>');
  assert.equal(hit.index, 0);
  assert.equal(hit.length, '<h3>Top 10 des contributeurs</h3>'.length);
  assert.equal(hit.ambiguous, false);
});

test('une demande sur une page ouverte passe par edit_file', () => {
  const agent = mainAgent(() => {});
  const text = agent.getMessages({ prompt: 'ajoute un graphique', files: ['src/App.tsx'], incremental: true, datasets: '' }).map((message) => message.parts.map((part) => part.type === 'text' ? part.text : '').join('\n')).join('\n');
  assert.match(text, /edit_file/);
  assert.match(text, /n'appelles pas task/);
  const withPage = agent.getMessages({ prompt: 'ajoute un tableau', files: ['src/App.tsx'], incremental: true, datasets: '', page: '<h3>Top 10</h3>' }).map((message) => message.parts.map((part) => part.type === 'text' ? part.text : '').join('\n')).join('\n');
  assert.match(withPage, /<h3>Top 10<\/h3>/);
  assert.match(withPage, /page_return/);
});

test('task refuse un agent inconnu et un appel hors du principal', async () => {
  const unknown = await Task.execute({
    agentName: 'main', toolbox: {} as Toolbox, signal: new AbortController().signal,
    spawnAgent: async () => ({ text: '', messages: [] }),
    input: { prompt: 'x', subagent_type: 'retrieval' },
  });
  assert.equal(unknown.ok, false);
  const forbidden = await Task.execute({
    agentName: 'liaison', toolbox: {} as Toolbox, signal: new AbortController().signal,
    spawnAgent: async () => ({ text: '', messages: [] }),
    input: { prompt: 'x', subagent_type: 'liaison' },
  });
  assert.equal(forbidden.ok, false);
});
