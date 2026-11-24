import type { ChatMessage, LLMProvider, ToolDef } from '../../types.ts';
import type { Toolbox } from '../toolbox.ts';
import { textOf } from './agents/shared.ts';
import type { Agent, SessionMessage, ToolPart } from './agents/types.ts';
import { toolByName } from './tools/all.ts';
import type { SpawnAgent } from './tools/types.ts';

const MAX_RETRY = 3;

export type LoopResult = {
  messages: SessionMessage[];
  steps: number;
  stopped: 'finish' | 'max-steps' | 'abort';
};

function toChat(messages: SessionMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      out.push({ role: 'system', content: textOf(message) });
      continue;
    }
    if (message.role === 'user' || message.role === 'session-context') {
      out.push({ role: 'user', content: textOf(message) });
      continue;
    }
    const tools = message.parts.filter((part): part is ToolPart => part.type === 'tool');
    const text = textOf(message);
    if (!tools.length) {
      out.push({ role: 'assistant', content: text });
      continue;
    }
    out.push({
      role: 'assistant',
      content: text,
      tool_calls: tools.map((part) => ({ id: part.toolCallId, name: part.name, arguments: JSON.stringify(part.input ?? {}) })),
    });
    for (const part of tools) {
      const body = part.state === 'output-error' ? `ERREUR : ${part.errorText ?? ''}` : part.output === undefined ? '' : JSON.stringify(part.output);
      out.push({ role: 'tool', tool_call_id: part.toolCallId, content: body.slice(0, 8000) });
    }
  }
  return out;
}

function toolDefs(agent: Agent): ToolDef[] {
  return agent.getTools().map((tool) => ({
    name: tool.name,
    description: tool.description(agent.name),
    parameters: tool.parameters,
  }));
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function dropped(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? '')}` : String(error);
  return /terminated|fetch failed|econnreset|econnrefused|socket hang up|network|und_err_/i.test(message);
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('arrêté')); }, { once: true });
  });
}

async function withTimeout<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Cet outil a été arrêté parce qu\'il a duré trop longtemps.')), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    void signal;
  }
}

/**
 * Boucle de l'agent, mêmes étapes que la machine Quests :
 * démarrage, appel du modèle, file d'outils en série, shouldContinue, fin.
 * Un échec réseau du modèle est rejoué trois fois, avec un délai qui double.
 */
export async function runAgentLoop(options: {
  agent: Agent;
  opening: SessionMessage[];
  llm: LLMProvider;
  toolbox: Toolbox;
  spawnAgent: SpawnAgent;
  signal?: AbortSignal;
  maxStepCount: number;
  /** Taille de la réponse. Une page entière ne tient pas dans 6000 jetons. */
  maxTokens?: number;
  onText?: (text: string) => void;
  onTrace?: (line: { component: string; step: string; level?: 'info' | 'ok' | 'error'; text: string }) => void;
}): Promise<LoopResult> {
  const signal = options.signal ?? new AbortController().signal;
  const who = ({ main: 'Développeur', router: 'Routeur', owner: 'Product Owner', liaison: 'Liaison' } as Record<string, string>)[options.agent.name] ?? options.agent.name;
  const trace = (step: string, text: string, level: 'info' | 'ok' | 'error' = 'info') => options.onTrace?.({ component: who, step, level, text });
  const messages = [...options.opening];
  let steps = 0;
  let stopped: LoopResult['stopped'] = 'finish';

  await options.agent.onStart();

  while (!signal.aborted) {
    if (steps + 1 > options.maxStepCount) {
      messages.push({
        role: 'assistant',
        parts: [{ type: 'text', text: `L'agent s'arrête : nombre d'étapes atteint (${options.maxStepCount}).` }],
      });
      stopped = 'max-steps';
      break;
    }
    steps += 1;
    trace(`tour ${steps}`, 'appel du modèle');

    let reply: { content: string; toolCalls: { id: string; name: string; arguments: string }[] } | undefined;
    let attempt = 0;
    while (!reply) {
      try {
        reply = await options.llm.chatWithTools(toChat(messages), toolDefs(options.agent), {
          hint: { task: 'tools', prompt: '' },
          signal,
          maxTokens: options.maxTokens ?? 6000,
        });
      } catch (error) {
        if (signal.aborted) break;
        attempt += 1;
        trace(`tour ${steps}`, `rejeu ${attempt} · ${(error as Error).message}`, 'error');
        if (attempt >= MAX_RETRY || !dropped(error)) throw error;
        await sleep(400 * 2 ** (attempt - 1), signal);
      }
    }
    if (!reply || signal.aborted) { stopped = 'abort'; break; }

    const text = String(reply.content ?? '').trim();
    trace(`tour ${steps}`, `${(reply.toolCalls ?? []).length} outil(s) · ${text.length} caractères`, 'ok');
    if (text) options.onText?.(text);
    const parts: SessionMessage['parts'] = [];
    if (text) parts.push({ type: 'text', text });
    const calls = reply.toolCalls ?? [];
    for (const call of calls) {
      parts.push({
        type: 'tool',
        name: call.name,
        toolCallId: call.id || `call_${steps}_${parts.length}`,
        state: 'output-error',
        input: parseArgs(call.arguments),
        errorText: 'en cours',
      });
    }
    const assistant: SessionMessage = { role: 'assistant', parts };
    messages.push(assistant);

    for (const part of assistant.parts) {
      if (part.type !== 'tool') continue;
      if (signal.aborted) { stopped = 'abort'; break; }
      const tool = toolByName(part.name);
      const allowed = tool && options.agent.getTools().some((item) => item.name === tool.name);
      if (!tool || !allowed) {
        part.state = 'output-error';
        part.errorText = `Outil inconnu pour cet agent : ${part.name}`;
        trace(part.name, 'outil refusé pour cet agent', 'error');
        continue;
      }
      try {
        const result = await withTimeout(tool.execute({
          agentName: options.agent.name,
          toolbox: options.toolbox,
          signal,
          spawnAgent: options.spawnAgent,
          input: (part.input && typeof part.input === 'object' ? part.input : {}) as Record<string, unknown>,
        }), tool.timeoutMs, signal);
        if (result.ok) {
          part.state = 'output-available';
          part.output = result.output;
          part.errorText = undefined;
        } else {
          part.state = 'output-error';
          part.errorText = result.error;
        }
      } catch (error) {
        part.state = 'output-error';
        part.errorText = (error as Error).message;
      }
    }

    if (stopped === 'abort') break;
    if (!options.agent.shouldContinue({ messages })) { trace(`tour ${steps}`, 'fin de boucle', 'ok'); break; }
  }
  trace('arrêt', `${stopped} · ${steps} tours`, stopped === 'abort' ? 'error' : 'ok');

  if (stopped !== 'abort') await options.agent.onFinish();
  return { messages, steps, stopped };
}
