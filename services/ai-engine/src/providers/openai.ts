/**
 * Provider compatible OpenAI (/v1/chat/completions) : OpenAI, Inception (Mercury), OpenRouter, Groq, Mistral, Ollama…
 * Pour Inception : `diffusing: true` renvoie à chaque chunk le texte COMPLET en cours de débruitage.
 */
import type { ChatMessage, LLMProvider, StreamOptions, ToolDef, ToolCall, TaskHint } from '../types.ts';
import { readSse, ensureOk } from './sse.ts';

export type OpenAICompatConfig = {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  supportsDiffusion?: boolean;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  extraBody?: Record<string, unknown>;
};

const toWire = (m: ChatMessage) => {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
  if (m.role === 'assistant' && m.tool_calls?.length) {
    return { role: 'assistant', content: m.content || null, tool_calls: m.tool_calls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) };
  }
  return { role: m.role, content: m.content };
};

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly supportsDiffusion: boolean;
  readonly supportsTools = true;
  constructor(private cfg: OpenAICompatConfig) {
    this.name = cfg.name;
    this.model = cfg.model;
    this.supportsDiffusion = !!cfg.supportsDiffusion;
  }

  private headers() {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` };
  }

  async stream(messages: ChatMessage[], opts: StreamOptions): Promise<string> {
    const diffusing = !!opts.diffusing && this.supportsDiffusion;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(toWire),
      stream: true,
      [this.cfg.maxTokensField ?? 'max_tokens']: opts.maxTokens ?? 16000,
      ...this.cfg.extraBody,
    };
    if (diffusing) body.diffusing = true;
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: opts.signal,
    });
    await ensureOk(res, this.name);
    let full = '';
    let step = 0;
    let finish: string | undefined;
    await readSse(res, (data) => {
      const choice = data?.choices?.[0];
      if (choice?.finish_reason) finish = choice.finish_reason;
      const c = choice?.delta?.content;
      if (c === undefined || c === null) return;
      // Diffusion (Inception) : chaque chunk = texte complet en cours de débruitage ; le chunk final vide est ignoré.
      if (diffusing) { if (c) { full = c; step++; opts.onSnapshot?.(full); } }
      else { full += c; if (c) opts.onDelta?.(c); }
    });
    if (finish === 'length') console.warn(`[${this.name}] sortie tronquée (finish_reason=length, ${full.length} caractères)`);
    return full;
  }

  async chatWithTools(messages: ChatMessage[], tools: ToolDef[], opts: { hint: TaskHint; signal?: AbortSignal }) {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(toWire),
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.parameters } })),
      tool_choice: 'auto',
      [this.cfg.maxTokensField ?? 'max_tokens']: 2000,
      ...this.cfg.extraBody,
    };
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: opts.signal,
    });
    await ensureOk(res, this.name);
    const json = (await res.json()) as any;
    const msg = json?.choices?.[0]?.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((t: any) => ({ id: t.id, name: t.function?.name, arguments: t.function?.arguments ?? '{}' }));
    return { content: msg.content ?? '', toolCalls };
  }
}
