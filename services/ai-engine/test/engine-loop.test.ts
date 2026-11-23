import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LLMProvider, ToolCall } from '../src/types.ts';
import type { Toolbox } from '../src/agent/toolbox.ts';
import { shouldContinueWithToolCalls } from '../src/agent/engine/agents/shared.ts';
import { mainAgent } from '../src/agent/engine/agents/main.ts';
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
