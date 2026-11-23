/**
 * api-gateway — point d'entrée unique du frontend.
 *  - /api/generate : orchestre ai-engine → validator (→ correction unique) → storage, en SSE
 *  - /api/projects* : proxy vers storage (+ validation des éditions manuelles)
 *  - /api/mcp/*     : proxy vers mcp-hub, dont /api/mcp/call (pont des mini-apps, liste blanche + confirmation)
 *  - /voice/*       : proxy HTTP + WebSocket vers voice-gateway (micro / TTS Google), même en mode public (port unique)
 */
import { BIND_HOST } from './env.ts';
import Fastify, { type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { connect as netConnect } from 'node:net';

const PORT = Number(process.env.GATEWAY_PORT ?? 4000);
const AI = process.env.AI_ENGINE_URL ?? 'http://localhost:4001';
const VALIDATOR = process.env.VALIDATOR_URL ?? 'http://localhost:4002';
const STORAGE = process.env.STORAGE_URL ?? 'http://localhost:4003';
const MCP = process.env.MCP_HUB_URL ?? 'http://localhost:4004';
const AGENTS = process.env.APP_AGENTS_URL ?? 'http://localhost:4005';
const VOICE = process.env.VOICE_GATEWAY_URL ?? 'http://localhost:4006';
// Fichier d'accès `user:motdepasse` : s'il existe, tout le site est protégé par Basic Auth (mode public).
const ACCESS_FILE = resolve(process.env.ACCESS_FILE ?? '../../.access');
const ACCESS = existsSync(ACCESS_FILE) ? readFileSync(ACCESS_FILE, 'utf8').trim() : '';
const PUBLIC_MODE = !!ACCESS;
// En mode public, l'ajout de serveurs stdio depuis l'UI est toujours interdit.
const ALLOW_UI_STDIO = !PUBLIC_MODE && process.env.MCP_ALLOW_UI_STDIO === 'true';
const STATIC_DIR = resolve(process.env.STATIC_DIR ?? '../../frontend/dist');
const RUNTIME_DIR = resolve(process.env.RUNTIME_DIR ?? '../../packages/es-runtime/dist');
// Bibliothèques de rendu vivant chargées À LA DEMANDE par les mini-apps (pixi.min.js, three.min.js) : jamais dans le bundle de l'app.
const VENDOR_DIR = resolve(process.env.RUNTIME_VENDOR_DIR ?? '../../packages/es-runtime/vendor');
const GEN_PER_HOUR = Number(process.env.GEN_RATE_PER_HOUR ?? 40);

type Json = Record<string, any>;
type Validation = { ok: boolean; errors: Array<{ code: string; message: string; line?: number }>; warnings: unknown[] };

async function call(url: string, init?: RequestInit & { json?: unknown }): Promise<{ status: number; body: any }> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* texte */ }
  return { status: res.status, body };
}

/** La construction dure plus que le délai par défaut d'undici (5 min sans octet). Le moteur envoie des pings, mais un build peut bloquer la boucle. */
let engineAgent: { close?: () => Promise<void> } | undefined;
async function engineDispatcher() {
  if (engineAgent) return engineAgent;
  try {
    const undici = await import('undici') as { Agent: new (opts: { bodyTimeout: number; headersTimeout: number }) => { close?: () => Promise<void> } };
    engineAgent = new undici.Agent({ bodyTimeout: 0, headersTimeout: 60_000 });
  } catch { /* fetch par défaut */ }
  return engineAgent;
}

const LIAISON = 'La liaison a été coupée pendant la construction. Relance la génération.';

/** undici met toujours « fetch failed » dans message. La cause réelle (ECONNREFUSED, reset) est dans cause. */
function causeText(e: unknown) {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur && typeof cur === 'object'; i++) {
    const o = cur as { message?: unknown; code?: unknown; cause?: unknown };
    if (o.message) parts.push(String(o.message));
    if (o.code) parts.push(String(o.code));
    cur = o.cause;
  }
  if (!parts.length) parts.push(String(e ?? ''));
  return parts.join(' ').toLowerCase();
}

function linkCut(e: unknown) {
  return /terminated|econnrefused|econnreset|etimedout|und_err_|socket hang up|other side closed|fetch failed|failed to fetch|headers timeout|body timeout|flux interrompu/.test(causeText(e));
}

/** Le redémarrage du moteur (tsx watch) tue l'ancien processus jusqu'à 5 s avant d'écouter à nouveau. */
async function waitListening(url: string, signal: AbortSignal) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (signal.aborted) return false;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (r.ok) return true;
    } catch { /* pas encore là */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** Lit le flux SSE d'un service et relaie chaque événement ; renvoie l'événement `result`. Une coupure est rejouée une fois, après le retour du moteur. */
async function relaySse(url: string, payload: unknown, onEvent: (e: Json) => void, signal: AbortSignal): Promise<Json> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal.aborted) break;
    try {
      return await readSse(url, payload, onEvent, signal);
    } catch (e) {
      last = e;
      if (signal.aborted || attempt === 1 || (e as { delivered?: boolean }).delivered || !linkCut(e)) break;
      onEvent({ type: 'phase', phase: 'plan', label: 'Reprise de la liaison' });
      const back = await waitListening(`${AI}/health`, signal);
      if (!back) break;
    }
  }
  if (last && linkCut(last)) throw new Error(LIAISON);
  throw last instanceof Error ? last : new Error(LIAISON);
}

async function readSse(url: string, payload: unknown, onEvent: (e: Json) => void, signal: AbortSignal): Promise<Json> {
  const dispatcher = await engineDispatcher();
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal, ...(dispatcher ? { dispatcher } : {}) });
  if (!res.ok || !res.body) throw new Error(`${url} : HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let result: Json | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const e = JSON.parse(line.slice(5).trim()) as Json;
      if (e.type === 'result') result = e;
      else if (e.type === 'error') throw Object.assign(new Error(String(e.message ?? 'erreur')), { delivered: true });
      else onEvent(e);
    }
  }
  if (!result) throw new Error('flux interrompu sans résultat');
  return result;
}

const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 5 * 1024 * 1024, trustProxy: '127.0.0.1' });
if (!PUBLIC_MODE) await app.register(cors, { origin: true });

const clientIp = (req: { headers: Record<string, unknown>; ip: string }) =>
  String(req.headers['cf-connecting-ip'] ?? req.ip);
const digest = (s: string) => createHash('sha256').update(s).digest();

// ---- Basic Auth (mode public) + anti force brute ----
const SESSION_COOKIE = 'es_session';
const SESSION_TOKEN = ACCESS ? createHmac('sha256', ACCESS).update('es-session-v1').digest('hex') : '';
function hasSession(cookie?: string) {
  if (!SESSION_TOKEN || !cookie) return false;
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{64})`).exec(cookie);
  return !!m && timingSafeEqual(Buffer.from(m[1]), Buffer.from(SESSION_TOKEN));
}
function basicOk(h?: string) {
  if (!ACCESS || !h?.startsWith('Basic ')) return false;
  return timingSafeEqual(digest(Buffer.from(h.slice(6), 'base64').toString('utf8')), digest(ACCESS));
}
const authFails = new Map<string, { n: number; t: number }>();
if (PUBLIC_MODE) {
  const expected = digest(ACCESS);
  app.addHook('onRequest', async (req, reply) => {
    // Session : après une Basic Auth réussie, un cookie HttpOnly signé suffit (utile pour le WebSocket de la voix,
    // que certains navigateurs ouvrent sans renvoyer l'en-tête Authorization).
    if (hasSession(req.headers.cookie)) return;
    // Le runtime des mini-apps est du code statique public : chargé depuis l'iframe sandboxée (origine opaque),
    // il ne peut pas transmettre la Basic Auth. Aucune donnée ni action derrière cette route.
    if (req.method === 'GET' && /^\/runtime\/[\w.-]+\.js(\?.*)?$/.test(req.url)) return;
    const ip = clientIp(req);
    const f = authFails.get(ip);
    if (f && f.n >= 20 && Date.now() - f.t < 15 * 60_000) return reply.code(429).send({ error: 'trop de tentatives, réessayez plus tard' });
    const h = req.headers.authorization ?? '';
    let ok = false;
    if (h.startsWith('Basic ')) {
      const given = Buffer.from(h.slice(6), 'base64').toString('utf8');
      ok = timingSafeEqual(digest(given), expected);
    }
    if (!ok) {
      if (h) authFails.set(ip, { n: (f && Date.now() - f.t < 15 * 60_000 ? f.n : 0) + 1, t: Date.now() });
      return reply.code(401).header('WWW-Authenticate', 'Basic realm="Everything Software", charset="UTF-8"').send({ error: 'authentification requise' });
    }
    reply.header('Set-Cookie', `${SESSION_COOKIE}=${SESSION_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`);
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    return payload;
  });
}

// ---- Runtime des mini-apps (React + shadcn/ui + lucide + Tailwind navigateur) ----
const runtimeCache = new Map<string, { mtime: number; body: Buffer }>();
app.get('/runtime/:file', async (req, reply) => {
  const file = (req.params as { file: string }).file;
  if (!/^[\w.-]+\.js$/.test(file)) return reply.code(404).send({ error: 'introuvable' });
  let path = resolve(RUNTIME_DIR, file);
  if (!existsSync(path) && existsSync(resolve(VENDOR_DIR, file))) path = resolve(VENDOR_DIR, file);
  if (!(path.startsWith(RUNTIME_DIR + '/') || path.startsWith(VENDOR_DIR + '/')) || !existsSync(path)) return reply.code(404).send({ error: 'runtime non construit (npm run build -w @es/runtime)' });
  const mtime = statSync(path).mtimeMs;
  let c = runtimeCache.get(path);
  if (!c || c.mtime !== mtime) { c = { mtime, body: readFileSync(path) }; runtimeCache.set(path, c); }
  return reply
    .header('Content-Type', 'application/javascript; charset=utf-8')
    .header('Cache-Control', path.startsWith(VENDOR_DIR) ? 'public, max-age=86400, immutable' : 'public, max-age=300')
    .header('Access-Control-Allow-Origin', '*')
    .header('Cross-Origin-Resource-Policy', 'cross-origin')
    .send(c.body);
});

// ---- Voix : proxy HTTP vers voice-gateway (la clé Google reste côté serveur) ----
app.route({
  method: ['GET', 'POST'], url: '/voice/*',
  handler: async (req, reply) => {
    const path = req.url.replace(/^\/voice/, '') || '/';
    try {
      const r = await fetch(`${VOICE}${path}`, {
        method: req.method, headers: req.method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: req.method === 'POST' ? JSON.stringify(req.body ?? {}) : undefined, signal: AbortSignal.timeout(60_000),
      });
      const text = await r.text();
      return reply.code(r.status).header('Content-Type', r.headers.get('content-type') ?? 'application/json').send(text);
    } catch (e) { return reply.code(502).send({ error: `voice-gateway injoignable : ${(e as Error).message}` }); }
  },
});

// ---- Frontend de production servi par la gateway (un seul point d'entrée) ----
if (existsSync(STATIC_DIR)) {
  await app.register(fastifyStatic, { root: STATIC_DIR, wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'introuvable' });
  });
}

// ---- Limite de générations (elles consomment la clé LLM) ----
const genHits = new Map<string, number[]>();
function allowGeneration(ip: string) {
  const now = Date.now();
  const list = (genHits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (list.length >= GEN_PER_HOUR) { genHits.set(ip, list); return false; }
  list.push(now); genHits.set(ip, list); return true;
}

app.get('/health', async () => {
  const names = { 'ai-engine': AI, validator: VALIDATOR, storage: STORAGE, 'mcp-hub': MCP, 'app-agents': AGENTS };
  const services: Json = {};
  await Promise.all(Object.entries(names).map(async ([n, u]) => {
    try { const r = await fetch(`${u}/health`, { signal: AbortSignal.timeout(1500) }); services[n] = r.ok ? await r.json() : { status: `HTTP ${r.status}` }; }
    catch { services[n] = { status: 'injoignable' }; }
  }));
  const ok = Object.values(services).every((s: any) => s.status === 'ok');
  return { service: 'api-gateway', status: ok ? 'ok' : 'dégradé', services };
});

app.get('/api/config', async () => {
  try { return (await call(`${AI}/health`)).body; } catch { return { status: 'injoignable' }; }
});

function openSse(reply: FastifyReply) {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', ...(PUBLIC_MODE ? {} : { 'Access-Control-Allow-Origin': '*' }),
  });
  const ac = new AbortController();
  reply.raw.on('close', () => ac.abort());
  const ping = setInterval(() => !reply.raw.writableEnded && reply.raw.write(': ping\n\n'), 15000);
  return {
    signal: ac.signal,
    send: (e: Json) => { if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`); },
    end: () => { clearInterval(ping); reply.raw.end(); },
  };
}

type Dataset = { name: string; rows: Json[] };
type GenBody = { fullRebuild?: boolean; prompt: string; projectId?: string; diffusing?: boolean; useTools?: boolean; mode?: 'agent' | 'direct'; phase?: 'source' | 'build'; sourceBrief?: string; datasets?: Dataset[] };
/** Données personnelles importées (CSV/JSON parsés dans le studio) : bornées, noms de collection sûrs. */
function cleanDatasets(ds: unknown): Dataset[] {
  if (!Array.isArray(ds)) return [];
  return ds.slice(0, 3).map((d: any) => ({
    name: String(d?.name ?? 'donnees').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'd$1').slice(0, 30) || 'donnees',
    rows: (Array.isArray(d?.rows) ? d.rows : []).slice(0, 2000).filter((r: unknown) => r && typeof r === 'object' && !Array.isArray(r)),
  })).filter((d) => d.rows.length);
}
app.post<{ Body: GenBody }>('/api/generate', async (req, reply) => {
  const { prompt, projectId, diffusing = false, useTools = true, mode } = req.body ?? ({} as GenBody);
  const datasets = cleanDatasets(req.body?.datasets);
  if (JSON.stringify(datasets).length > 1_500_000) return reply.code(413).send({ error: 'données importées trop volumineuses (1,5 Mo max)' });
  if (!prompt?.trim()) return reply.code(400).send({ error: 'prompt requis' });
  if (prompt.length > 4000) return reply.code(413).send({ error: 'prompt trop long (4000 caractères max)' });
  if (!allowGeneration(clientIp(req))) return reply.code(429).send({ error: `limite atteinte : ${GEN_PER_HOUR} générations par heure` });
  const s = openSse(reply);
  const t0 = Date.now();
  try {
    let previous: Json | null = null;
    if (projectId) {
      const r = await call(`${STORAGE}/projects/${projectId}/latest`);
      if (r.status !== 200) throw new Error('projet introuvable pour itération');
      previous = r.body;
    }
    s.send({ type: 'start', mode: previous ? 'iterate' : 'generate', projectId: projectId ?? null });

    const trace: Json[] = [];
    const gen = await relaySse(`${AI}/generate`, {
      prompt, diffusing, useTools, mode, previousCode: previous?.code, previousPlan: previous?.plan,
      previousFiles: previous?.files ?? undefined, previousComponents: previous?.agent?.components, previousBrief: previous?.agent?.brief,
      previousContract: previous?.app?.contract, datasets: datasets.length ? datasets : undefined, projectId: projectId ?? undefined, previousVersion: previous?.number, fullRebuild: req.body?.fullRebuild === true,
      phase: req.body?.phase, sourceBrief: req.body?.sourceBrief,
    }, (e) => { if (e.type === 'agent' && trace.length < 500) trace.push(e); s.send(e); }, s.signal);
    if (gen.sourced) { s.send({ type: 'source_ready' }); s.end(); return; }
    const isAgent = gen.mode === 'agent';
    let code: string = gen.code;

    s.send({ type: 'phase', phase: 'validate', label: 'Validation du code' });
    let validation = (await call(`${VALIDATOR}/validate`, { method: 'POST', json: { code } })).body as Validation;
    s.send({ type: 'validation', attempt: 1, ...validation });
    let fixed = false;
    // En mode agent, le Développeur a déjà livré un build vert relu par le PO : pas de réécriture du bundle.
    if (!validation.ok && !isAgent) {
      const f = await relaySse(`${AI}/fix`, { prompt, code, errors: validation.errors, diffusing: false }, s.send, s.signal);
      code = f.code;
      fixed = true;
      s.send({ type: 'phase', phase: 'validate', label: 'Nouvelle validation' });
      validation = (await call(`${VALIDATOR}/validate`, { method: 'POST', json: { code } })).body as Validation;
      s.send({ type: 'validation', attempt: 2, ...validation });
    }

    s.send({ type: 'phase', phase: 'save', label: 'Enregistrement' });
    let pid = projectId;
    let title: string = previous ? '' : ((/^#\s+(.+)$/m.exec(gen.plan ?? '')?.[1]) ?? prompt).replace(/^\s*(mini[- ]?spec|sp[ée]cification|spec)\s*[—:–-]\s*/i, '').replace(/[*_`]/g, '').trim().slice(0, 80);
    if (!pid) {
      const p = await call(`${STORAGE}/projects`, { method: 'POST', json: { title } });
      pid = p.body.id;
    }
    const imported = datasets.length ? Object.fromEntries(datasets.map((d) => [d.name, d.rows])) : undefined;
    const sampled = (gen.app?.seed ?? undefined) as Record<string, unknown> | undefined;
    const kept = (previous?.app?.seed ?? undefined) as Record<string, unknown> | undefined;
    const seed = imported || sampled || kept ? { ...(kept ?? {}), ...(sampled ?? {}), ...(imported ?? {}) } : undefined;
    const v = await call(`${STORAGE}/projects/${pid}/versions`, {
      method: 'POST',
      json: {
        prompt, kind: previous ? 'iterate' : 'generate', plan: gen.plan, code, provider: gen.provider, model: gen.model, validation: { ...validation, fixed },
        files: isAgent ? gen.files : undefined,
        // Mini-SaaS : contrat + définition du sous-agent + backend MCP. Le seed verse les lignes de la liaison dans la base locale.
        app: isAgent && gen.app ? { ...gen.app, seed } : undefined,
        agent: isAgent ? { framework: gen.framework, brief: gen.brief, components: gen.components, iterations: gen.iterations, reviews: gen.reviews, workspace: gen.workspace, ms: Date.now() - t0, trace } : undefined,
      },
    });
    s.send({ type: 'saved', projectId: pid, versionId: v.body.id, number: v.body.number, title });
    if (isAgent && gen.files) {
      // Mémoire persistante de la crew : la prochaine évolution repart de ce qui a été construit (pas de ré-exploration).
      const mem = gen.memory ?? {};
      await call(`${AGENTS}/apps/${pid}/crew-memory`, { method: 'POST', json: { version: v.body.number, title: gen.app?.title, prompt, kind: previous ? 'iterate' : 'generate', mode: mem.mode, features: mem.features, spec: gen.plan ?? '', brief: gen.brief ?? '', contract: gen.app?.contract ?? null, files: gen.files, prevFiles: previous?.files ?? undefined } })
        .then((r) => { if (r.status === 200) s.send({ type: 'agent', kind: 'memory', role: 'po', mode: mem.mode ?? 'complet', version: v.body.number, text: `Mémoire de l'app mise à jour (v${v.body.number}) : ${r.body.files} fichier(s), ${r.body.criteria} critère(s) livrés, schéma ${r.body.schema}.` }); })
        .catch(() => {});
    }
    if (isAgent && gen.app) {
      // Lancement du backend MCP de l'app (enregistré dans mcp-hub) : l'aperçu peut l'appeler immédiatement.
      try {
        const e = await call(`${AGENTS}/apps/${pid}/ensure`, { method: 'POST', json: { version: v.body.number } });
        s.send(e.status === 200 ? { type: 'app_ready', tools: e.body.tools, agent: e.body.agent?.name, connId: e.body.connId } : { type: 'app_warning', message: `backend MCP : ${e.body?.error ?? e.status}` });
      } catch (err) { s.send({ type: 'app_warning', message: `app-agents injoignable : ${(err as Error).message}` }); }
    }
    s.send({ type: 'done', code, plan: gen.plan, validation, fixed, ms: Date.now() - t0, toolResults: gen.toolResults ?? [], mode: isAgent ? 'agent' : 'direct', files: isAgent ? gen.files : undefined, brief: gen.brief, app: isAgent ? gen.app ?? null : null });
  } catch (e) {
    if (s.signal.aborted) { /* l'utilisateur a annulé */ }
    else s.send({ type: 'error', message: linkCut(e) ? LIAISON : ((e as Error).message || LIAISON) });
  }
  s.end();
});

// ---- Projets (storage) ----
app.get('/api/projects', async (_req, reply) => { const r = await call(`${STORAGE}/projects`); return reply.code(r.status).send(r.body); });
app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
  const r = await call(`${STORAGE}/projects/${req.params.id}`); return reply.code(r.status).send(r.body);
});
app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
  await call(`${AGENTS}/apps/${req.params.id}?data=1`, { method: 'DELETE' }).catch(() => null); // backend + données + mémoire de l'app
  const r = await call(`${STORAGE}/projects/${req.params.id}`, { method: 'DELETE' }); return reply.code(r.status).send(r.body);
});
app.post<{ Params: { id: string }; Body: { code: string; prompt?: string } }>('/api/projects/:id/versions', async (req, reply) => {
  if (!req.body?.code) return reply.code(400).send({ error: 'code requis' });
  const validation = (await call(`${VALIDATOR}/validate`, { method: 'POST', json: { code: req.body.code } })).body;
  const latest = await call(`${STORAGE}/projects/${req.params.id}/latest`);
  const r = await call(`${STORAGE}/projects/${req.params.id}/versions`, {
    method: 'POST', json: { prompt: req.body.prompt ?? 'Édition manuelle du code', kind: 'edit', plan: latest.body?.plan ?? null, code: req.body.code, provider: 'manuel', validation, files: latest.body?.files ?? undefined, app: latest.body?.app ?? undefined },
  });
  return reply.code(r.status).send({ ...r.body, validation });
});
app.post<{ Body: { code: string } }>('/api/validate', async (req, reply) => {
  const r = await call(`${VALIDATOR}/validate`, { method: 'POST', json: req.body }); return reply.code(r.status).send(r.body);
});

// ---- MCP (mcp-hub) ----
app.get('/api/mcp/servers', async (_req, reply) => { const r = await call(`${MCP}/servers`); return reply.code(r.status).send(r.body); });
app.post<{ Body: Json }>('/api/mcp/servers', async (req, reply) => {
  if (req.body?.transport === 'stdio' && !ALLOW_UI_STDIO) {
    return reply.code(403).send({ error: "L'ajout de serveurs stdio depuis l'interface est désactivé (MCP_ALLOW_UI_STDIO=true pour l'activer) : éditez mcp.config.json." });
  }
  const r = await call(`${MCP}/servers`, { method: 'POST', json: req.body }); return reply.code(r.status).send(r.body);
});
app.patch<{ Params: { id: string }; Body: Json }>('/api/mcp/servers/:id', async (req, reply) => {
  const r = await call(`${MCP}/servers/${req.params.id}`, { method: 'PATCH', json: req.body }); return reply.code(r.status).send(r.body);
});
app.post<{ Params: { id: string } }>('/api/mcp/servers/:id/reconnect', async (req, reply) => {
  const r = await call(`${MCP}/servers/${req.params.id}/reconnect`, { method: 'POST' }); return reply.code(r.status).send(r.body);
});
app.delete<{ Params: { id: string } }>('/api/mcp/servers/:id', async (req, reply) => {
  const r = await call(`${MCP}/servers/${req.params.id}`, { method: 'DELETE' }); return reply.code(r.status).send(r.body);
});
app.get('/api/mcp/tools', async (_req, reply) => { const r = await call(`${MCP}/tools?allowedOnly=1`); return reply.code(r.status).send(r.body); });

// Pont d'exécution des mini-apps : limite de débit + taille, la politique (liste blanche, confirmation) est appliquée par mcp-hub.
const hits = new Map<string, { n: number; t: number }>();
app.post<{ Body: { tool: string; args?: Json; confirmed?: boolean } }>('/api/mcp/call', async (req, reply) => {
  const key = clientIp(req);
  const now = Date.now();
  const h = hits.get(key) ?? { n: 0, t: now };
  if (now - h.t > 60_000) { h.n = 0; h.t = now; }
  if (++h.n > 60) return reply.code(429).send({ error: 'trop d\'appels MCP (60/min)' });
  hits.set(key, h);
  if (!req.body?.tool || !/^[a-zA-Z0-9-]+__[\w.-]+$/.test(req.body.tool)) return reply.code(400).send({ error: 'nom d\'outil invalide' });
  // Lectures MCP externes : args bornés (le Data Engineer / les apps doivent paginer, pas dumper).
  if (JSON.stringify(req.body.args ?? {}).length > 100_000) return reply.code(413).send({ error: 'arguments trop volumineux' });
  const r = await call(`${MCP}/call`, { method: 'POST', json: { tool: req.body.tool, args: req.body.args ?? {}, confirmed: req.body.confirmed === true } });
  return reply.code(r.status).send(r.body);
});

// ---- Apps : backend MCP propre + sous-agent (service app-agents) ----
const APP_ID = /^[a-zA-Z0-9-]{8,64}$/;
const agentHits = new Map<string, number[]>();
app.post<{ Params: { id: string; op: string }; Body: Json }>('/api/apps/:id/:op', async (req, reply) => {
  const { id, op } = req.params;
  if (!APP_ID.test(id) || !['ensure', 'call', 'confirm', 'memory', 'refresh'].includes(op)) return reply.code(404).send({ error: 'introuvable' });
  if (op === 'call' || op === 'refresh') {
    const k = clientIp(req); const now = Date.now(); const h = hits.get(k) ?? { n: 0, t: now };
    if (now - h.t > 60_000) { h.n = 0; h.t = now; }
    if (++h.n > 120) return reply.code(429).send({ error: "trop d'appels (120/min)" });
    hits.set(k, h);
    // Backend d'app : ingest_* peut recevoir un JSON n8n ; plafond aligné sur bodyLimit (5 Mo) avec marge.
    if (JSON.stringify(req.body?.args ?? {}).length > 1_500_000) return reply.code(413).send({ error: 'arguments trop volumineux' });
  }
  const r = await call(`${AGENTS}/apps/${id}/${op}`, { method: 'POST', json: req.body ?? {} });
  return reply.code(r.status).send(r.body);
});
app.get<{ Params: { id: string; op: string }; Querystring: Json }>('/api/apps/:id/:op', async (req, reply) => {
  const { id, op } = req.params;
  if (!APP_ID.test(id) || !['tools', 'log', 'memory', 'source'].includes(op)) return reply.code(404).send({ error: 'introuvable' });
  const qs = req.query?.version ? `?version=${Number(req.query.version)}` : '';
  const r = await call(`${AGENTS}/apps/${id}/${op}${qs}`); return reply.code(r.status).send(r.body);
});
// Sous-agent : flux SSE relayé tel quel (deltas, appels d'outils, demandes de confirmation).
app.post<{ Params: { id: string }; Body: Json }>('/api/apps/:id/ask', async (req, reply) => {
  if (!APP_ID.test(req.params.id)) return reply.code(404).send({ error: 'introuvable' });
  const ip = clientIp(req); const now = Date.now();
  const list = (agentHits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= 20) return reply.code(429).send({ error: "trop de questions à l'agent (20/min)" });
  list.push(now); agentHits.set(ip, list);
  const s = openSse(reply);
  try {
    const res = await fetch(`${AGENTS}/apps/${req.params.id}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body ?? {}), signal: s.signal });
    if (!res.ok || !res.body) { const b = await res.json().catch(() => ({})); s.send({ type: 'error', message: (b as Json).error ?? `HTTP ${res.status}` }); }
    else { const reader = res.body.getReader(); for (;;) { const { done, value } = await reader.read(); if (done) break; reply.raw.write(value); } }
  } catch (e) { if (!s.signal.aborted) s.send({ type: 'error', message: linkCut(e) ? 'La liaison a été coupée. Renvoie la question.' : (e as Error).message }); }
  s.end();
});

// ---- Tableaux vivants : une question, un document, les graphiques du studio, les données via l'interprète ----
app.get<{ Params: { id: string } }>('/api/projects/:id/dashboards', async (req, reply) => {
  const r = await call(`${STORAGE}/projects/${req.params.id}/dashboards`);
  return reply.code(r.status).send(r.body);
});
app.post<{ Body: { prompt?: string; projectId?: string; dashboardId?: string; spec?: Json } }>('/api/dashboards/build', async (req, reply) => {
  const prompt = String(req.body?.prompt ?? '').trim();
  if (!prompt) return reply.code(400).send({ error: 'prompt requis' });
  if (prompt.length > 4000) return reply.code(413).send({ error: 'prompt trop long (4000 caractères max)' });
  if (!allowGeneration(clientIp(req))) return reply.code(429).send({ error: `limite atteinte : ${GEN_PER_HOUR} générations par heure` });
  const s = openSse(reply);
  try {
    const result = await relaySse(`${AI}/dashboards/build`, {
      prompt, dashboardId: req.body?.dashboardId, spec: req.body?.spec,
    }, s.send, s.signal);
    let pid = req.body?.projectId;
    const spec = result.spec as Json;
    const id = String(result.id ?? '');
    if (!pid) {
      const p = await call(`${STORAGE}/projects`, { method: 'POST', json: { title: String(spec?.title ?? prompt).slice(0, 80) } });
      if (p.status >= 400) throw new Error(p.body?.error ?? 'projet impossible');
      pid = p.body.id;
    }
    const saved = await call(`${STORAGE}/projects/${pid}/dashboards/${id}`, { method: 'PUT', json: { spec } });
    if (saved.status >= 400) throw new Error(saved.body?.error ?? 'enregistrement du tableau impossible');
    s.send({ type: 'saved', projectId: pid, dashboardId: id, title: spec?.title });
    s.send({ type: 'done', projectId: pid, dashboardId: id, spec, reply: result.reply, mode: result.mode });
  } catch (e) {
    s.send({ type: 'error', message: (e as Error).message });
  }
  s.end();
});
const interpretHits = new Map<string, { n: number; t: number }>();
app.post<{ Body: { tool?: string; args?: Json; x?: string; y?: string } }>('/api/interpreter', async (req, reply) => {
  const key = clientIp(req);
  const now = Date.now();
  const h = interpretHits.get(key) ?? { n: 0, t: now };
  if (now - h.t > 60_000) { h.n = 0; h.t = now; }
  if (++h.n > 180) return reply.code(429).send({ error: 'trop de lectures (180/min)' });
  interpretHits.set(key, h);
  const r = await call(`${AI}/interpret`, { method: 'POST', json: req.body ?? {}, signal: AbortSignal.timeout(125_000) });
  return reply.code(r.status).send(r.body);
});

// ---- Voix : WebSocket /voice/ws → voice-gateway (tunnel TCP brut après contrôle d'accès) ----
app.server.on('upgrade', (req, socket, head) => {
  const url = req.url ?? '';
  const host = String(req.headers.host ?? '');
  const origin = String(req.headers.origin ?? '');
  const sameOrigin = !origin || origin.replace(/^https?:\/\//, '') === host || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const authed = !PUBLIC_MODE || hasSession(req.headers.cookie) || basicOk(req.headers.authorization);
  if (!url.startsWith('/voice/ws') || !sameOrigin || !authed) {
    socket.end(`HTTP/1.1 ${authed ? 403 : 401} ${authed ? 'Forbidden' : 'Unauthorized'}\r\nConnection: close\r\n\r\n`);
    return;
  }
  const target = new URL(VOICE);
  const up = netConnect(Number(target.port || 80), target.hostname, () => {
    // En-têtes relayés sans identifiants ni origine publique (le voice-gateway n'accepte que des origines locales).
    const skip = new Set(['host', 'origin', 'authorization', 'cookie', 'cf-connecting-ip', 'x-forwarded-for']);
    const lines = [`GET ${url.replace(/^\/voice/, '')} HTTP/1.1`, `Host: ${target.host}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (!skip.has(req.rawHeaders[i].toLowerCase())) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  const close = () => { up.destroy(); socket.destroy(); };
  up.on('error', close); socket.on('error', close);
});

app.listen({ port: PORT, host: BIND_HOST }).then(() => console.log(`[api-gateway] prêt sur ${BIND_HOST}:${PORT}${PUBLIC_MODE ? ' (mode public : Basic Auth active)' : ''}${existsSync(STATIC_DIR) ? ' — frontend servi depuis ' + STATIC_DIR : ''}`));
