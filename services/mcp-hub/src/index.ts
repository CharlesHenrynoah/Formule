/**
 * mcp-hub — se connecte à des serveurs MCP (stdio, HTTP streamable, SSE) décrits dans mcp.config.json,
 * agrège leurs outils et applique la politique de sécurité :
 *   - liste blanche d'outils par serveur (allowedTools : tableau, "*" = tous, absent/"*" par défaut à l'ajout ;
 *     [] = aucun outil — verrouillage explicite)
 *   - outils d'écriture (annotation readOnlyHint absente/false, ou listés dans writeTools)
 *     → un appel n'est exécuté que si `confirmed: true` (confirmation utilisateur dans l'UI)
 * Nom exposé d'un outil : `<serverId>__<tool>` (compatible tool calling OpenAI/Anthropic).
 *
 * Backends d'app (kind « app ») : chaque app générée a son propre serveur MCP stdio (@es/app-mcp),
 * enregistré via POST /apps/:appId/register, namespacé `app-<id>__<outil>`, jamais écrit dans mcp.config.json,
 * lancé avec le modèle de permissions Node (lecture : runtime + node_modules + son code ; écriture : son dossier data),
 * sans variables d'environnement du projet, avec un délai par appel. Au plus APP_SERVERS_MAX actifs (LRU).
 *
 * Authentification des serveurs distants (HTTP streamable / SSE) : jeton Bearer et en-têtes personnalisés stockés
 * HORS de mcp.config.json (cf. secrets.ts : fichier chmod 600 ou MCP_TOKEN_<ID>), envoyés sur chaque requête
 * (POST, flux GET/SSE, DELETE, reconnexions) et jamais renvoyés par l'API ni journalisés.
 */
import { BIND_HOST } from './env.ts';
import Fastify from 'fastify';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { SecretStore, authHeaders, cleanHeaders, cleanToken, friendlyError } from './secrets.ts';
import { githubAttempts, githubFallbackAfterError, isGithubSearchFailure } from './github-robust.ts';

const PORT = Number(process.env.MCP_HUB_PORT ?? 4004);
const CONFIG_PATH = resolve(process.env.MCP_CONFIG_PATH ?? '../../mcp.config.json');
const CONFIG_DIR = dirname(CONFIG_PATH);
const ROOT = resolve(process.env.ES_ROOT ?? CONFIG_DIR);
const APPS_DIR = resolve(process.env.APPS_DIR ?? join(ROOT, 'data/apps'));
const APP_MCP_DIR = resolve(join(ROOT, 'packages/app-mcp'));
const APP_SERVERS_MAX = Number(process.env.APP_SERVERS_MAX ?? 12);
const CALL_TIMEOUT_MS = Number(process.env.MCP_CALL_TIMEOUT_MS ?? 15_000);
const SECRETS_PATH = resolve(process.env.MCP_SECRETS_PATH ?? join(ROOT, 'data/secrets/mcp-servers.json'));
const secrets = new SecretStore(SECRETS_PATH);

type ServerConfig = {
  id: string;
  name?: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  /** Ancien champ (en clair) : migré au démarrage vers le magasin de secrets, jamais réécrit. */
  headers?: Record<string, string>;
  /** Référence seulement : l'authentification est dans le magasin de secrets. */
  auth?: { secret: true };
  enabled: boolean;
  allowedTools?: string[] | '*';
  writeTools?: string[];
  kind?: 'app';
  appId?: string;
  version?: number;
};
type ToolInfo = { name: string; description?: string; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean }; _meta?: { safe?: boolean } };
type Conn = { config: ServerConfig; client?: Client; status: 'connected' | 'connecting' | 'error' | 'disabled'; error?: string; tools: ToolInfo[]; lastUsed?: number };

const conns = new Map<string, Conn>();

/** Environnement transmis aux serveurs stdio : sans les secrets du projet (clés API, mots de passe…). */
function safeEnv() {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|ACCESS/i.test(k)) out[k] = v;
  }
  return out;
}

function loadConfig(): ServerConfig[] {
  if (!existsSync(CONFIG_PATH)) return [];
  const list = (JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).servers ?? []) as ServerConfig[];
  let migrated = false;
  for (const c of list) { // en-têtes laissés en clair dans la config → magasin de secrets
    if (c.headers && Object.keys(c.headers).length) {
      try { secrets.update(c.id, { headers: cleanHeaders(c.headers) ?? null }); c.auth = { secret: true }; } catch { /* en-têtes invalides : ignorés */ }
      migrated = true;
    }
    delete c.headers;
  }
  if (migrated) writeConfig(list);
  return list;
}
/** La config écrite ne contient jamais de valeur d'authentification (référence `auth` seulement). */
function persistable(c: ServerConfig): ServerConfig {
  const { headers: _h, ...rest } = c; // eslint-disable-line @typescript-eslint/no-unused-vars
  return { ...rest, ...(secrets.has(c.id) ? { auth: { secret: true as const } } : { auth: undefined }) };
}
function writeConfig(list: ServerConfig[]) {
  writeFileSync(CONFIG_PATH, JSON.stringify({ servers: list.map(persistable) }, null, 2) + '\n');
}
function saveConfig() {
  writeConfig([...conns.values()].filter((c) => c.config.kind !== 'app').map((c) => c.config));
}
/** fetch qui ajoute les en-têtes d'authentification à TOUTE requête du transport (y compris reconnexions). */
function authFetch(extra: Record<string, string>): typeof fetch {
  return (input, init) => {
    const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const [k, v] of Object.entries(extra)) h.set(k, v);
    return fetch(input, { ...init, headers: h });
  };
}

/** "*" ou champ absent → tous les outils ; [] = aucun (verrouillage explicite). */
const isAllowed = (c: ServerConfig, tool: string) => {
  const a = c.allowedTools;
  if (a === '*' || a === undefined) return true;
  return Array.isArray(a) && a.includes(tool);
};
const isWrite = (c: ServerConfig, t: ToolInfo) => (c.writeTools ?? []).includes(t.name) || t.annotations?.readOnlyHint !== true;

async function connect(conn: Conn) {
  await disconnect(conn);
  const c = conn.config;
  if (!c.enabled) { conn.status = 'disabled'; conn.tools = []; return; }
  conn.status = 'connecting';
  try {
    const client = new Client({ name: 'everything-software-mcp-hub', version: '0.1.0' });
    let transport;
    if (c.kind === 'app') {
      transport = new StdioClientTransport({ command: process.execPath, args: appServerArgs(c.appId!, c.version!), cwd: APP_MCP_DIR, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'production' }, stderr: 'pipe' });
    } else if (c.transport === 'stdio') {
      if (!c.command) throw new Error('command manquant');
      transport = new StdioClientTransport({
        command: c.command, args: c.args ?? [], cwd: CONFIG_DIR,
        env: { ...safeEnv(), ...(c.env ?? {}) }, stderr: 'pipe',
      });
    } else if (c.transport === 'http') {
      const headers = authHeaders(secrets.get(c.id));
      transport = new StreamableHTTPClientTransport(new URL(c.url!), { requestInit: { headers }, fetch: authFetch(headers) });
    } else if (c.transport === 'sse') {
      const headers = authHeaders(secrets.get(c.id));
      transport = new SSEClientTransport(new URL(c.url!), { requestInit: { headers }, fetch: authFetch(headers) });
    } else throw new Error(`transport inconnu : ${c.transport}`);
    await Promise.race([
      client.connect(transport),
      new Promise((_, rej) => setTimeout(() => rej(new Error('délai de connexion dépassé (20 s)')), 20_000)),
    ]);
    const { tools } = await client.listTools();
    conn.client = client;
    conn.tools = tools as ToolInfo[];
    conn.status = 'connected';
    conn.error = undefined;
    console.log(`[mcp-hub] ${c.id} connecté (${tools.length} outils)`);
  } catch (e) {
    conn.status = 'error';
    const s = c.kind === 'app' ? undefined : secrets.get(c.id);
    conn.error = friendlyError(String((e as Error)?.message ?? e), !!s, [s?.token ?? '', ...Object.values(s?.headers ?? {})]);
    conn.tools = [];
    console.warn(`[mcp-hub] ${c.id} : ${conn.error}`);
  }
}
async function disconnect(conn: Conn) {
  if (conn.client) { try { await conn.client.close(); } catch { /* ignore */ } }
  conn.client = undefined;
}

/** Arguments node pour le serveur MCP d'une app : modèle de permissions (fichiers) + runtime @es/app-mcp. */
export function appPaths(appId: string, version: number) {
  const dir = join(APPS_DIR, appId);
  return { dir, codeFile: join(dir, `v${version}`, 'tools.js'), dataDir: join(dir, 'data') };
}
function permissionFlag() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  return maj > 22 || (maj === 22 && min >= 13) ? '--permission' : maj >= 20 ? '--experimental-permission' : null;
}
function appServerArgs(appId: string, version: number) {
  const { codeFile, dataDir } = appPaths(appId, version);
  const perm = permissionFlag();
  const flags = perm ? [perm, `--allow-fs-read=${APP_MCP_DIR}`, `--allow-fs-read=${join(ROOT, 'node_modules')}`, `--allow-fs-read=${codeFile}`, `--allow-fs-read=${dataDir}`, `--allow-fs-write=${dataDir}`] : [];
  return [...flags, '--max-old-space-size=64', join(APP_MCP_DIR, 'src/server.mjs'), codeFile, dataDir];
}
export const appConnId = (appId: string) => `app-${appId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`;

/** Vue publique d'un serveur : jamais de valeur secrète (ni jeton, ni en-têtes, ni valeurs d'env stdio). */
const view = (conn: Conn) => ({
  ...(({ headers: _h, env, ...rest }) => ({ ...rest, ...(env ? { envNames: Object.keys(env) } : {}) }))(conn.config), // eslint-disable-line @typescript-eslint/no-unused-vars
  ...(conn.config.kind === 'app' ? {} : { auth: secrets.view(conn.config.id) }),
  status: conn.status,
  error: conn.error,
  tools: conn.tools.map((t) => ({
    name: t.name, id: `${conn.config.id}__${t.name}`, description: t.description, inputSchema: t.inputSchema,
    write: isWrite(conn.config, t), allowed: isAllowed(conn.config, t.name), safe: !isWrite(conn.config, t) || t._meta?.safe === true,
  })),
});

function allTools(opts: { allowedOnly?: boolean; readOnly?: boolean; app?: string }) {
  return [...conns.values()].filter((c) => c.status === 'connected' && (opts.app ? c.config.id === opts.app : c.config.kind !== 'app')).flatMap((c) => view(c).tools
    .filter((t) => (!opts.allowedOnly || t.allowed) && (!opts.readOnly || !t.write))
    .map((t) => ({ ...t, server: c.config.id, serverName: c.config.name ?? c.config.id })));
}

const app = Fastify({ logger: { level: 'warn' } });
app.get('/health', async () => ({
  service: 'mcp-hub', status: 'ok', config: CONFIG_PATH,
  servers: [...conns.values()].map((c) => ({ id: c.config.id, status: c.status })),
}));
app.get<{ Querystring: { apps?: string } }>('/servers', async (req) => [...conns.values()].filter((c) => req.query.apps === '1' || c.config.kind !== 'app').map(view));

// ---- Backends MCP des apps générées ----
app.post<{ Params: { appId: string }; Body: { version: number; name?: string } }>('/apps/:appId/register', async (req, reply) => {
  const { appId } = req.params;
  const version = Number(req.body?.version);
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(appId) || !Number.isInteger(version) || version < 1) return reply.code(400).send({ error: 'appId/version invalides' });
  if (!existsSync(appPaths(appId, version).codeFile)) return reply.code(404).send({ error: 'backend non matérialisé (tools.js absent)' });
  const id = appConnId(appId);
  const existing = conns.get(id);
  if (existing && existing.config.version === version && existing.status === 'connected') { existing.lastUsed = Date.now(); return view(existing); }
  if (existing) await disconnect(existing);
  // LRU : on libère les backends d'app les moins utilisés
  const apps = [...conns.values()].filter((c) => c.config.kind === 'app' && c.config.id !== id).sort((a, b) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0));
  while (apps.length >= APP_SERVERS_MAX) { const old = apps.shift()!; await disconnect(old); conns.delete(old.config.id); }
  const conn: Conn = existing ?? { config: { id, transport: 'stdio', enabled: true, kind: 'app', appId, version, allowedTools: '*', writeTools: [] }, status: 'connecting', tools: [] };
  Object.assign(conn.config, { version, name: req.body?.name ? `App · ${String(req.body.name).slice(0, 60)}` : `App ${appId.slice(0, 8)}` });
  conn.lastUsed = Date.now();
  conns.set(id, conn);
  await connect(conn);
  if (conn.status !== 'connected') return reply.code(502).send({ ...view(conn), error: conn.error ?? 'backend injoignable' });
  return view(conn);
});
app.get<{ Params: { appId: string } }>('/apps/:appId', async (req, reply) => {
  const c = conns.get(appConnId(req.params.appId));
  return c ? view(c) : reply.code(404).send({ error: 'backend non démarré' });
});
app.delete<{ Params: { appId: string } }>('/apps/:appId', async (req) => {
  const c = conns.get(appConnId(req.params.appId));
  if (c) { await disconnect(c); conns.delete(c.config.id); }
  return { stopped: !!c };
});

type AuthBody = { token?: string | null; headers?: Record<string, string> | null };
/** Extrait et valide jeton / en-têtes du corps (ils ne vont JAMAIS dans la config). */
function readAuth(body: AuthBody | undefined): { token?: string | null; headers?: Record<string, string> | null } {
  const out: { token?: string | null; headers?: Record<string, string> | null } = {};
  if (body?.token === null || body?.token === '') out.token = null; else if (body?.token !== undefined) out.token = cleanToken(body.token) ?? null;
  if (body?.headers === null) out.headers = null; else if (body?.headers !== undefined) out.headers = cleanHeaders(body.headers) ?? null;
  return out;
}
app.post<{ Body: ServerConfig & AuthBody }>('/servers', async (req, reply) => {
  const { token, headers, auth: _a, ...c } = req.body ?? ({} as ServerConfig & AuthBody); // eslint-disable-line @typescript-eslint/no-unused-vars
  let authPatch;
  try { authPatch = readAuth({ token, headers }); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  if (!c?.id || !/^[a-zA-Z0-9-]{1,40}$/.test(c.id)) return reply.code(400).send({ error: 'id invalide (lettres, chiffres, tirets)' });
  if (conns.has(c.id)) return reply.code(409).send({ error: 'id déjà utilisé' });
  if (!['stdio', 'http', 'sse'].includes(c.transport)) return reply.code(400).send({ error: 'transport : stdio | http | sse' });
  if (c.transport === 'stdio' && !c.command) return reply.code(400).send({ error: 'command requis pour stdio' });
  if (c.transport !== 'stdio' && !c.url) return reply.code(400).send({ error: 'url requise' });
  if (c.transport === 'stdio' && (authPatch.token || authPatch.headers)) return reply.code(400).send({ error: 'jeton/en-têtes : uniquement pour HTTP streamable ou SSE' });
  if (c.transport !== 'stdio' && !/^https?:\/\//i.test(String(c.url))) return reply.code(400).send({ error: 'url : http(s) attendu' });
  if (authPatch.token !== undefined || authPatch.headers !== undefined) secrets.update(c.id, authPatch); else secrets.remove(c.id);
  // Par défaut : tous les outils autorisés ("*") — l'utilisateur peut restreindre ensuite dans le panneau MCP.
  const conn: Conn = { config: { writeTools: [], ...c, allowedTools: c.allowedTools ?? '*', enabled: c.enabled ?? true }, status: 'connecting', tools: [] };
  conns.set(c.id, conn);
  await connect(conn);
  saveConfig();
  return reply.code(201).send(view(conn));
});

app.patch<{ Params: { id: string }; Body: Partial<ServerConfig> & AuthBody }>('/servers/:id', async (req, reply) => {
  const conn = conns.get(req.params.id);
  if (!conn || conn.config.kind === 'app') return reply.code(404).send({ error: 'serveur inconnu' });
  const { enabled, allowedTools, writeTools, name } = req.body ?? {};
  let authPatch;
  try { authPatch = readAuth(req.body); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  const authChanged = authPatch.token !== undefined || authPatch.headers !== undefined;
  if (authChanged && conn.config.transport === 'stdio') return reply.code(400).send({ error: 'jeton/en-têtes : uniquement pour HTTP streamable ou SSE' });
  if (authChanged) secrets.update(conn.config.id, authPatch);
  const reconnect = authChanged || (enabled !== undefined && enabled !== conn.config.enabled);
  Object.assign(conn.config, {
    ...(enabled !== undefined && { enabled }), ...(allowedTools !== undefined && { allowedTools }),
    ...(writeTools !== undefined && { writeTools }), ...(name !== undefined && { name }),
  });
  if (reconnect) await connect(conn);
  saveConfig();
  return view(conn);
});

app.post<{ Params: { id: string } }>('/servers/:id/reconnect', async (req, reply) => {
  const conn = conns.get(req.params.id);
  if (!conn) return reply.code(404).send({ error: 'serveur inconnu' });
  await connect(conn);
  return view(conn);
});

app.delete<{ Params: { id: string } }>('/servers/:id', async (req) => {
  const conn = conns.get(req.params.id);
  if (conn && conn.config.kind !== 'app') { await disconnect(conn); conns.delete(req.params.id); secrets.remove(req.params.id); saveConfig(); }
  return { deleted: !!conn && conn.config.kind !== 'app' };
});

app.get<{ Querystring: { allowedOnly?: string; readOnly?: string; app?: string } }>('/tools', async (req) =>
  allTools({ allowedOnly: req.query.allowedOnly !== '0', readOnly: req.query.readOnly === '1', app: req.query.app }));

app.post<{ Body: { tool: string; args?: Record<string, unknown>; confirmed?: boolean; timeoutMs?: number } }>('/call', async (req, reply) => {
  const { tool, args = {}, confirmed = false } = req.body ?? ({} as never);
  const asked = Number(req.body?.timeoutMs);
  const callTimeout = Number.isFinite(asked) ? Math.min(120_000, Math.max(1_000, asked)) : CALL_TIMEOUT_MS;
  const [serverId, ...rest] = String(tool ?? '').split('__');
  const name = rest.join('__');
  const conn = conns.get(serverId);
  if (!conn || conn.status !== 'connected' || !conn.client) return reply.code(404).send({ error: `serveur MCP indisponible : ${serverId}` });
  const t = conn.tools.find((x) => x.name === name);
  if (!t) return reply.code(404).send({ error: `outil inconnu : ${tool}` });
  if (!isAllowed(conn.config, name)) return reply.code(403).send({ error: `outil hors liste blanche : ${tool}` });
  if (isWrite(conn.config, t) && !confirmed) return reply.code(428).send({ error: 'confirmation requise', needsConfirmation: true, tool });
  const started = Date.now();

  const runOne = async (toolName: string, callArgs: Record<string, unknown>) => {
    const res = await conn.client!.callTool({ name: toolName, arguments: callArgs }, undefined, { timeout: callTimeout });
    const content = (res.content as Array<{ type: string; text?: string }>) ?? [];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    let data: unknown = text;
    try { data = JSON.parse(text); } catch { /* texte brut */ }
    return { isError: !!res.isError, data, content };
  };

  try {
    conn.lastUsed = Date.now();
    const attempts = serverId === 'github' ? githubAttempts(String(tool), (args ?? {}) as Record<string, unknown>) : [{ tool: String(tool), name, args: (args ?? {}) as Record<string, unknown> }];
    let last: { isError: boolean; data: unknown; content: unknown } | null = null;
    let used = attempts[0]!;
    for (const attempt of attempts) {
      // Vérifie que l'outil de secours existe et est autorisé
      const at = conn.tools.find((x) => x.name === attempt.name);
      if (!at || !isAllowed(conn.config, attempt.name)) continue;
      used = attempt;
      last = await runOne(attempt.name, attempt.args);
      // fields hors enum → réessaie sans fields
      if (last.isError && /validating.*fields|does not equal any of/i.test(String(last.data)) && attempt.args.fields) {
        const { fields: _f, ...rest } = attempt.args;
        last = await runOne(attempt.name, rest);
        used = { ...attempt, args: rest, reason: (attempt.reason ? attempt.reason + ' · ' : '') + 'sans fields invalides' };
      }
      if (!last.isError && !isGithubSearchFailure(last.data)) break;
    }
    // Dernier recours : fallback list après échec search
    if (last && (last.isError || isGithubSearchFailure(last.data))) {
      const fb = githubFallbackAfterError(String(tool), (args ?? {}) as Record<string, unknown>, last.data);
      if (fb) {
        const at = conn.tools.find((x) => x.name === fb.name);
        if (at && isAllowed(conn.config, fb.name)) {
          used = fb;
          last = await runOne(fb.name, fb.args);
        }
      }
    }
    if (!last) return reply.code(502).send({ error: 'aucun essai MCP abouti', tool });
    const softFail = serverId === 'github' && isGithubSearchFailure(last.data);
    return {
      tool,
      resolvedTool: used.tool !== tool ? used.tool : undefined,
      rewrite: used.reason,
      isError: last.isError || softFail,
      data: last.data,
      content: last.content,
      ms: Date.now() - started,
    };
  } catch (e) {
    return reply.code(502).send({ error: (e as Error).message, tool });
  }
});

// ---- Ressources MCP (lecture seule) : découverte + lecture, pour le retrieval des agents d'app ----
const serversOf = (q?: string) => [...conns.values()].filter((c) => c.status === 'connected' && c.client && c.config.kind !== 'app' && (!q || q.split(',').includes(c.config.id)));
app.get<{ Querystring: { servers?: string } }>('/resources', async (req) => {
  const out: Array<{ server: string; uri: string; name?: string; description?: string; mimeType?: string }> = [];
  for (const c of serversOf(req.query.servers)) {
    if (!c.client!.getServerCapabilities()?.resources) continue;
    try {
      const { resources } = await c.client!.listResources(undefined, { timeout: CALL_TIMEOUT_MS });
      for (const r of resources.slice(0, 50)) out.push({ server: c.config.id, uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType });
    } catch (e) { console.warn(`[mcp-hub] ressources ${c.config.id} : ${(e as Error).message}`); }
  }
  return out;
});
app.post<{ Body: { server: string; uri: string } }>('/resources/read', async (req, reply) => {
  const { server, uri } = req.body ?? ({} as never);
  const c = serversOf().find((x) => x.config.id === server);
  if (!c) return reply.code(404).send({ error: `serveur MCP indisponible : ${server}` });
  const started = Date.now();
  try {
    c.lastUsed = Date.now();
    const res = await c.client!.readResource({ uri: String(uri) }, { timeout: CALL_TIMEOUT_MS });
    const text = (res.contents as Array<{ text?: string }>).map((x) => x.text ?? '').join('\n').slice(0, 20_000);
    let data: unknown = text;
    try { data = JSON.parse(text); } catch { /* texte brut */ }
    return { server, uri, data, ms: Date.now() - started };
  } catch (e) {
    return reply.code(502).send({ error: (e as Error).message, uri });
  }
});

const start = async () => {
  for (const c of loadConfig().filter((x) => x.kind !== 'app')) conns.set(c.id, { config: c, status: 'connecting', tools: [] });
  await app.listen({ port: PORT, host: BIND_HOST });
  console.log(`[mcp-hub] prêt sur :${PORT} (config : ${CONFIG_PATH})`);
  await Promise.all([...conns.values()].map(connect));
};
const shutdown = async () => { await Promise.all([...conns.values()].map(disconnect)); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
start();
