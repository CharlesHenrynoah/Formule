/**
 * Orchestrateur : prompt → (outils MCP) → plan → code streamé (ou diffusé) → HTML final.
 * Indépendant du transport : émet des EngineEvent via `emit`.
 */
import type { ChatMessage, EngineEvent, LLMProvider, RuntimeTool, ToolDef } from './types.ts';
import type { McpClient } from './mcp.ts';
import { PLAN_SYSTEM, PLAN_ITERATE_SYSTEM, TOOLS_SYSTEM, FIX_SYSTEM, codeSystem, extractHtml } from './prompts.ts';

export type GenerateInput = {
  prompt: string;
  previousCode?: string;
  previousPlan?: string;
  diffusing?: boolean;
  useTools?: boolean;
};
export type FixInput = { prompt: string; code: string; errors: Array<{ message: string; line?: number }>; diffusing?: boolean };

type Ctx = { provider: LLMProvider; mcp?: McpClient; emit: (e: EngineEvent) => void; signal?: AbortSignal; fallback?: string };

async function streamCode(ctx: Ctx, messages: ChatMessage[], diffusing: boolean, hint: Parameters<LLMProvider['stream']>[1]['hint']) {
  let step = 0;
  const raw = await ctx.provider.stream(messages, {
    hint, diffusing, signal: ctx.signal,
    onDelta: (text) => ctx.emit({ type: 'code_delta', text }),
    onSnapshot: (text) => ctx.emit({ type: 'code_snapshot', text, step: ++step }),
  });
  const code = extractHtml(raw);
  // Le mode diffusion peut s'arrêter avant la fin (finish_reason=length) : on relance une fois en streaming classique.
  if (diffusing && !/<\/html\s*>/i.test(code)) {
    ctx.emit({ type: 'phase', phase: 'code', label: 'Diffusion incomplète : reprise en streaming' });
    return streamCode(ctx, messages, false, hint);
  }
  return code;
}

export async function generate(input: GenerateInput, ctx: Ctx) {
  const { provider, emit } = ctx;
  const iterating = !!input.previousCode;
  const diffusing = !!input.diffusing && provider.supportsDiffusion;
  const runtimeTools = input.useTools === false ? [] : (await ctx.mcp?.listTools()) ?? [];
  emit({ type: 'meta', provider: provider.name, model: provider.model, diffusing, fallback: ctx.fallback, tools: runtimeTools.length });

  // 1) Outils MCP en lecture pendant la génération (tool calling)
  const toolResults: Array<{ name: string; result: unknown }> = [];
  const readTools = runtimeTools.filter((t) => !t.write);
  if (!iterating && provider.supportsTools && readTools.length && ctx.mcp) {
    emit({ type: 'phase', phase: 'tools', label: 'Consultation des outils MCP' });
    const defs: ToolDef[] = readTools.map((t) => ({ name: t.id, description: t.description, parameters: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} } }));
    const msgs: ChatMessage[] = [{ role: 'system', content: TOOLS_SYSTEM }, { role: 'user', content: input.prompt }];
    for (let round = 0; round < 3; round++) {
      const res = await provider.chatWithTools(msgs, defs, { hint: { task: 'tools', prompt: input.prompt }, signal: ctx.signal });
      if (!res.toolCalls.length) break;
      msgs.push({ role: 'assistant', content: res.content, tool_calls: res.toolCalls });
      for (const call of res.toolCalls.slice(0, 3)) {
        let args: unknown = {};
        try { args = JSON.parse(call.arguments || '{}'); } catch { /* arguments invalides */ }
        emit({ type: 'tool_call', id: call.id, name: call.name, args });
        try {
          if (!defs.some((d) => d.name === call.name)) throw new Error('outil non autorisé pendant la génération');
          const r = await ctx.mcp.call(call.name, args);
          toolResults.push({ name: call.name, result: r.data });
          emit({ type: 'tool_result', id: call.id, name: call.name, result: r.data, ms: r.ms });
          msgs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(r.data).slice(0, 8000) });
        } catch (e) {
          const message = (e as Error).message;
          emit({ type: 'tool_result', id: call.id, name: call.name, result: null, error: message });
          msgs.push({ role: 'tool', tool_call_id: call.id, content: `Erreur : ${message}` });
        }
      }
    }
  }
  const toolContext = toolResults.length
    ? `\n\nDonnées récupérées via MCP pendant la conception :\n${toolResults.map((t) => `- ${t.name} → ${JSON.stringify(t.result).slice(0, 1500)}`).join('\n')}`
    : '';

  // 2) Plan
  emit({ type: 'phase', phase: 'plan', label: iterating ? 'Plan des modifications' : 'Planification' });
  const planMsgs: ChatMessage[] = iterating
    ? [{ role: 'system', content: PLAN_ITERATE_SYSTEM }, { role: 'user', content: `Plan actuel :\n${input.previousPlan ?? '(inconnu)'}\n\nDemande de modification : ${input.prompt}` }]
    : [{ role: 'system', content: PLAN_SYSTEM }, { role: 'user', content: input.prompt + toolContext }];
  const plan = (await provider.stream(planMsgs, {
    hint: { task: 'plan', prompt: input.prompt, previousCode: input.previousCode, toolResults }, signal: ctx.signal, maxTokens: 4000,
    onDelta: (text) => emit({ type: 'plan_delta', text }),
  })).trim();
  emit({ type: 'plan_done', plan });

  // 3) Code
  emit({ type: 'phase', phase: 'code', label: diffusing ? 'Génération du code (diffusion)' : 'Génération du code' });
  const user = iterating
    ? `Voici le code actuel de la mini-app :\n\n${input.previousCode}\n\nModifications à appliquer :\n${plan}\n\nDemande : ${input.prompt}\nRenvoie le fichier HTML complet mis à jour.`
    : `Demande : ${input.prompt}\n\nPlan à suivre :\n${plan}${toolContext}`;
  const code = await streamCode(ctx, [{ role: 'system', content: codeSystem(runtimeTools) }, { role: 'user', content: user }], diffusing,
    { task: 'code', prompt: input.prompt, previousCode: input.previousCode, toolResults });
  emit({ type: 'code_done', code });
  return { plan, code, provider: provider.name, model: provider.model, toolResults };
}

export async function fix(input: FixInput, ctx: Ctx) {
  const diffusing = !!input.diffusing && ctx.provider.supportsDiffusion;
  ctx.emit({ type: 'phase', phase: 'fix', label: 'Correction automatique' });
  const errors = input.errors.map((e) => `- ${e.message}${e.line ? ` (ligne ${e.line})` : ''}`).join('\n');
  const code = await streamCode(ctx, [
    { role: 'system', content: FIX_SYSTEM },
    { role: 'user', content: `Demande d'origine : ${input.prompt}\n\nErreurs du validateur :\n${errors}\n\nCode :\n${input.code}` },
  ], diffusing, { task: 'fix', prompt: input.prompt, previousCode: input.code, errors: input.errors });
  ctx.emit({ type: 'code_done', code });
  return { code };
}
