import { call, createService, listen, ServiceError } from '@formule/service-kit';
import { detectInjection, getPath, maskSecret, redact, redactString, splitToolKey } from '@formule/contracts';
import { makeEnvelope, newId, operationHash, issueConfirmation, verifyConfirmation } from '@formule/contracts/node';
import { loadConfig, saveConfig, type Permission, type ServerConfig } from './config.js';
import { connStatus, disconnect, extractResult, getClient, HubError, withTimeout, classifyError } from './connections.js';
import { saveServerToken, serverToken, confirmSecret, humanKey } from '@formule/service-kit/secrets';
import { listFileTools, readFileTool } from './files.js';

const app = await createService('mcp-hub', () => ({ servers: loadConfig().filter((s) => s.enabled).length }));
type B = Record<string, any>;
import { ReadCooldown, retryAfterMs } from './failure.js';
const readCooldown = new ReadCooldown();
const ARGS_MAX = 20 * 1024;
const OP_TTL_MS = 10 * 60_000;
const WRITE_TIMEOUT = Number(process.env.FORMULE_WRITE_TIMEOUT_MS ?? 15_000);

function publicServer(s: ServerConfig) {
  const tok = serverToken(s.id);
  return { ...s, env: undefined, secretEnv: s.secretEnv?.map((n) => `${n}=••••`), command: s.transport === 'stdio' ? '(configuré par fichier)' : undefined, args: undefined, hasToken: !!tok, tokenMask: tok ? maskSecret(tok) : undefined, ...connStatus(s.id) };
}
const findServer = (id: string) => {
  const s = loadConfig().find((x) => x.id === id);
  if (!s) throw new HubError('not_connected', `serveur ${id} inconnu`, 404);
  if (!s.enabled) throw new HubError('not_connected', `serveur ${s.name} désactivé`, 409);
  return s;
};

app.get('/servers', async () => loadConfig().map(publicServer));

app.post<{ Body: B }>('/servers', async (r) => {
  const b = r.body;
  const transport = b.transport as ServerConfig['transport'];
  if (transport === 'stdio' && process.env.FORMULE_ALLOW_STDIO_UI !== '1') throw new ServiceError(403, 'stdio_disabled', 'Ajout stdio depuis l’interface désactivé (FORMULE_ALLOW_STDIO_UI=1 pour l’activer).');
  if (!['http', 'sse', 'stdio'].includes(transport)) throw new ServiceError(400, 'bad_transport', 'transport attendu : http ou sse');
  if (transport !== 'stdio') {
    let u: URL; try { u = new URL(String(b.url)); } catch { throw new ServiceError(400, 'bad_url', 'URL invalide'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new ServiceError(400, 'bad_url', 'seuls http et https sont acceptés');
  }
  const cfg = loadConfig();
  const base = String(b.name ?? 'serveur').toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'serveur';
  let id = base; let i = 2; while (cfg.some((s) => s.id === id)) id = `${base}-${i++}`;
  const s: ServerConfig = { id, name: String(b.name ?? id).slice(0, 60), transport, url: b.url, command: b.command, args: b.args, enabled: true, demo: false, tools: {} };
  cfg.push(s); saveConfig(cfg);
  if (b.token) saveServerToken(id, String(b.token));
  return publicServer(s);
});

app.patch<{ Params: { id: string }; Body: B }>('/servers/:id', async (r) => {
  const cfg = loadConfig(); const s = cfg.find((x) => x.id === r.params.id);
  if (!s) throw new ServiceError(404, 'not_found', 'serveur inconnu');
  if (typeof r.body.enabled === 'boolean') { s.enabled = r.body.enabled; if (!s.enabled) await disconnect(s.id); }
  if (r.body.tools && typeof r.body.tools === 'object') for (const [k, v] of Object.entries(r.body.tools)) if (['read', 'write', 'off'].includes(String(v))) s.tools[k] = v as Permission;
  if (typeof r.body.token === 'string') { saveServerToken(s.id, r.body.token || null); await disconnect(s.id); }
  saveConfig(cfg); return publicServer(s);
});

app.delete<{ Params: { id: string } }>('/servers/:id', async (r) => {
  if (r.params.id === 'fichiers') throw new ServiceError(409, 'builtin', 'source intégrée');
  await disconnect(r.params.id); saveServerToken(r.params.id, null);
  saveConfig(loadConfig().filter((s) => s.id !== r.params.id)); return { deleted: true };
});
app.post<{ Params: { id: string } }>('/servers/:id/reconnect', async (r) => { await disconnect(r.params.id); await getClient(findServer(r.params.id)); return connStatus(r.params.id); });

/** Catalogue réel : tools, resources, prompts. Les annotations fournisseur sont des indices, pas des autorisations. */
app.get('/catalog', async () => {
  const out = [];
  for (const s of loadConfig().filter((x) => x.enabled)) {
    if (s.transport === 'files') {
      const tools = await listFileTools().catch(() => []);
      out.push({ serverId: s.id, name: s.name, demo: false, status: 'connected', tools: tools.map((t) => ({ name: t.name, description: t.description, permission: 'read', hint: 'lecture seule', inputSchema: {} })), resources: [], prompts: [] });
      continue;
    }
    try {
      const c = await getClient(s);
      const caps = c.getServerCapabilities() ?? {};
      const [tools, resources, prompts] = await Promise.all([
        withTimeout(c.listTools(), 10_000, 'tools/list'),
        caps.resources ? withTimeout(c.listResources(), 10_000, 'resources/list').catch(() => ({ resources: [] })) : { resources: [] },
        caps.prompts ? withTimeout(c.listPrompts(), 10_000, 'prompts/list').catch(() => ({ prompts: [] })) : { prompts: [] },
      ]);
      out.push({
        serverId: s.id, name: s.name, demo: s.demo, status: 'connected',
        tools: tools.tools.map((t) => ({
          name: t.name, description: t.description ?? '', inputSchema: t.inputSchema,
          permission: s.tools[t.name] ?? 'unclassified',
          hint: t.annotations?.readOnlyHint === true ? 'lecture (indice fournisseur)' : t.annotations?.readOnlyHint === false ? 'écriture (indice fournisseur)' : 'non annoncé',
        })),
        resources: resources.resources.map((x) => ({ uri: x.uri, name: x.name, description: x.description })),
        prompts: prompts.prompts.map((x) => ({ name: x.name, description: x.description })),
      });
    } catch (e) {
      const kind = e instanceof HubError ? e.kind : classifyError(e);
      out.push({ serverId: s.id, name: s.name, demo: s.demo, status: 'error', error: { kind, message: (e as Error).message }, tools: [], resources: [], prompts: [] });
    }
  }
  return out;
});

async function persist(env: ReturnType<typeof makeEnvelope>, projectId?: string | null, jobId?: string | null) {
  await call('storage', '/snapshots', { body: { envelope: env.envelope, raw: env.rawBytes, projectId: projectId ?? null, jobId: jobId ?? null } });
}

function argsGuard(args: unknown) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new ServiceError(400, 'bad_args', 'arguments : objet attendu');
  if (JSON.stringify(args).length > ARGS_MAX) throw new ServiceError(413, 'args_too_large', 'arguments > 20 Ko');
}

/** Lecture. Refus par défaut de tout outil non classé « read ». Pagination suivie dans le budget. */
app.post<{ Body: B }>('/call', async (r) => {
  const { serverId, tool, args = {}, projectId, jobId, paginate } = r.body;
  argsGuard(args);
  let s: ServerConfig;
  try { s = findServer(serverId); } catch (e) {
    const env = makeEnvelope({ serverId, serverName: serverId, demo: false, tool, args, error: { kind: 'not_connected', message: (e as Error).message } });
    return { envelope: env.envelope, raw: null };
  }
  if (s.transport === 'files') {
    if (!/^lire_fil_[a-z0-9]+$/.test(tool)) throw new ServiceError(403, 'not_allowed', 'outil non autorisé');
    const { raw, note } = await readFileTool(tool);
    const env = makeEnvelope({ serverId: s.id, serverName: s.name, demo: false, tool, args, raw, observedAt: null, schemaVersion: 'fichier', coverage: { complete: true, pages: 1, note } });
    await persist(env, projectId, jobId);
    return { envelope: env.envelope, raw };
  }
  if (s.tools[tool] !== 'read') {
    const env = makeEnvelope({ serverId: s.id, serverName: s.name, demo: s.demo, tool, args, error: { kind: 'permission', message: s.tools[tool] === 'write' ? 'outil d’écriture : passer par une opération confirmée' : 'outil non autorisé en lecture (liste blanche)' } });
    return { envelope: env.envelope, raw: null };
  }
  const requestId = newId('req');
  const blocked = readCooldown.active(serverId);
  if (blocked) {
    const env = makeEnvelope({ serverId, serverName: s.name, demo: s.demo, tool, args, requestId, error: { kind: blocked.kind, message: 'Lectures temporairement suspendues après une limite fournisseur.', retryAfterMs: blocked.retryAfterMs } });
    return { envelope: env.envelope, raw: null };
  }
  try {
    const c = await getClient(s);
    let pages = 0; let merged: unknown = undefined; let cursor: string | null | undefined; let complete = true; let note: string | undefined;
    const maxPages = paginate?.maxPages ?? 1;
    do {
      const a = cursor ? { ...args, [paginate.cursorArg]: cursor } : args;
      const res = await withTimeout(c.callTool({ name: tool, arguments: a }), 20_000, `${tool}`);
      if (res.isError) {
        const content = Array.isArray(res.content) ? res.content as { type: string; text?: string }[] : [];
        const detail = content.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('\n') || 'Le fournisseur a signalé un échec MCP.';
        let structured: unknown = detail; try { structured = JSON.parse(detail); } catch { /* texte fournisseur */ }
        if (typeof res.structuredContent === 'object' && res.structuredContent !== null) structured = res.structuredContent;
        const kind = classifyError(structured);
        throw new HubError(kind === 'provider_down' ? classifyError(detail) : kind, detail.slice(0, 300), 502, retryAfterMs(structured) ?? retryAfterMs(res));
      }
      const { raw, note: convNote } = extractResult(res as never);
      if (convNote === 'exécution en erreur') {
        const detail = String(getPath(raw, 'texte') ?? 'Exécution en erreur');
        throw new HubError(classifyError(detail), detail.slice(0, 300));
      }
      if (convNote) note = convNote;
      pages++;
      if (!paginate) { merged = raw; break; }
      const items = (getPath(raw, paginate.itemsPath) as unknown[]) ?? [];
      if (merged === undefined) merged = { ...(raw as object), [paginate.itemsPath]: [...items] };
      else (merged as Record<string, unknown[]>)[paginate.itemsPath].push(...items);
      cursor = getPath(raw, paginate.nextPath) as string | null;
      if (cursor && pages >= maxPages) { complete = false; note = `budget de ${maxPages} pages atteint : couverture partielle`; break; }
    } while (cursor);
    if (paginate && merged) delete (merged as Record<string, unknown>)[paginate.nextPath];
    const observedAt = (getPath(merged, 'observe_a') ?? getPath(merged, 'observed_at') ?? null) as string | null;
    const env = makeEnvelope({ serverId: s.id, serverName: s.name, demo: s.demo, tool, args, raw: merged, requestId, observedAt, schemaVersion: `${connStatus(s.id).version ?? '?'}:${tool}`, coverage: { complete, pages, note } });
    await persist(env, projectId, jobId);
    return { envelope: env.envelope, raw: merged };
  } catch (e) {
    const kind = e instanceof HubError ? e.kind : classifyError(e);
    const retry = retryAfterMs(e);
    readCooldown.block(serverId, kind, retry);
    const cooldown = readCooldown.active(serverId);
    let message = redactString(String((e as Error)?.message ?? e));
    const token = serverToken(s.id); if (token) message = message.split(token).join('••••');
    const env = makeEnvelope({ serverId: s.id, serverName: s.name, demo: s.demo, tool, args, requestId, error: { kind, message: message.slice(0, 300), ...(cooldown ? { retryAfterMs: cooldown.retryAfterMs } : {}) } });
    return { envelope: env.envelope, raw: null };
  }
});

/** Ressource documentaire : texte = donnée, jamais une mesure ni une instruction. */
app.post<{ Body: B }>('/resources/read', async (r) => {
  const s = findServer(r.body.serverId);
  const c = await getClient(s);
  const res = await withTimeout(c.readResource({ uri: r.body.uri }), 10_000, 'resources/read');
  const text = res.contents.map((x) => ('text' in x ? x.text : '[binaire]')).join('\n');
  return { serverId: s.id, uri: r.body.uri, kind: 'documentation', text, injectionSignals: detectInjection(String(text)) };
});

// ---------- Écritures : préparer → confirmer (humain) → exécuter → vérifier → journaliser ----------
app.post<{ Body: B }>('/ops/prepare', async (r) => {
  const { serverId, tool, args = {}, projectId = null } = r.body;
  argsGuard(args);
  const s = findServer(serverId);
  if (s.tools[tool] !== 'write') throw new ServiceError(403, 'not_writable', `l’outil ${tool} n’est pas autorisé en écriture`);
  const op = await call<B>('storage', '/ops', { body: { opHash: operationHash({ serverId, tool, args }), projectId, serverId, tool, args: redact(args) } });
  return { opId: op.id, serverId, serverName: s.name, tool, args: redact(args), demo: s.demo, status: 'prepared' };
});

/** Confirmation : réservée à l'humain (clé détenue par la gateway seule, jamais par le moteur IA). */
app.post<{ Params: { id: string }; Body: B }>('/ops/:id/confirm', async (r) => {
  if (r.headers['x-formule-human'] !== humanKey()) throw new ServiceError(403, 'human_only', 'confirmation réservée à l’utilisateur');
  const op = await call<B>('storage', `/ops/${r.params.id}`);
  if (op.status !== 'prepared') throw new ServiceError(409, 'op_state', `opération ${op.status}`);
  if (Date.now() - Date.parse(op.created_at) > OP_TTL_MS) {
    await call('storage', `/ops/${op.id}`, { method: 'PATCH', body: { status: 'expired', expect: 'prepared' } });
    throw new ServiceError(409, 'expired', 'action préparée il y a plus de 10 minutes : redemande-la');
  }
  const c = issueConfirmation({ serverId: op.server_id, tool: op.tool, args: r.body.args }, confirmSecret(), 120_000);
  if (c.opHash !== op.op_hash) throw new ServiceError(409, 'mismatch', 'la demande a changé : l’accord précédent ne compte plus');
  await call('storage', `/ops/${op.id}`, { method: 'PATCH', body: { status: 'confirmed', expect: 'prepared' } });
  return { token: c.token, expiresAt: c.expiresAt };
});

app.post<{ Params: { id: string }; Body: B }>('/ops/:id/execute', async (r, reply) => {
  const op = await call<B>('storage', `/ops/${r.params.id}`);
  const args = r.body.args ?? {};
  const check = verifyConfirmation(r.body.token, { serverId: op.server_id, tool: op.tool, args }, confirmSecret());
  if (!check.ok) return reply.code(428).send({ code: 'confirmation_required', message: { missing: 'confirmation requise', mismatch: 'la commande a changé : confirmation invalide', expired: 'confirmation expirée', bad_signature: 'confirmation invalide' }[check.reason] });
  // consomme le nonce (une seule fois) et passe en exécution
  await call('storage', `/ops/${op.id}`, { method: 'PATCH', body: { status: 'executing', nonce: check.nonce, expect: 'confirmed' } });
  const s = findServer(op.server_id);
  const idem = `formule-${op.id}`;
  try {
    const c = await getClient(s);
    const schema = (await withTimeout(c.listTools(), 10_000, 'tools/list')).tools.find((t) => t.name === op.tool)?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    const idemField = ['cle_idempotence', 'idempotency_key', 'idempotencyKey'].find((k) => schema?.properties && k in schema.properties);
    const fullArgs = idemField ? { ...args, [idemField]: idem } : args;
    const res = await withTimeout(c.callTool({ name: op.tool, arguments: fullArgs }), WRITE_TIMEOUT, op.tool);
    if (res.isError) throw new HubError('provider_down', JSON.stringify(res.content).slice(0, 300));
    const { raw } = extractResult(res as never);
    const env = makeEnvelope({ serverId: s.id, serverName: s.name, demo: s.demo, tool: op.tool, args: fullArgs as Record<string, unknown>, raw, observedAt: new Date().toISOString() });
    await persist(env, op.project_id);
    await call('storage', `/ops/${op.id}`, { method: 'PATCH', body: { status: 'done', idempotencyKey: idem, result: { envelopeId: env.envelope.id, raw } } });
    return { status: 'done', envelope: env.envelope, raw };
  } catch (e) {
    const kind = e instanceof HubError ? e.kind : classifyError(e);
    // Après un timeout d'écriture : pas de second envoi. État incertain, à réconcilier.
    const status = kind === 'timeout' ? 'uncertain' : 'failed';
    await call('storage', `/ops/${op.id}`, { method: 'PATCH', body: { status, idempotencyKey: idem, result: { error: { kind, message: (e as Error).message } } } });
    return reply.code(kind === 'timeout' ? 504 : 502).send({ code: status, message: status === 'uncertain' ? 'Écriture sans réponse : état incertain. Aucun second envoi ; vérifie l’état côté source.' : `Écriture refusée (${kind}).` });
  }
});

app.get<{ Params: { id: string } }>('/ops/:id', async (r) => call('storage', `/ops/${r.params.id}`));

export { splitToolKey };
await listen(app, 'mcp-hub');
