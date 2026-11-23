/** ai-engine — moteur IA : endpoints SSE /generate et /fix. */
import { BIND_HOST } from './env.ts';
import Fastify, { type FastifyReply } from 'fastify';
import { createProvider } from './providers/index.ts';
import { generate, fix, type GenerateInput, type FixInput } from './engine.ts';
import { httpMcpClient } from './mcp.ts';
import type { EngineEvent } from './types.ts';
import { agentBackend, runAgent } from './agent/index.ts';
import { buildDashboard } from './dashboards/build.ts';
import { INTERPRETER_TIMEOUT_MS, shapeRows, type DashboardSpec } from './dashboards/spec.ts';

const PORT = Number(process.env.AI_ENGINE_PORT ?? 4001);
const choice = createProvider();
const mcp = httpMcpClient();
const backend = agentBackend(process.env, choice.provider.name);
const DEFAULT_MODE = (process.env.GENERATION_MODE ?? 'agent') === 'direct' ? 'direct' : 'agent';
console.log(`[ai-engine] provider=${choice.provider.name} model=${choice.provider.model}${choice.fallback ? ` (${choice.fallback})` : ''} agent=${backend.kind}${backend.kind === 'unavailable' ? ` (${backend.reason})` : ''}`);

const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 5 * 1024 * 1024 });

function sse(reply: FastifyReply) {
  reply.hijack();
  reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const ac = new AbortController();
  const stop = () => { clearInterval(ping); ac.abort(); };
  const ping = setInterval(() => { try { if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n'); } catch { stop(); } }, 10_000);
  reply.raw.on('close', stop);
  reply.raw.on('error', stop);
  return {
    signal: ac.signal,
    emit: (e: EngineEvent | { type: string; [k: string]: unknown }) => { if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`); },
    end: () => { clearInterval(ping); reply.raw.end(); },
  };
}

app.get('/health', async () => ({
  service: 'ai-engine', status: 'ok', provider: choice.provider.name, model: choice.provider.model,
  requested: choice.requested, fallback: choice.fallback ?? null, supportsDiffusion: choice.provider.supportsDiffusion,
  agent: { available: backend.kind !== 'unavailable', kind: backend.kind, framework: backend.kind === 'llm' ? 'moteur agentique' : backend.kind === 'scripted' ? 'scripté (démo)' : null, roles: ['principal', 'routeur'], defaultMode: DEFAULT_MODE },
}));

type AgentBody = GenerateInput & { mode?: 'agent' | 'direct'; phase?: 'source' | 'build'; sourceBrief?: string; previousFiles?: Record<string, string>; previousComponents?: string[]; previousBrief?: string; previousContract?: any; projectId?: string; previousVersion?: number; fullRebuild?: boolean; datasets?: Array<{ name: string; rows: Array<Record<string, unknown>> }> };
app.post<{ Body: AgentBody }>('/generate', async (req, reply) => {
  if (!req.body?.prompt) return reply.code(400).send({ error: 'prompt requis' });
  const s = sse(reply);
  const mode = req.body.mode ?? DEFAULT_MODE;
  // Une itération sur une app « directe » (sans fichiers source) reste en pipeline direct.
  const canAgent = backend.kind !== 'unavailable' && (!req.body.previousCode || !!req.body.previousFiles);
  if (mode === 'agent' && canAgent) {
    s.emit({ type: 'meta', provider: choice.provider.name, model: choice.provider.model, diffusing: false, fallback: choice.fallback, tools: 0, mode: 'agent', framework: backend.kind === 'llm' ? 'moteur agentique' : 'scripté (démo)' });
    try {
      const r = await runAgent({
        prompt: req.body.prompt, useTools: req.body.useTools, datasets: req.body.datasets, appId: req.body.projectId, previousVersion: req.body.previousVersion, fullRebuild: req.body.fullRebuild, phase: req.body.phase, sourceBrief: req.body.sourceBrief,
        previous: req.body.previousFiles ? { files: req.body.previousFiles, components: req.body.previousComponents, spec: req.body.previousPlan, brief: req.body.previousBrief, contract: req.body.previousContract ?? null } : undefined,
      }, backend, { mcp, emit: s.emit as (e: Record<string, unknown>) => void, signal: s.signal });
      s.emit({ type: 'code_done', code: r.code });
      s.emit({ type: 'result', ...r, mode: 'agent', provider: choice.provider.name, model: choice.provider.model });
    } catch (e) {
      s.emit({ type: 'error', message: `Agent : ${(e as Error).message}` });
    }
    s.end();
    return;
  }
  if (mode === 'agent' && backend.kind === 'unavailable') s.emit({ type: 'phase', phase: 'plan', label: `Agent indisponible (${backend.reason}) : pipeline direct` });
  try {
    const result = await generate(req.body, { provider: choice.provider, mcp, emit: s.emit, signal: s.signal, fallback: choice.fallback });
    s.emit({ type: 'result', ...result });
  } catch (e) {
    s.emit({ type: 'error', message: (e as Error).message });
  }
  s.end();
});

app.post<{ Body: FixInput }>('/fix', async (req, reply) => {
  if (!req.body?.code) return reply.code(400).send({ error: 'code requis' });
  const s = sse(reply);
  try {
    const result = await fix(req.body, { provider: choice.provider, emit: s.emit, signal: s.signal });
    s.emit({ type: 'result', ...result });
  } catch (e) {
    s.emit({ type: 'error', message: (e as Error).message });
  }
  s.end();
});

app.post<{ Body: { prompt?: string; dashboardId?: string; spec?: DashboardSpec | null } }>('/dashboards/build', async (req, reply) => {
  if (!req.body?.prompt?.trim()) return reply.code(400).send({ error: 'prompt requis' });
  const s = sse(reply);
  try {
    const result = await buildDashboard(
      { prompt: req.body.prompt.trim(), dashboardId: req.body.dashboardId, spec: req.body.spec },
      { provider: choice.provider, mcp, emit: s.emit as (e: Record<string, unknown>) => void, signal: s.signal },
    );
    s.emit({ type: 'result', ...result });
  } catch (e) {
    s.emit({ type: 'error', message: (e as Error).message });
  }
  s.end();
});

/** Lecture d'un graphique : le tableau appelle ses sources à chaque ouverture. Budget : 2 minutes. */
app.post<{ Body: { tool?: string; args?: unknown; x?: string; y?: string } }>('/interpret', async (req, reply) => {
  const tool = String(req.body?.tool ?? '');
  if (!/^[a-zA-Z0-9-]+__[\w.-]+$/.test(tool)) return reply.code(400).send({ error: 'nom d’outil invalide' });
  try {
    const r = await mcp.call(tool, req.body?.args ?? {}, { timeoutMs: INTERPRETER_TIMEOUT_MS });
    return { rows: shapeRows(r.data, req.body?.x || 'label', req.body?.y || 'value'), ms: r.ms ?? null };
  } catch (e) {
    return reply.code(502).send({ error: (e as Error).message });
  }
});

app.listen({ port: PORT, host: BIND_HOST }).then(() => console.log(`[ai-engine] prêt sur :${PORT}`));
