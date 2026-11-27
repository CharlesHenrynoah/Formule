import { call, createService, listen } from '@formule/service-kit';
import type { JobEvent } from '@formule/contracts';
import { chat } from './agent/chat.js';
import { cancelJob, decide } from './agent/orchestrator.js';
import { subscribe } from './agent/events.js';
import { isDemoMode, llm, probeLlm, providerConf } from './llm.js';

const app = await createService('ai-engine', () => ({ llm: isDemoMode() ? 'demo' : 'connecté' }));

// Un redémarrage interrompt les jobs non terminés : on le dit, on ne les rejoue pas.
const startedAt = new Date().toISOString();
const pendingStates = ['DRAFT', 'DISCOVERY', 'CONTRACT', 'BUILD', 'CERTIFICATION', 'REPAIR', 'READY'];
setTimeout(async () => {
  try {
    for (const j of await call<{ id: string; state: string; project_id: string | null; created_at: string }[]>('storage', '/jobs')) {
      if (!pendingStates.includes(j.state) || j.created_at >= startedAt) continue;
      await call('storage', `/jobs/${j.id}/transition`, { body: { to: 'FAILED' } }).catch(() => {});
      await call('storage', '/events', { body: { jobId: j.id, projectId: j.project_id, version: null, type: 'error', payload: { message: 'interrompu par un redémarrage du moteur : relance la demande' } } }).catch(() => {});
      await call('storage', '/events', { body: { jobId: j.id, projectId: j.project_id, version: null, type: 'job.done', payload: { state: 'FAILED' } } }).catch(() => {});
    }
  } catch { /* stockage pas encore prêt */ }
}, 1500);

let llmStatus = { ok: false, detail: 'non vérifié' };
setTimeout(() => { void probeLlm().then((r) => { llmStatus = r; console.log(`[ai-engine] LLM : ${r.detail}`); }); }, 500);
// Le Studio n'affiche pas le modèle : seulement « Démo » quand aucune clé n'est configurée.
app.get('/meta', async () => ({ demo: isDemoMode(), provider: llm.name === 'mock' ? 'démo' : 'configuré' }));
app.get('/llm', async () => ({ configured: !!providerConf(), provider: providerConf()?.label ?? null, model: providerConf()?.model ?? null, ...llmStatus }));
app.post<{ Body: { projectId?: string | null; mode?: 'ask' | 'agent'; message: string; fileIds?: string[]; version?: number } }>('/chat', async (r) =>
  chat({ projectId: r.body.projectId ?? null, mode: r.body.mode === 'agent' ? 'agent' : 'ask', message: String(r.body.message ?? ''), fileIds: r.body.fileIds ?? [], version: r.body.version }));
app.post<{ Params: { id: string } }>('/jobs/:id/approve', async (r) => ({ ok: decide(r.params.id, true) }));
app.post<{ Params: { id: string } }>('/jobs/:id/reject', async (r) => ({ ok: decide(r.params.id, false) }));
app.post<{ Params: { id: string } }>('/jobs/:id/cancel', async (r) => ({ ok: cancelJob(r.params.id) }));

/** SSE ordonné par seq. Reconnexion (Last-Event-ID) = reprise de l'état réel, jamais un second job. */
app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/jobs/:id/events', async (req, reply) => {
  const after = Number(req.headers['last-event-id'] ?? req.query.after ?? 0) || 0;
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  let last = after; const queue: JobEvent[] = []; let replaying = true; let done = false;
  const send = (e: JobEvent) => {
    if (e.seq <= last) return;
    last = e.seq;
    res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    if (e.type === 'job.done') { done = true; setTimeout(() => res.end(), 50); }
  };
  const unsub = subscribe(req.params.id, (e) => (replaying ? queue.push(e) : send(e)));
  for (const e of await call<JobEvent[]>('storage', `/jobs/${req.params.id}/events?after=${after}`)) send(e);
  replaying = false; queue.sort((a, b) => a.seq - b.seq).forEach(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.raw.on('close', () => { clearInterval(ping); unsub(); });
  if (done) { clearInterval(ping); unsub(); }
});

await listen(app, 'ai-engine');
