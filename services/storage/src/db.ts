import { DatabaseSync } from 'node:sqlite';
import { assertTransition, type JobKind, type JobState } from '@formule/contracts';
import { newId } from '@formule/contracts/node';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0, active_version INTEGER, latest_version INTEGER NOT NULL DEFAULT 0, demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS versions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, n INTEGER NOT NULL,
  status TEXT NOT NULL, spec TEXT NOT NULL, html TEXT, bundle TEXT, certification TEXT, job_id TEXT,
  parent_n INTEGER, created_at TEXT NOT NULL, was_certified INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, n)
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, project_id TEXT, kind TEXT NOT NULL, state TEXT NOT NULL, mode TEXT NOT NULL,
  prompt TEXT NOT NULL, awaiting TEXT, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, project_id TEXT, version INTEGER, seq INTEGER NOT NULL,
  type TEXT NOT NULL, ts TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(job_id, seq)
);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY, project_id TEXT, job_id TEXT, envelope TEXT NOT NULL, raw TEXT, hash TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, role TEXT NOT NULL,
  content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, rows INTEGER NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ops (
  id TEXT PRIMARY KEY, op_hash TEXT NOT NULL, project_id TEXT, server_id TEXT NOT NULL, tool TEXT NOT NULL,
  args TEXT NOT NULL, status TEXT NOT NULL, idempotency_key TEXT UNIQUE, nonce TEXT UNIQUE, result TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory ( key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL );
`;

const now = () => new Date().toISOString();
const j = (s: unknown) => (s == null ? null : JSON.parse(String(s)));

export class Store {
  db: DatabaseSync;
  constructor(file: string) { this.db = new DatabaseSync(file); this.db.exec(SCHEMA); }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ---------- projets ----------
  listProjects() {
    return this.db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM versions v WHERE v.project_id = p.id) AS version_count FROM projects p ORDER BY updated_at DESC`).all();
  }
  getProject(id: string) { return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) ?? null; }
  createProject(title: string, demo: boolean) {
    const id = newId('prj'); const t = now();
    this.db.prepare('INSERT INTO projects (id, title, created_at, updated_at, demo) VALUES (?,?,?,?,?)').run(id, title, t, t, demo ? 1 : 0);
    return this.getProject(id);
  }
  updateProject(id: string, patch: { title?: string; archived?: boolean }) {
    if (patch.title !== undefined) this.db.prepare('UPDATE projects SET title = ?, updated_at = ? WHERE id = ?').run(patch.title.slice(0, 80), now(), id);
    if (patch.archived !== undefined) this.db.prepare('UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?').run(patch.archived ? 1 : 0, now(), id);
    return this.getProject(id);
  }
  deleteProject(id: string) {
    return this.tx(() => {
      this.db.prepare('DELETE FROM snapshots WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM events WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM jobs WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM ops WHERE project_id = ?').run(id);
      return this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
    });
  }
  duplicateProject(id: string) {
    const p = this.getProject(id) as Record<string, unknown> | null;
    if (!p) return null;
    const active = this.activeVersion(id) ?? this.latestVersion(id);
    return this.tx(() => {
      const copy = this.createProject(`${p.title} (copie)`, !!p.demo) as { id: string };
      if (active) {
        const v = active as Record<string, unknown>;
        this.db.prepare('INSERT INTO versions (project_id, n, status, spec, html, bundle, certification, job_id, parent_n, created_at, was_certified) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(copy.id, 1, v.status === 'ACTIVE' ? 'ACTIVE' : String(v.status), JSON.stringify(v.spec), (v.html as string) ?? null, JSON.stringify(v.bundle), JSON.stringify(v.certification), null, null, now(), v.was_certified ? 1 : 0);
        this.db.prepare('UPDATE projects SET latest_version = 1, active_version = ? WHERE id = ?').run(v.status === 'ACTIVE' ? 1 : null, copy.id);
      }
      return this.getProject(copy.id);
    });
  }

  // ---------- versions ----------
  private rowToVersion(r: Record<string, unknown> | undefined) {
    if (!r) return null;
    return { ...r, spec: j(r.spec), bundle: j(r.bundle), certification: j(r.certification), was_certified: !!r.was_certified };
  }
  listVersions(projectId: string) {
    return this.db.prepare('SELECT project_id, n, status, certification, job_id, parent_n, created_at, was_certified FROM versions WHERE project_id = ? ORDER BY n').all(projectId)
      .map((r) => ({ ...r, certification: j(r.certification), was_certified: !!r.was_certified }));
  }
  getVersion(projectId: string, n: number) { return this.rowToVersion(this.db.prepare('SELECT * FROM versions WHERE project_id = ? AND n = ?').get(projectId, n) as Record<string, unknown>); }
  activeVersion(projectId: string) {
    const p = this.getProject(projectId) as { active_version: number | null } | null;
    return p?.active_version ? this.getVersion(projectId, p.active_version) : null;
  }
  latestVersion(projectId: string) {
    return this.rowToVersion(this.db.prepare('SELECT * FROM versions WHERE project_id = ? ORDER BY n DESC LIMIT 1').get(projectId) as Record<string, unknown>);
  }
  addCandidate(projectId: string, v: { spec: unknown; html: string | null; bundle: unknown; certification: unknown; jobId: string; parentN: number | null }) {
    return this.tx(() => {
      const p = this.getProject(projectId) as { latest_version: number } | null;
      if (!p) throw Object.assign(new Error('projet introuvable'), { status: 404 });
      const n = p.latest_version + 1;
      this.db.prepare('INSERT INTO versions (project_id, n, status, spec, html, bundle, certification, job_id, parent_n, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(projectId, n, 'CANDIDATE', JSON.stringify(v.spec), v.html, JSON.stringify(v.bundle), JSON.stringify(v.certification), v.jobId, v.parentN, now());
      this.db.prepare('UPDATE projects SET latest_version = ?, updated_at = ? WHERE id = ?').run(n, now(), projectId);
      return n;
    });
  }
  /**
   * Promotion atomique. Seule une version certifiée devient ACTIVE.
   * Une version partielle n'est publiée que s'il n'existe aucune version certifiée active.
   */
  promote(projectId: string, n: number, kind: 'certified' | 'partial') {
    return this.tx(() => {
      const v = this.getVersion(projectId, n) as { status: string; certification: { certified: boolean } } | null;
      if (!v) throw Object.assign(new Error('version introuvable'), { status: 404 });
      if (v.status !== 'CANDIDATE') throw Object.assign(new Error(`version ${n} non candidate (${v.status})`), { status: 409 });
      if (kind === 'certified' && !v.certification?.certified) throw Object.assign(new Error('promotion refusée : version non certifiée'), { status: 409 });
      const active = this.activeVersion(projectId) as { n: number; was_certified: boolean } | null;
      if (kind === 'partial' && active?.was_certified) {
        this.db.prepare("UPDATE versions SET status = 'REJECTED' WHERE project_id = ? AND n = ?").run(projectId, n);
        return { promoted: false, reason: 'une version certifiée existe : la version partielle reste un aperçu non promu', active: active.n };
      }
      if (active) this.db.prepare("UPDATE versions SET status = 'SUPERSEDED' WHERE project_id = ? AND n = ?").run(projectId, active.n);
      this.db.prepare('UPDATE versions SET status = ?, was_certified = ? WHERE project_id = ? AND n = ?').run(kind === 'certified' ? 'ACTIVE' : 'PARTIAL', kind === 'certified' ? 1 : 0, projectId, n);
      this.db.prepare('UPDATE projects SET active_version = ?, updated_at = ? WHERE id = ?').run(n, now(), projectId);
      return { promoted: true, active: n };
    });
  }
  reject(projectId: string, n: number) {
    this.db.prepare("UPDATE versions SET status = 'REJECTED' WHERE project_id = ? AND n = ? AND status = 'CANDIDATE'").run(projectId, n);
  }
  /** Restauration : seule une version déjà publiée (certifiée ou partielle) peut redevenir active. */
  restore(projectId: string, n: number) {
    return this.tx(() => {
      const v = this.getVersion(projectId, n) as { status: string; was_certified: boolean } | null;
      if (!v) throw Object.assign(new Error('version introuvable'), { status: 404 });
      if (!['SUPERSEDED', 'ACTIVE', 'PARTIAL'].includes(v.status)) throw Object.assign(new Error('seule une version déjà publiée peut être restaurée'), { status: 409 });
      const active = this.activeVersion(projectId) as { n: number } | null;
      if (active && active.n !== n) this.db.prepare("UPDATE versions SET status = 'SUPERSEDED' WHERE project_id = ? AND n = ?").run(projectId, active.n);
      this.db.prepare('UPDATE versions SET status = ? WHERE project_id = ? AND n = ?').run(v.was_certified ? 'ACTIVE' : 'PARTIAL', projectId, n);
      this.db.prepare('UPDATE projects SET active_version = ?, updated_at = ? WHERE id = ?').run(n, now(), projectId);
      return { active: n };
    });
  }

  // ---------- jobs ----------
  createJob(input: { projectId: string | null; kind: JobKind; mode: string; prompt: string }) {
    const id = newId('job'); const t = now();
    this.db.prepare('INSERT INTO jobs (id, project_id, kind, state, mode, prompt, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, input.projectId, input.kind, 'DRAFT', input.mode, input.prompt, t, t);
    return this.getJob(id);
  }
  getJob(id: string) {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? { ...r, awaiting: j(r.awaiting), result: j(r.result) } : null;
  }
  listJobs(projectId?: string) {
    const rows = projectId ? this.db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 100').all(projectId) : this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100').all();
    return rows.map((r) => ({ ...r, awaiting: j(r.awaiting), result: j(r.result) }));
  }
  /** Transition vérifiée par le code (contrats), jamais par le modèle. */
  transition(id: string, to: JobState) {
    return this.tx(() => {
      const job = this.getJob(id) as { kind: JobKind; state: JobState } | null;
      if (!job) throw Object.assign(new Error('job introuvable'), { status: 404 });
      try { assertTransition(job.kind, job.state, to); } catch (e) { throw Object.assign(e as Error, { status: 409, code: 'invalid_transition' }); }
      this.db.prepare('UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?').run(to, now(), id);
      return this.getJob(id);
    });
  }
  patchJob(id: string, patch: { awaiting?: unknown; result?: unknown; projectId?: string }) {
    if ('awaiting' in patch) this.db.prepare('UPDATE jobs SET awaiting = ?, updated_at = ? WHERE id = ?').run(patch.awaiting == null ? null : JSON.stringify(patch.awaiting), now(), id);
    if ('result' in patch) this.db.prepare('UPDATE jobs SET result = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(patch.result), now(), id);
    if (patch.projectId) this.db.prepare('UPDATE jobs SET project_id = ? WHERE id = ?').run(patch.projectId, id);
    return this.getJob(id);
  }

  // ---------- événements (seq attribué atomiquement) ----------
  appendEvent(e: { jobId: string; projectId: string | null; version: number | null; type: string; payload: unknown }) {
    return this.tx(() => {
      const last = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE job_id = ?').get(e.jobId) as { m: number };
      const ev = { eventId: newId('evt'), jobId: e.jobId, projectId: e.projectId, version: e.version, seq: last.m + 1, type: e.type, timestamp: now(), payload: e.payload };
      this.db.prepare('INSERT INTO events (event_id, job_id, project_id, version, seq, type, ts, payload) VALUES (?,?,?,?,?,?,?,?)')
        .run(ev.eventId, ev.jobId, ev.projectId, ev.version, ev.seq, ev.type, ev.timestamp, JSON.stringify(ev.payload));
      return ev;
    });
  }
  events(jobId: string, after = 0) {
    return this.db.prepare('SELECT * FROM events WHERE job_id = ? AND seq > ? ORDER BY seq').all(jobId, after).map((r) => ({
      eventId: r.event_id, jobId: r.job_id, projectId: r.project_id, version: r.version, seq: r.seq, type: r.type, timestamp: r.ts, payload: j(r.payload),
    }));
  }

  // ---------- snapshots ----------
  putSnapshot(s: { envelope: { id: string; hash: string | null }; raw: string | null; projectId: string | null; jobId: string | null }) {
    this.db.prepare('INSERT INTO snapshots (id, project_id, job_id, envelope, raw, hash, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(s.envelope.id, s.projectId, s.jobId, JSON.stringify(s.envelope), s.raw, s.envelope.hash, now());
    return { id: s.envelope.id };
  }
  getSnapshot(id: string) {
    const r = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? { id: r.id, projectId: r.project_id, envelope: j(r.envelope), raw: r.raw == null ? null : JSON.parse(String(r.raw)), rawBytes: r.raw, hash: r.hash } : null;
  }
  attachSnapshots(jobId: string, projectId: string) { this.db.prepare('UPDATE snapshots SET project_id = ? WHERE job_id = ?').run(projectId, jobId); }

  // ---------- conversation ----------
  messages(projectId: string) { return this.db.prepare('SELECT * FROM messages WHERE project_id = ? ORDER BY created_at, rowid').all(projectId).map((r) => ({ ...r, content: j(r.content) })); }
  addMessage(projectId: string, role: string, content: unknown) {
    const id = newId('msg');
    this.db.prepare('INSERT INTO messages (id, project_id, role, content, created_at) VALUES (?,?,?,?,?)').run(id, projectId, role, JSON.stringify(content), now());
    return { id };
  }

  // ---------- fichiers locaux ----------
  addFile(f: { name: string; kind: string; rows: number; content: string }) {
    const id = newId('fil');
    this.db.prepare('INSERT INTO files (id, name, kind, rows, content, created_at) VALUES (?,?,?,?,?,?)').run(id, f.name, f.kind, f.rows, f.content, now());
    return { id, name: f.name, kind: f.kind, rows: f.rows };
  }
  listFiles() { return this.db.prepare('SELECT id, name, kind, rows, created_at FROM files ORDER BY created_at DESC').all(); }
  getFile(id: string) { return this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) ?? null; }

  // ---------- opérations d'écriture ----------
  createOp(o: { opHash: string; projectId: string | null; serverId: string; tool: string; args: unknown }) {
    const id = newId('op'); const t = now();
    this.db.prepare('INSERT INTO ops (id, op_hash, project_id, server_id, tool, args, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, o.opHash, o.projectId, o.serverId, o.tool, JSON.stringify(o.args), 'prepared', t, t);
    return this.getOp(id);
  }
  getOp(id: string) {
    const r = this.db.prepare('SELECT * FROM ops WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? { ...r, args: j(r.args), result: j(r.result) } : null;
  }
  /** Transition d'op : un nonce de confirmation n'est consommable qu'une fois. */
  updateOp(id: string, patch: { status: string; nonce?: string; idempotencyKey?: string; result?: unknown; expect?: string }) {
    return this.tx(() => {
      const cur = this.getOp(id) as { status: string } | null;
      if (!cur) throw Object.assign(new Error('opération introuvable'), { status: 404 });
      if (patch.expect && cur.status !== patch.expect) throw Object.assign(new Error(`opération dans l'état ${cur.status}`), { status: 409, code: 'op_state' });
      try {
        this.db.prepare('UPDATE ops SET status = ?, nonce = COALESCE(?, nonce), idempotency_key = COALESCE(?, idempotency_key), result = COALESCE(?, result), updated_at = ? WHERE id = ?')
          .run(patch.status, patch.nonce ?? null, patch.idempotencyKey ?? null, patch.result === undefined ? null : JSON.stringify(patch.result), now(), id);
      } catch { throw Object.assign(new Error('confirmation déjà utilisée'), { status: 409, code: 'replay' }); }
      return this.getOp(id);
    });
  }

  // ---------- mémoire ----------
  getMemory(key: string) { const r = this.db.prepare('SELECT value FROM memory WHERE key = ?').get(key) as { value: string } | undefined; return r ? JSON.parse(r.value) : null; }
  setMemory(key: string, value: unknown) {
    this.db.prepare('INSERT INTO memory (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(key, JSON.stringify(value), now());
  }
}
