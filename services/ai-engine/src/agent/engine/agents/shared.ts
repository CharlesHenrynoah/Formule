import type { AgentName, SessionMessage } from './types.ts';

export function textOf(message: SessionMessage): string {
  return message.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n').trim();
}

export function isToolPart(part: SessionMessage['parts'][number]): boolean {
  return part.type === 'tool';
}

/** On continue tant que le dernier message de l'assistant contient un appel d'outil. */
export function shouldContinueWithToolCalls(options: { messages: SessionMessage[] }): boolean {
  const last = [...options.messages].reverse().find((message) => message.role === 'assistant');
  if (!last) return true;
  return last.parts.some((part) => isToolPart(part));
}

export function systemMessage(agentName: AgentName, text: string): SessionMessage {
  return { role: 'system', parts: [{ type: 'text', text }] };
}

export function contextMessage(agentName: AgentName, text: string): SessionMessage {
  void agentName;
  return { role: 'session-context', parts: [{ type: 'text', text }] };
}
