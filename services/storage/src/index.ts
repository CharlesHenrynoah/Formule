import path from 'node:path';
import { createService, dataDir, listen } from '@formule/service-kit';
import { Store } from './db.js';

const store = new Store(path.join(dataDir(), 'formule.sqlite'));
const app = await createService('storage', () => ({ sqlite: 'node:sqlite' }));
type P = { id: string; n: string; key: string };
type B = Record<string, any>;

app.get('/projects', async () => store.listProjects());
app.post<{ Body: B }>('/projects', async (r) => store.createProject(String(r.body.title ?? 'Sans titre'), !!r.body.demo));
app.get<{ Params: P }>('/projects/:id', async (r, reply) => store.getProject(r.params.id) ?? reply.code(404).send({ code: 'not_found', message: 'projet introuvable' }));
app.patch<{ Params: P; Body: B }>('/projects/:id', async (r) => store.updateProject(r.params.id, r.body));
app.delete<{ Params: P }>('/projects/:id', async (r) => ({ deleted: store.deleteProject(r.params.id) }));
app.post<{ Params: P }>('/projects/:id/duplicate', async (r) => store.duplicateProject(r.params.id));
app.get<{ Params: P }>('/projects/:id/export', async (r) => ({
  format: 'formule-export/1', project: store.getProject(r.params.id),
  versions: store.listVersions(r.params.id).map((v: any) => store.getVersion(r.params.id, v.n)),
  messages: store.messages(r.params.id),
}));

app.get<{ Params: P }>('/projects/:id/versions', async (r) => store.listVersions(r.params.id));
app.get<{ Params: P }>('/projects/:id/versions/active', async (r) => store.activeVersion(r.params.id) ?? store.latestVersion(r.params.id));
app.get<{ Params: P }>('/projects/:id/versions/:n', async (r, reply) => store.getVersion(r.params.id, Number(r.params.n)) ?? reply.code(404).send({ code: 'not_found', message: 'version introuvable' }));
app.post<{ Params: P; Body: B }>('/projects/:id/versions', async (r) => ({ n: store.addCandidate(r.params.id, r.body as any) }));
app.post<{ Params: P; Body: B }>('/projects/:id/versions/:n/promote', async (r) => store.promote(r.params.id, Number(r.params.n), r.body.kind));
app.post<{ Params: P }>('/projects/:id/versions/:n/reject', async (r) => { store.reject(r.params.id, Number(r.params.n)); return { ok: true }; });
app.post<{ Params: P }>('/projects/:id/versions/:n/restore', async (r) => store.restore(r.params.id, Number(r.params.n)));

app.get<{ Querystring: { projectId?: string } }>('/jobs', async (r) => store.listJobs(r.query.projectId));
app.post<{ Body: B }>('/jobs', async (r) => store.createJob(r.body as any));
app.get<{ Params: P }>('/jobs/:id', async (r, reply) => store.getJob(r.params.id) ?? reply.code(404).send({ code: 'not_found', message: 'job introuvable' }));
app.post<{ Params: P; Body: B }>('/jobs/:id/transition', async (r) => store.transition(r.params.id, r.body.to));
app.patch<{ Params: P; Body: B }>('/jobs/:id', async (r) => store.patchJob(r.params.id, r.body));
app.post<{ Body: B }>('/events', async (r) => store.appendEvent(r.body as any));
app.get<{ Params: P; Querystring: { after?: string } }>('/jobs/:id/events', async (r) => store.events(r.params.id, Number(r.query.after ?? 0)));

app.post<{ Body: B }>('/snapshots', async (r) => store.putSnapshot(r.body as any));
app.get<{ Params: P }>('/snapshots/:id', async (r, reply) => store.getSnapshot(r.params.id) ?? reply.code(404).send({ code: 'not_found', message: 'snapshot introuvable' }));
app.post<{ Params: P; Body: B }>('/jobs/:id/attach', async (r) => { store.attachSnapshots(r.params.id, r.body.projectId); return { ok: true }; });

app.get<{ Params: P }>('/projects/:id/messages', async (r) => store.messages(r.params.id));
app.post<{ Params: P; Body: B }>('/projects/:id/messages', async (r) => store.addMessage(r.params.id, r.body.role, r.body.content));

app.get('/files', async () => store.listFiles());
app.post<{ Body: B }>('/files', async (r) => store.addFile(r.body as any));
app.get<{ Params: P }>('/files/:id', async (r, reply) => store.getFile(r.params.id) ?? reply.code(404).send({ code: 'not_found', message: 'fichier introuvable' }));

app.post<{ Body: B }>('/ops', async (r) => store.createOp(r.body as any));
app.get<{ Params: P }>('/ops/:id', async (r, reply) => store.getOp(r.params.id) ?? reply.code(404).send({ code: 'not_found', message: 'opération introuvable' }));
app.patch<{ Params: P; Body: B }>('/ops/:id', async (r) => store.updateOp(r.params.id, r.body as any));

app.get<{ Params: P }>('/memory/:key', async (r) => ({ value: store.getMemory(r.params.key) }));
app.put<{ Params: P; Body: B }>('/memory/:key', async (r) => { store.setMemory(r.params.key, r.body.value); return { ok: true }; });

await listen(app, 'storage');
