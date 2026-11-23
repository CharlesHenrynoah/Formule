/** Provider Anthropic (Messages API) avec streaming et tool use. */
import type { ChatMessage, LLMProvider, StreamOptions, ToolDef, ToolCall, TaskHint } from '../types.ts';
import { readSse, ensureOk } from './sse.ts';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly supportsDiffusion = false;
  readonly supportsTools = true;
  constructor(private apiKey: string, readonly model: string, private baseUrl = 'https://api.anthropic.com/v1') {}

  private split(messages: ChatMessage[]) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const out: any[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'tool') {
        out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] });
      } else if (m.role === 'assistant' && m.tool_calls?.length) {
        out.push({ role: 'assistant', content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.tool_calls.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: JSON.parse(t.arguments || '{}') })),
        ] });
      } else out.push({ role: m.role, content: m.content });
    }
    return { system, messages: out };
  }

  private headers() {
    return { 'Content-Type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' };
  }

  async stream(messages: ChatMessage[], opts: StreamOptions) {
    const res = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST', headers: this.headers(), signal: opts.signal,
      body: JSON.stringify({ model: this.model, max_tokens: opts.maxTokens ?? 16000, stream: true, ...this.split(messages) }),
    });
    await ensureOk(res, 'anthropic');
    let full = '';
    await readSse(res, (data) => {
      if (data?.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
        full += data.delta.text;
        opts.onDelta?.(data.delta.text);
      }
    });
    return full;
  }

  async chatWithTools(messages: ChatMessage[], tools: ToolDef[], opts: { hint: TaskHint; signal?: AbortSignal }) {
    const res = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST', headers: this.headers(), signal: opts.signal,
      body: JSON.stringify({
        model: this.model, max_tokens: 2000, ...this.split(messages),
        tools: tools.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.parameters })),
      }),
    });
    await ensureOk(res, 'anthropic');
    const json = (await res.json()) as any;
    const blocks: any[] = json.content ?? [];
    const toolCalls: ToolCall[] = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) }));
    return { content: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''), toolCalls };
  }
}
