import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authHeaders, cleanHeaders, cleanToken, friendlyError, SecretStore } from '../src/secrets.ts';
import { startFake, type Fake } from './fake-bearer-server.ts';

const TOKEN = 'tok_test_' + 'x'.repeat(24) + 'Z9k2';

test('authHeaders : Bearer prioritaire sur un Authorization personnalisé', () => {
  assert.deepEqual(authHeaders({ token: 'abc', headers: { authorization: 'Basic zz', 'X-Org': '1' } }), { 'X-Org': '1', Authorization: 'Bearer abc' });
  assert.deepEqual(authHeaders(undefined), {});
  assert.equal(cleanToken('  Bearer  abc '), 'abc');
  assert.throws(() => cleanToken('a\nb'));
  assert.throws(() => cleanHeaders({ Host: 'x' }));
  assert.throws(() => cleanHeaders({ 'X-A': 'v\r\nInjected: 1' }));
});

test('friendlyError : 401 → message clair, jeton masqué', () => {
  const m = friendlyError('Streamable HTTP error: Error POSTing to endpoint: {"message":"Unauthorized: Authorization header not sent"}', false);
  assert.match(m, /^Le serveur demande une authentification : ajoute un jeton Bearer/);
  const m2 = friendlyError(`HTTP 401 for ${TOKEN}`, true, [TOKEN]);
  assert.match(m2, /^Jeton refusé/);
  assert.ok(!m2.includes(TOKEN));
});

test('SecretStore : fichier chmod 600, MCP_TOKEN_<ID> prioritaire, vue sans valeur', () => {
  const dir = mkdtempSync(join(tmpdir(), 'es-sec-'));
  const p = join(dir, 'secrets', 'mcp.json');
  const s = new SecretStore(p, {});
  s.update('n8n', { token: TOKEN });
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, 'secrets')).mode & 0o777, 0o700);
  const v = s.view('n8n');
  assert.equal(v.bearer, true); assert.equal(v.tokenHint, '••••Z9k2'); assert.ok(!JSON.stringify(v).includes(TOKEN));
  assert.equal(new SecretStore(p, { MCP_TOKEN_N8N: 'from-env-123' }).get('n8n')?.token, 'from-env-123');
  s.update('n8n', { token: null }); assert.equal(s.has('n8n'), false);
});

// ---- Intégration : mcp-hub réel (processus) + serveur MCP factice exigeant un Bearer ----
let hub: ChildProcess; let fake: Fake; let base = ''; let cfgPath = ''; let secPath = '';
const api = async (path: string, init?: { method?: string; body?: unknown }) => {
  const r = await fetch(base + path, { method: init?.method ?? 'GET', headers: init?.body ? { 'Content-Type': 'application/json' } : undefined, body: init?.body ? JSON.stringify(init.body) : undefined });
  const text = await r.text();
  return { status: r.status, text, json: text ? JSON.parse(text) : null };
};

before(async () => {
  fake = await startFake(TOKEN);
  const dir = mkdtempSync(join(tmpdir(), 'es-hub-'));
  cfgPath = join(dir, 'mcp.config.json'); secPath = join(dir, 'secrets', 'mcp.json');
  writeFileSync(cfgPath, JSON.stringify({ servers: [] }));
  const port = 4900 + Math.floor(Math.random() * 90);
  base = `http://127.0.0.1:${port}`;
  hub = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, MCP_HUB_PORT: String(port), BIND_HOST: '127.0.0.1', MCP_CONFIG_PATH: cfgPath, MCP_SECRETS_PATH: secPath, ENV_FILE: join(dir, 'none.env'), ES_ROOT: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = ''; hub.stdout!.on('data', (d) => { logs += d; }); hub.stderr!.on('data', (d) => { logs += d; });
  (globalThis as { hubLogs?: () => string }).hubLogs = () => logs;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) return; } catch { /* démarrage */ } await new Promise((r) => setTimeout(r, 150)); }
  throw new Error('mcp-hub ne démarre pas : ' + logs);
});
after(async () => { hub?.kill(); await fake?.close(); });

test('sans jeton : erreur 401 claire en français', async () => {
  const r = await api('/servers', { method: 'POST', body: { id: 'fake', name: 'Factice', transport: 'http', url: `${fake.url}/mcp` } });
  assert.equal(r.json.status, 'error');
  assert.match(r.json.error, /^Le serveur demande une authentification : ajoute un jeton Bearer/);
  assert.equal(r.json.auth.bearer, false);
});

test('ajout du jeton sur un serveur en échec (PATCH) → connecté, Bearer envoyé à chaque requête, jamais renvoyé', async () => {
  fake.seen.length = 0;
  const r = await api('/servers/fake', { method: 'PATCH', body: { token: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'connected', r.json.error);
  assert.deepEqual(r.json.tools.map((t: { name: string }) => t.name), ['ping']);
  assert.ok(fake.seen.length >= 2 && fake.seen.every((a) => a === `Bearer ${TOKEN}`), `en-têtes vus : ${fake.seen.length}`);
  assert.deepEqual(r.json.auth, { bearer: true, tokenHint: '••••Z9k2', headerNames: [], source: 'fichier' });
  // Appel d'outil (autorisé) : l'en-tête part aussi sur les appels
  await api('/servers/fake', { method: 'PATCH', body: { allowedTools: ['ping'] } });
  const n = fake.seen.length;
  const call = await api('/call', { method: 'POST', body: { tool: 'fake__ping', args: {} } });
  assert.equal(call.json.data, 'pong');
  assert.ok(fake.seen.length > n && fake.seen.slice(n).every((a) => a === `Bearer ${TOKEN}`));
  // Le jeton n'apparaît NI dans l'API, NI dans la config, NI dans les journaux ; il est dans le fichier secret chmod 600
  for (const p of ['/servers', '/servers?apps=1', '/tools?allowedOnly=0', '/health']) assert.ok(!(await api(p)).text.includes(TOKEN), p);
  const cfg = readFileSync(cfgPath, 'utf8');
  assert.ok(!cfg.includes(TOKEN) && !/Bearer/.test(cfg));
  assert.deepEqual(JSON.parse(cfg).servers[0].auth, { secret: true });
  assert.ok(readFileSync(secPath, 'utf8').includes(TOKEN));
  assert.equal(statSync(secPath).mode & 0o777, 0o600);
  assert.ok(!(globalThis as { hubLogs?: () => string }).hubLogs!().includes(TOKEN));
});

test('mauvais jeton → « Jeton refusé » ; SSE avec jeton → connecté ; suppression du jeton', async () => {
  const bad = await api('/servers/fake', { method: 'PATCH', body: { token: 'mauvais-jeton-1234567' } });
  assert.equal(bad.json.status, 'error'); assert.match(bad.json.error, /^Jeton refusé/);
  assert.ok(!bad.text.includes('mauvais-jeton-1234567'));
  const sse = await api('/servers', { method: 'POST', body: { id: 'fake-sse', transport: 'sse', url: `${fake.url}/sse`, token: TOKEN, headers: { 'X-Client': 'es' } } });
  assert.equal(sse.json.status, 'connected', sse.json.error);
  assert.deepEqual(sse.json.auth.headerNames, ['X-Client']);
  assert.ok(!sse.text.includes(TOKEN));
  const del = await api('/servers/fake', { method: 'PATCH', body: { token: null } });
  assert.equal(del.json.auth.bearer, false); assert.equal(del.json.status, 'error');
  await api('/servers/fake-sse', { method: 'DELETE' });
  assert.ok(!existsSync(secPath) || !readFileSync(secPath, 'utf8').includes(TOKEN));
});
