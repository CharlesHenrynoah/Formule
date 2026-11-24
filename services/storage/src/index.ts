/**
 * Service de stockage — projets, prompts et versions dans SQLite (fichier).
 * Utilise le module natif node:sqlite (Node >= 22.13) : aucune dépendance native à compiler.
 */
import { BIND_HOST } from './env.ts';
import Fastify from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';


const PORT = Number(process.env.STORAGE_PORT ?? 4003);
const DB_PATH = resolve(process.env.DB_PATH ?? './data/everything.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS versions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    kind TEXT NOT NULL,           -- 'generate' | 'iterate' | 'edit'
    plan TEXT,
    code TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    validation TEXT,              -- JSON
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_versions_project ON versions(project_id, number);
  CREATE TABLE IF NOT EXISTS dashboards (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    spec TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dashboards_project ON dashboards(project_id, position);
  CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL,
    lines TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_generations_started ON generations(started_at);
`);

// Migrations légères : fichiers source de l'agent, trace agent, app (contrat + sous-agent + backend MCP) en JSON
for (const col of ['files', 'agent', 'app']) {
  const cols = db.prepare('PRAGMA table_info(versions)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE versions ADD COLUMN ${col} TEXT`);
}

const now = () => new Date().toISOString();
const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 5 * 1024 * 1024 });

type VersionRow = Record<string, unknown> & { validation?: string | null };
const j = (x: unknown) => (x ? JSON.parse(String(x)) : null);
const parseVersion = (v: VersionRow) => ({ ...v, validation: j(v.validation), files: j(v.files), agent: j(v.agent), app: j(v.app) });

app.get('/health', async () => ({ service: 'storage', status: 'ok', db: DB_PATH }));

app.get('/projects', async () => {
  const rows = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM versions v WHERE v.project_id = p.id) AS version_count,
           (SELECT prompt FROM versions v WHERE v.project_id = p.id ORDER BY number ASC LIMIT 1) AS first_prompt
    FROM projects p ORDER BY updated_at DESC LIMIT 200`).all();
  return rows;
});

app.post<{ Body: { title: string } }>('/projects', async (req, reply) => {
  const { title } = req.body ?? ({} as { title: string });
  if (!title) return reply.code(400).send({ error: 'title requis' });
  const id = randomUUID();
  const t = now();
  db.prepare('INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, title.slice(0, 120), t, t);
  return reply.code(201).send({ id, title, created_at: t, updated_at: t });
});

app.get<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return reply.code(404).send({ error: 'projet introuvable' });
  const versions = db.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY number ASC').all(req.params.id) as VersionRow[];
  return { ...p, versions: versions.map(parseVersion) };
});

app.delete<{ Params: { id: string } }>('/projects/:id', async (req) => {
  db.prepare('DELETE FROM generations WHERE project_id = ?').run(req.params.id);
  db.prepare('DELETE FROM dashboards WHERE project_id = ?').run(req.params.id);
  db.prepare('DELETE FROM versions WHERE project_id = ?').run(req.params.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  return { deleted: true };
});

app.get<{ Params: { id: string } }>('/projects/:id/latest', async (req, reply) => {
  const v = db.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY number DESC LIMIT 1').get(req.params.id) as VersionRow | undefined;
  if (!v) return reply.code(404).send({ error: 'aucune version' });
  return parseVersion(v);
});

type NewVersion = { prompt: string; kind?: string; plan?: string; code: string; provider?: string; model?: string; validation?: unknown; files?: Record<string, string>; agent?: unknown; app?: unknown };
app.post<{ Params: { id: string }; Body: NewVersion }>('/projects/:id/versions', async (req, reply) => {
  const p = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return reply.code(404).send({ error: 'projet introuvable' });
  const b = req.body;
  if (!b?.code || !b?.prompt) return reply.code(400).send({ error: 'prompt et code requis' });
  const { n } = db.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM versions WHERE project_id = ?').get(req.params.id) as { n: number };
  const id = randomUUID();
  const t = now();
  db.prepare(`INSERT INTO versions (id, project_id, number, prompt, kind, plan, code, provider, model, validation, files, agent, app, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, req.params.id, n, b.prompt, b.kind ?? 'generate', b.plan ?? null, b.code, b.provider ?? null, b.model ?? null,
      b.validation ? JSON.stringify(b.validation) : null, b.files ? JSON.stringify(b.files) : null, b.agent ? JSON.stringify(b.agent) : null, b.app ? JSON.stringify(b.app) : null, t);
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(t, req.params.id);
  return reply.code(201).send({ id, project_id: req.params.id, number: n, created_at: t });
});

type DashRow = { id: string; project_id: string; title: string; description: string | null; spec: string; position: number; created_at: string; updated_at: string };
const parseDash = (row: DashRow) => ({ ...row, spec: j(row.spec) });

app.get<{ Params: { id: string } }>('/projects/:id/dashboards', async (req, reply) => {
  const p = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return reply.code(404).send({ error: 'projet introuvable' });
  const rows = db.prepare('SELECT * FROM dashboards WHERE project_id = ? ORDER BY position ASC').all(req.params.id) as DashRow[];
  return rows.map(parseDash);
});

app.put<{ Params: { id: string; dashId: string }; Body: { title?: string; description?: string; spec?: { title?: string; description?: string; charts?: unknown } } }>('/projects/:id/dashboards/:dashId', async (req, reply) => {
  const p = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!p) return reply.code(404).send({ error: 'projet introuvable' });
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(req.params.dashId)) return reply.code(400).send({ error: 'identifiant invalide' });
  const spec = req.body?.spec;
  if (!spec || !Array.isArray(spec.charts) || !spec.charts.length) return reply.code(400).send({ error: 'spec de tableau invalide' });
  const existing = db.prepare('SELECT project_id FROM dashboards WHERE id = ?').get(req.params.dashId) as { project_id: string } | undefined;
  if (existing && existing.project_id !== req.params.id) return reply.code(409).send({ error: 'tableau rattaché à un autre projet' });
  const title = String(spec.title ?? req.body?.title ?? 'Tableau').slice(0, 80);
  const description = String(spec.description ?? req.body?.description ?? '').slice(0, 240);
  const t = now();
  if (existing) {
    db.prepare('UPDATE dashboards SET title = ?, description = ?, spec = ?, updated_at = ? WHERE id = ?').run(title, description, JSON.stringify(spec), t, req.params.dashId);
  } else {
    const { n } = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM dashboards WHERE project_id = ?').get(req.params.id) as { n: number };
    db.prepare('INSERT INTO dashboards (id, project_id, title, description, spec, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.params.dashId, req.params.id, title, description, JSON.stringify(spec), n, t, t);
  }
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(t, req.params.id);
  const row = db.prepare('SELECT * FROM dashboards WHERE id = ?').get(req.params.dashId) as DashRow;
  return parseDash(row);
});

type GenBody = { id?: string; projectId?: string | null; prompt?: string; status?: string; lines?: unknown[]; startedAt?: string; endedAt?: string };
app.post<{ Body: GenBody }>('/generations', async (req, reply) => {
  const b = req.body ?? {};
  if (!b.prompt || !Array.isArray(b.lines)) return reply.code(400).send({ error: 'prompt et lines requis' });
  const id = b.id && /^[a-zA-Z0-9-]{8,64}$/.test(b.id) ? b.id : randomUUID();
  const t = now();
  const lines = b.lines.slice(0, 1600);
  db.prepare(`INSERT INTO generations (id, project_id, prompt, status, lines, started_at, ended_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, status = excluded.status, lines = excluded.lines, ended_at = excluded.ended_at`)
    .run(id, b.projectId || null, String(b.prompt).slice(0, 200), String(b.status ?? 'ok').slice(0, 20), JSON.stringify(lines), b.startedAt ?? t, b.endedAt ?? t);
  return reply.code(201).send({ id, count: lines.length });
});

app.get('/generations', async () => {
  const rows = db.prepare('SELECT id, project_id, prompt, status, started_at, ended_at, lines FROM generations ORDER BY started_at DESC LIMIT 40').all() as Array<{ lines: string } & Record<string, unknown>>;
  return rows.map((row) => {
    const lines = j(row.lines) as Array<{ component?: string }> | null;
    const components = [...new Set((lines ?? []).map((line) => line.component).filter(Boolean))];
    return { id: row.id, project_id: row.project_id, prompt: row.prompt, status: row.status, started_at: row.started_at, ended_at: row.ended_at, count: lines?.length ?? 0, components };
  });
});

app.get<{ Params: { id: string } }>('/generations/:id', async (req, reply) => {
  const row = db.prepare('SELECT * FROM generations WHERE id = ?').get(req.params.id) as ({ lines: string } & Record<string, unknown>) | undefined;
  if (!row) return reply.code(404).send({ error: 'journal introuvable' });
  return { ...row, lines: j(row.lines) ?? [] };
});

app.listen({ port: PORT, host: BIND_HOST }).then(() => console.log(`[storage] prêt sur :${PORT} (db: ${DB_PATH})`));
