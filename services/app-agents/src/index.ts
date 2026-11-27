import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { call, createService, listen, ServiceError } from '@formule/service-kit';
import { aggregate, getCollection, getPath, simulateLinear, toSeries } from '@formule/contracts';
import { answer, describeView, type Version } from './agent.js';

const app = await createService('app-agents');

async function version(projectId: string, n?: number): Promise<Version> {
  const v = await call<Version | null>('storage', n ? `/projects/${projectId}/versions/${n}` : `/projects/${projectId}/versions/active`);
  if (!v) throw new ServiceError(404, 'not_found', 'aucune version');
  return v;
}

function simulate(ver: Version, viewId: string, params: { variation_pct: number; horizon: number }) {
  const v = ver.spec.views.find((x) => x.id === viewId && x.kind === 'simulation');
  if (!v || v.kind !== 'simulation') throw new ServiceError(404, 'not_found', 'vue de simulation introuvable');
  const q = ver.bundle.queries[v.queryId];
  const pts = toSeries(getCollection(q.raw, v.bindings.collection) ?? [], v.bindings.t, v.bindings.v, getPath).points;
  return { kind: 'scenario', externalEffects: 0, ...simulateLinear(pts, params) };
}

app.post<{ Params: { projectId: string }; Body: { message: string; mode: 'ask' | 'agent'; version?: number } }>('/apps/:projectId/agent', async (r) => answer(await version(r.params.projectId, r.body.version), String(r.body.message ?? ''), r.body.mode ?? 'ask'));
app.post<{ Params: { projectId: string }; Body: { viewId: string; params: { variation_pct: number; horizon: number }; version?: number } }>('/apps/:projectId/simulate', async (r) => simulate(await version(r.params.projectId, r.body.version), r.body.viewId, r.body.params));
app.get<{ Params: { projectId: string } }>('/apps/:projectId/presets', async (r) => (await call<{ value: unknown }>('storage', `/memory/presets:${r.params.projectId}`)).value ?? []);
app.post<{ Params: { projectId: string }; Body: { name: string; viewId: string; values: Record<string, number> } }>('/apps/:projectId/presets', async (r) => {
  const cur = ((await call<{ value: unknown[] | null }>('storage', `/memory/presets:${r.params.projectId}`)).value ?? []) as unknown[];
  const next = [...cur, { name: String(r.body.name).slice(0, 40), viewId: r.body.viewId, values: r.body.values }].slice(-20);
  await call('storage', `/memory/presets:${r.params.projectId}`, { method: 'PUT', body: { value: next } });
  return next;
});
app.get<{ Params: { projectId: string } }>('/apps/:projectId/journal', async (r) => call('storage', `/jobs?projectId=${r.params.projectId}`));

/** Backend MCP propre à l'app (Streamable HTTP, sans état). Outils en lecture/simulation uniquement. */
function appServer(projectId: string) {
  const s = new McpServer({ name: `formule-app-${projectId}`, version: '1.0.0' });
  const txt = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }], structuredContent: o as Record<string, unknown> });
  s.registerTool('app__decrire', { description: 'Décrit une vue de l’app (valeur, unité, heure, provenance).', inputSchema: { viewId: z.string() }, annotations: { readOnlyHint: true } },
    async ({ viewId }) => { const v = await version(projectId); const view = v.spec.views.find((x) => x.id === viewId); return txt({ text: view ? describeView(v, view) : 'vue inconnue' }); });
  s.registerTool('app__agreger', { description: 'Recalcule un indicateur agrégé de l’app.', inputSchema: { viewId: z.string() }, annotations: { readOnlyHint: true } },
    async ({ viewId }) => {
      const v = await version(projectId); const view = v.spec.views.find((x) => x.id === viewId);
      if (!view || view.kind !== 'kpi' || !view.bindings.aggregate) return txt({ error: 'indicateur agrégé introuvable' });
      const q = v.bundle.queries[view.queryId];
      return txt(aggregate(q.raw, view.bindings.aggregate, view.bindings.unit, Date.parse(q.envelope.observedAt ?? q.envelope.fetchedAt)));
    });
  s.registerTool('app__simuler', { description: 'Simulation (aucun effet externe).', inputSchema: { viewId: z.string(), variation_pct: z.number(), horizon: z.number() }, annotations: { readOnlyHint: true } },
    async ({ viewId, variation_pct, horizon }) => txt(simulate(await version(projectId), viewId, { variation_pct, horizon })));
  s.registerTool('app__journal', { description: 'Journal des générations de l’app.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => txt({ jobs: await call('storage', `/jobs?projectId=${projectId}`) }));
  return s;
}

app.all<{ Params: { projectId: string } }>('/apps/:projectId/mcp', async (req, reply) => {
  const server = appServer(req.params.projectId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  reply.hijack();
  reply.raw.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req.raw, reply.raw, req.body);
});

await listen(app, 'app-agents');
