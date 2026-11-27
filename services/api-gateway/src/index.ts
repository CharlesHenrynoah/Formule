import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { call, createService, findRepoRoot, listen, PORTS, serviceUrl, ServiceError, type ServiceName } from '@formule/service-kit';
import { humanKey } from '@formule/service-kit/secrets';
import type { AppSpec } from '@formule/contracts';
import { APP_CSP, decideBridge, bridgeWhitelist } from './bridge.js';
import { RateLimiter } from './ratelimit.js';

const app = await createService('api-gateway', undefined, { defaultHealth: false });
const limiter = new RateLimiter(60, 60_000);
type B = Record<string, any>;

// ---------- Basic Auth en mode public ----------
if (process.env.FORMULE_PUBLIC === '1') {
  const user = process.env.FORMULE_BASIC_USER ?? 'formule';
  const pass = process.env.FORMULE_BASIC_PASS;
  if (!pass) throw new Error('FORMULE_PUBLIC=1 exige FORMULE_BASIC_PASS');
  const expected = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/health') return;
    if (req.headers.authorization !== expected) { reply.header('www-authenticate', 'Basic realm="Formule"'); return reply.code(401).send({ code: 'auth', message: 'authentification requise' }); }
  });
}

// ---------- Health agrégé ----------
app.get('/health', async (_r, reply) => {
  const names = (Object.keys(PORTS) as ServiceName[]).filter((n) => n !== 'api-gateway');
  const results = await Promise.all(names.map(async (n) => {
    try { const h = await call<Record<string, unknown>>(n, '/health', { timeoutMs: 3000 }); return [n, { status: 'ok', ...h }]; }
    catch (e) { return [n, { status: 'down', message: (e as Error).message }]; }
  }));
  const services = Object.fromEntries(results);
  const ok = results.every(([, v]) => (v as { status: string }).status === 'ok');
  reply.code(ok ? 200 : 503);
  return { service: 'api-gateway', status: ok ? 'ok' : 'degraded', time: new Date().toISOString(), services };
});

// ---------- Projets (routes explicites : le navigateur n'atteint jamais les routes internes) ----------
app.get('/api/projects', async () => call('storage', '/projects'));
app.patch<{ Params: { id: string }; Body: B }>('/api/projects/:id', async (r) => call('storage', `/projects/${r.params.id}`, { method: 'PATCH', body: { title: r.body.title, archived: r.body.archived } }));
app.delete<{ Params: { id: string }; Body: B }>('/api/projects/:id', async (r) => {
  if (r.body?.confirm !== true) throw new ServiceError(428, 'confirmation_required', 'suppression : confirmation requise');
  return call('storage', `/projects/${r.params.id}`, { method: 'DELETE' });
});
app.post<{ Params: { id: string } }>('/api/projects/:id/duplicate', async (r) => call('storage', `/projects/${r.params.id}/duplicate`, { body: {} }));
app.get<{ Params: { id: string } }>('/api/projects/:id/export', async (r, reply) => { reply.header('content-disposition', `attachment; filename="formule-${r.params.id}.json"`); return call('storage', `/projects/${r.params.id}/export`); });
app.get<{ Params: { id: string } }>('/api/projects/:id/versions', async (r) => call('storage', `/projects/${r.params.id}/versions`));
app.get<{ Params: { id: string } }>('/api/projects/:id/messages', async (r) => call('storage', `/projects/${r.params.id}/messages`));
app.get<{ Params: { id: string } }>('/api/projects/:id', async (r) => call('storage', `/projects/${r.params.id}`));
app.post<{ Params: { id: string; n: string } }>('/api/projects/:id/versions/:n/restore', async (r) => call('storage', `/projects/${r.params.id}/versions/${Number(r.params.n)}/restore`, { body: {} }));
app.get<{ Params: { id: string; n: string } }>('/api/projects/:id/versions/:n', async (r) => {
  const v = await call<B>('storage', `/projects/${r.params.id}/versions/${Number(r.params.n)}`);
  // la page Studio n'a pas besoin du HTML ni des bruts : seulement les métadonnées
  return { n: v.n, status: v.status, created_at: v.created_at, was_certified: v.was_certified, certification: v.certification, spec: v.spec, hasHtml: !!v.html };
});

// ---------- App générée : servie avec une CSP stricte, affichée dans une iframe sandbox sans allow-same-origin ----------
app.get<{ Params: { id: string; n: string } }>('/apps/:id/:n/index.html', async (r, reply) => {
  const v = await call<B>('storage', `/projects/${r.params.id}/versions/${Number(r.params.n)}`);
  if (!v.html) throw new ServiceError(404, 'no_html', 'aucun bundle pour cette version');
  reply.header('content-security-policy', APP_CSP).header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer').header('cache-control', 'no-store');
  reply.type('text/html; charset=utf-8');
  return v.html;
});

// ---------- Conversation & jobs ----------
app.get('/api/meta', async () => {
  const ai = await call<B>('ai-engine', '/meta').catch(() => ({ demo: true }));
  const voice = await call<B>('voice-gateway', '/health').catch(() => null);
  return { demo: ai.demo, voice: voice ? { stt: voice.stt, tts: voice.tts } : null };
});
app.post<{ Body: B }>('/api/chat', async (r) => call('ai-engine', '/chat', { body: { projectId: r.body.projectId ?? null, mode: r.body.mode, message: r.body.message, fileIds: (r.body.fileIds ?? []).slice(0, 3), version: r.body.version }, timeoutMs: 90_000 }));
app.get<{ Querystring: { projectId?: string } }>('/api/jobs', async (r) => call('storage', `/jobs${r.query.projectId ? `?projectId=${encodeURIComponent(r.query.projectId)}` : ''}`));
app.get<{ Params: { id: string } }>('/api/jobs/:id', async (r) => call('storage', `/jobs/${r.params.id}`));
app.get<{ Params: { id: string } }>('/api/jobs/:id/log', async (r) => call('storage', `/jobs/${r.params.id}/events`));
for (const a of ['approve', 'reject', 'cancel']) app.post<{ Params: { id: string } }>(`/api/jobs/:id/${a}`, async (r) => call('ai-engine', `/jobs/${r.params.id}/${a}`, { body: {} }));

/** Proxy SSE en flux continu (Last-Event-ID transmis pour la reprise). */
app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/jobs/:id/events', async (req, reply) => {
  const ctrl = new AbortController();
  const lastId = req.headers['last-event-id'] ?? req.query.after ?? '0';
  const upstream = await fetch(`${serviceUrl('ai-engine')}/jobs/${encodeURIComponent(req.params.id)}/events?after=${encodeURIComponent(String(lastId))}`, { signal: ctrl.signal, headers: { 'last-event-id': String(lastId) } }).catch(() => null);
  if (!upstream?.ok || !upstream.body) throw new ServiceError(503, 'unavailable', 'flux de construction indisponible');
  reply.hijack();
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  req.raw.on('close', () => ctrl.abort());
  try { for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) reply.raw.write(chunk); } catch { /* client parti */ }
  reply.raw.end();
});

// ---------- MCP ----------
app.get('/api/mcp/servers', async () => call('mcp-hub', '/servers'));
app.get('/api/mcp/catalog', async () => call('mcp-hub', '/catalog', { timeoutMs: 40_000 }));
app.post<{ Body: B }>('/api/mcp/servers', async (r) => call('mcp-hub', '/servers', { body: r.body }));
app.patch<{ Params: { id: string }; Body: B }>('/api/mcp/servers/:id', async (r) => call('mcp-hub', `/servers/${r.params.id}`, { method: 'PATCH', body: r.body }));
app.delete<{ Params: { id: string } }>('/api/mcp/servers/:id', async (r) => call('mcp-hub', `/servers/${r.params.id}`, { method: 'DELETE' }));
app.post<{ Params: { id: string } }>('/api/mcp/servers/:id/reconnect', async (r) => call('mcp-hub', `/servers/${r.params.id}/reconnect`, { body: {} }));

// ---------- Fichiers joints (restent sur la machine) ----------
app.post<{ Body: { name: string; content: string } }>('/api/files', async (r) => {
  const name = String(r.body.name ?? '').slice(0, 120);
  const content = String(r.body.content ?? '');
  if (content.length > 5 * 1024 * 1024) throw new ServiceError(413, 'too_large', 'fichier > 5 Mo');
  const kind = /\.json$/i.test(name) ? 'json' : /\.csv$/i.test(name) ? 'csv' : null;
  if (!kind) throw new ServiceError(400, 'bad_type', 'CSV ou JSON uniquement');
  let rows = 0;
  if (kind === 'json') { let parsed: unknown; try { parsed = JSON.parse(content); } catch { throw new ServiceError(400, 'bad_json', 'JSON invalide'); } rows = Array.isArray(parsed) ? parsed.length : 1; }
  else rows = Math.max(0, content.replace(/\r/g, '').split('\n').filter((l) => l.trim()).length - 1);
  return call('storage', '/files', { body: { name, kind, rows, content } });
});

// ---------- Pont d'exécution des apps ----------
async function versionSpec(projectId: string, n: number) {
  const v = await call<{ spec: AppSpec; status: string; was_certified: boolean }>('storage', `/projects/${projectId}/versions/${n}`);
  return v;
}
app.post<{ Params: { id: string; n: string }; Body: { method: 'call' | 'tools'; name?: string; args?: unknown } }>('/api/bridge/:id/:n', async (r, reply) => {
  const v = await versionSpec(r.params.id, Number(r.params.n));
  if (r.body.method === 'tools') return { tools: bridgeWhitelist(v.spec) };
  if (!limiter.take(`${r.params.id}`)) return reply.code(429).send({ code: 'rate_limited', message: '60 appels/min dépassés' });
  const d = decideBridge(v.spec, String(r.body.name), r.body.args ?? {});
  if (!d.ok) return reply.code(d.status).send({ code: 'bridge_refused', message: d.message });
  if (d.target === 'hub') return call('mcp-hub', '/call', { body: { serverId: d.serverId, tool: d.tool, args: r.body.args ?? {}, paginate: d.paginate, projectId: r.params.id } });
  const a = r.body.args as B;
  if (d.tool === 'app__simuler') return call('app-agents', `/apps/${r.params.id}/simulate`, { body: { viewId: a.viewId, params: { variation_pct: Number(a.variation_pct ?? 0), horizon: Number(a.horizon ?? 7) }, version: Number(r.params.n) } });
  if (d.tool === 'app__journal') return call('app-agents', `/apps/${r.params.id}/journal`);
  return call('app-agents', `/apps/${r.params.id}/agent`, { body: { message: String(a.viewId ?? ''), mode: 'ask', version: Number(r.params.n) } });
});

// ---------- Actions : préparer → montrer → confirmer (humain) → exécuter → vérifier → journaliser ----------
app.post<{ Body: { projectId: string; version: number; actionId: string; args: B } }>('/api/actions/prepare', async (r) => {
  const v = await versionSpec(r.body.projectId, Number(r.body.version));
  if (v.status !== 'ACTIVE' || !v.was_certified) throw new ServiceError(403, 'not_certified', 'Aperçu non certifié : aucune action externe.');
  const action = v.spec.actions.find((a) => a.id === r.body.actionId);
  if (!action) throw new ServiceError(404, 'unknown_action', 'action inconnue');
  const args = { ...(r.body.args ?? {}), ...action.fixedArgs };
  const allowed = new Set([...action.fields.map((f) => f.name), ...Object.keys(action.fixedArgs)]);
  for (const k of Object.keys(args)) if (!allowed.has(k)) throw new ServiceError(400, 'bad_args', `argument non déclaré : ${k}`);
  const op = await call<B>('mcp-hub', '/ops/prepare', { body: { serverId: action.serverId, tool: action.tool, args, projectId: r.body.projectId } });
  const card = { opId: op.opId, label: action.label, effect: action.effect, server: op.serverName, tool: action.tool, args, demo: op.demo, status: 'pending' };
  await call('storage', `/projects/${r.body.projectId}/messages`, { body: { role: 'agent', content: { text: `Action préparée : ${action.label}. Rien ne part sans ton « Oui, exécuter ».`, card } } });
  return { card };
});

app.post<{ Params: { opId: string }; Body: { args: B; projectId?: string; via?: 'click' | 'voice' } }>('/api/actions/:opId/execute', async (r, reply) => {
  // Le jeton de confirmation est lié aux arguments EXACTS affichés : toute modification l'invalide (428).
  const conf = await call<{ token: string }>('mcp-hub', `/ops/${r.params.opId}/confirm`, { body: { args: r.body.args }, headers: { 'x-formule-human': humanKey() } });
  try {
    const res = await call<B>('mcp-hub', `/ops/${r.params.opId}/execute`, { body: { token: conf.token, args: r.body.args }, timeoutMs: 60_000 });
    const text = `Exécuté et vérifié : ${res.envelope.tool} à ${new Date(res.envelope.observedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} (${res.envelope.source.serverName}${res.envelope.source.demo ? ', démo' : ''}). Résultat : ${JSON.stringify(res.raw).slice(0, 200)}`;
    if (r.body.projectId) await call('storage', `/projects/${r.body.projectId}/messages`, { body: { role: 'agent', content: { text, opId: r.params.opId, opStatus: 'done', via: r.body.via ?? 'click' } } });
    return { status: 'done', text, result: res.raw };
  } catch (e) {
    const err = e as ServiceError;
    if (r.body.projectId) await call('storage', `/projects/${r.body.projectId}/messages`, { body: { role: 'agent', content: { text: err.message, opId: r.params.opId, opStatus: err.code } } });
    return reply.code(err.status ?? 502).send({ code: err.code, message: err.message });
  }
});
app.post<{ Params: { opId: string }; Body: { projectId?: string } }>('/api/actions/:opId/decline', async (r) => {
  await call('storage', `/ops/${r.params.opId}`, { method: 'PATCH', body: { status: 'declined', expect: 'prepared' } });
  if (r.body?.projectId) await call('storage', `/projects/${r.body.projectId}/messages`, { body: { role: 'agent', content: { text: 'Action refusée. Rien n’est parti.', opId: r.params.opId, opStatus: 'declined' } } });
  return { status: 'declined' };
});

// ---------- Voix ----------
app.post<{ Body: B }>('/api/voice/confirmation', async (r) => call('voice-gateway', '/interpret/confirmation', { body: r.body }));
app.post<{ Body: B }>('/api/voice/wake', async (r) => call('voice-gateway', '/interpret/wake', { body: r.body }));

// ---------- Studio compilé (mode start / Docker) ----------
const dist = path.join(findRepoRoot(), 'frontend/dist');
if (process.env.FORMULE_SERVE_STUDIO === '1' && existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist, prefix: '/' });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api') ? reply.code(404).send({ code: 'not_found', message: 'route inconnue' }) : reply.type('text/html').send(readFileSync(path.join(dist, 'index.html')))));
}

await listen(app, 'api-gateway');
