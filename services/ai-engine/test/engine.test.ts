import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generate, fix } from '../src/engine.ts';
import { MockProvider, noisy } from '../src/providers/mock.ts';
import { OpenAICompatibleProvider } from '../src/providers/openai.ts';
import { createProvider } from '../src/providers/index.ts';
import { extractHtml } from '../src/prompts.ts';
import { pickApp, applyIteration } from '../src/mock/catalog.ts';
import type { EngineEvent, RuntimeTool } from '../src/types.ts';
import type { McpClient } from '../src/mcp.ts';

const provider = new MockProvider(0);
const collect = () => { const events: EngineEvent[] = []; return { events, emit: (e: EngineEvent) => events.push(e) }; };

test('extractHtml retire les blocs Markdown et le bavardage', () => {
  const raw = 'Voici votre app :\n```html\n<!doctype html><html><body>ok</body></html>\n```\nBonne journée';
  assert.equal(extractHtml(raw), '<!doctype html><html><body>ok</body></html>');
});

test('le mock choisit une app selon les mots-clés', () => {
  assert.equal(pickApp('Fais-moi une calculatrice')?.id, 'calculatrice');
  assert.equal(pickApp('un minuteur pomodoro')?.id, 'pomodoro');
  assert.equal(pickApp('liste de tâches')?.id, 'todo');
  assert.equal(pickApp('quelle météo à Lyon')?.id, 'meteo');
  assert.equal(pickApp('un générateur de haïkus'), undefined);
});

test('generate : plan puis code streamés, HTML complet', async () => {
  const { events, emit } = collect();
  const r = await generate({ prompt: 'Une calculatrice' }, { provider, emit });
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'meta');
  assert.ok(types.indexOf('plan_done') < types.indexOf('code_done'));
  assert.ok(events.filter((e) => e.type === 'code_delta').length > 20, 'streaming token par token attendu');
  const streamed = events.filter((e) => e.type === 'code_delta').map((e) => (e as { text: string }).text).join('');
  assert.equal(extractHtml(streamed), r.code);
  assert.match(r.code, /^<!doctype html>/i);
  assert.match(r.plan, /^# Calculatrice/);
});

test('generate : mode diffusion → instantanés débruités, le dernier est le code final', async () => {
  const { events, emit } = collect();
  const r = await generate({ prompt: 'Un minuteur pomodoro', diffusing: true }, { provider, emit });
  const snaps = events.filter((e) => e.type === 'code_snapshot') as Array<{ text: string; step: number }>;
  assert.ok(snaps.length >= 10);
  assert.notEqual(snaps[0].text, r.code);
  assert.equal(extractHtml(snaps.at(-1)!.text), r.code);
  assert.equal(noisy('abc def', 0), 'abc def');
});

test('generate : appelle les outils MCP en lecture et injecte le résultat', async () => {
  const tools: RuntimeTool[] = [
    { id: 'demo__get_weather', name: 'get_weather', write: false, server: 'demo', inputSchema: { type: 'object', properties: { city: { type: 'string' } } } },
    { id: 'demo__add_note', name: 'add_note', write: true, server: 'demo' },
  ];
  const calls: string[] = [];
  const mcp: McpClient = {
    listTools: async () => tools,
    call: async (tool, args) => { calls.push(tool); return { data: { ville: (args as { city: string }).city, temperature_c: 12 } }; },
  };
  const { events, emit } = collect();
  const r = await generate({ prompt: 'Une app météo pour Lyon' }, { provider, emit, mcp });
  assert.deepEqual(calls, ['demo__get_weather'], 'seuls les outils en lecture sont appelés pendant la génération');
  assert.ok(events.some((e) => e.type === 'tool_result' && !('error' in e && e.error)));
  assert.match(r.code, /load\('Lyon'\)/);
  assert.match(r.code, /mcp\.call\('demo__get_weather'/);
});

test('itération : le code précédent est modifié selon la consigne', async () => {
  const first = await generate({ prompt: 'Une liste de tâches' }, { provider, emit: () => {} });
  const { emit } = collect();
  const second = await generate({ prompt: 'passe en thème clair et couleur verte', previousCode: first.code, previousPlan: first.plan }, { provider, emit });
  assert.notEqual(second.code, first.code);
  assert.match(second.code, /data-iteration/);
  assert.match(second.code, /--primary: #22c55e/);
  assert.doesNotMatch(second.code, /<html[^>]*class="dark"/);
  assert.match(second.code, /es-runtime\.js/);
  const t = applyIteration(first.code, 'titre : Mes courses');
  assert.match(t.code, /<title>Mes courses<\/title>/);
});

test('fix : supprime l\'erreur volontaire du mode [bug]', async () => {
  const bad = await generate({ prompt: 'Une calculatrice [bug]' }, { provider, emit: () => {} });
  assert.match(bad.code, /var resultat = ;/);
  const good = await fix({ prompt: 'Une calculatrice [bug]', code: bad.code, errors: [{ message: 'syntaxe' }] }, { provider, emit: () => {} });
  assert.doesNotMatch(good.code, /var resultat = ;/);
});

test('createProvider : Inception par défaut, repli mock sans clé', () => {
  const none = createProvider({});
  assert.equal(none.requested, 'inception');
  assert.equal(none.provider.name, 'mock');
  assert.ok(none.fallback);
  const inc = createProvider({ INCEPTION_API_KEY: 'test' });
  assert.equal(inc.provider.name, 'inception');
  assert.equal(inc.provider.model, 'mercury-3');
  const ds = createProvider({ LLM_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'test' });
  assert.equal(ds.provider.name, 'deepseek');
  assert.equal(ds.provider.model, 'deepseek-flash');
  assert.equal(ds.provider.supportsDiffusion, false);
  assert.equal(createProvider({ LLM_PROVIDER: 'mock' }).fallback, undefined);
});

test('provider compatible OpenAI : diffusing=true → instantanés complets', async () => {
  let received: any = null;
  const srv = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      received = JSON.parse(b);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const t of ['#?l▒o', 'Hel?o', 'Hello']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  }).listen(0);
  const port = (srv.address() as AddressInfo).port;
  const p = new OpenAICompatibleProvider({ name: 'inception', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'mercury-3', supportsDiffusion: true, maxTokensField: 'max_completion_tokens', extraBody: { reasoning_effort: 'low' } });
  const snaps: string[] = [];
  const out = await p.stream([{ role: 'user', content: 'x' }], { diffusing: true, onSnapshot: (s) => snaps.push(s), hint: { task: 'code', prompt: 'x' } });
  srv.close();
  assert.equal(out, 'Hello');
  assert.deepEqual(snaps, ['#?l▒o', 'Hel?o', 'Hello']);
  assert.equal(received.diffusing, true);
  assert.equal(received.model, 'mercury-3');
  assert.equal(received.reasoning_effort, 'low');
  assert.ok('max_completion_tokens' in received);
});
