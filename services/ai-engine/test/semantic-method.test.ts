import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRestriction, dropOptionalArgument, planAcquisitions } from '../src/agent/engine/execute-code.ts';
import { claimsFromPrompt } from '../src/agent/engine/chain.ts';
import { acquisitionsOf, attemptKey, callIdentity, methodFits, registerMethods, requirementsOf, responseInScope, selectMethod, type MethodDoc } from '../src/agent/engine/sdk-scope.ts';
import { collectSource } from '../src/agent/engine/source-offer.ts';

const catalog: MethodDoc[] = [
  { method: 'client.catalog.totals', summary: 'totaux de tout le catalogue', response: '{ active_count: number, total_market_cap: number }', params: '' },
  { method: 'client.items.get', summary: 'une fiche', params: 'id: string; currency?: string', response: '{ id: string, name: string, price: number, market_cap: number }' },
  { method: 'client.items.list', summary: 'liste des fiches', params: 'currency?: string; limit?: number', response: '[{ name: string, price: number, volume: number, market_cap: number }]' },
  { method: 'client.items.history', summary: 'historique', params: 'id: string; days?: number', response: '[{ timestamp: string, price: number }]' },
];

test('quatre périmètres qui partagent des nombres ne sont pas la même méthode', () => {
  const methods = registerMethods(catalog);
  const byName = Object.fromEntries(methods.map((method) => [method.method, method.scope]));
  assert.equal(byName['client.catalog.totals'], 'global');
  assert.equal(byName['client.items.get'], 'individuel');
  assert.equal(byName['client.items.list'], 'agrege');
  assert.equal(byName['client.items.history'], 'historique');
});

test('la méthode retenue couvre l’entité, la mesure et la granularité', () => {
  const methods = registerMethods(catalog);
  const one = requirementsOf('Affiche le prix de Orion.');
  assert.equal(one.scope, 'individuel');
  assert.equal(one.ui.includes('Orion'), false);
  assert.deepEqual(selectMethod(methods, one)?.method.method, 'client.items.get');
  assert.equal(methodFits(methods[0]!, one).ok, false);

  const curve = requirementsOf('Affiche la courbe du prix sur 30 jours.');
  assert.equal(curve.grain, 'serie');
  assert.equal(curve.periods.length > 0, true);
  assert.equal(curve.measures.some((measure) => /30 jours/.test(measure)), false);
  assert.equal(selectMethod(methods, curve)?.method.method, 'client.items.history');

  const list = requirementsOf('Affiche le tableau du top 10 par capitalisation.');
  assert.equal(list.scope, 'agrege');
  assert.equal(selectMethod(methods, list)?.method.method, 'client.items.list');

  const totals = requirementsOf('Affiche le total global.');
  assert.equal(selectMethod(methods, totals)?.method.method, 'client.catalog.totals');
});

test('un titre et une carte ne sont pas des exigences d’acquisition', () => {
  const req = requirementsOf('Affiche le prix. Titre "Orion en direct". Mets 4 cartes KPI.');
  assert.ok(req.ui.some((label) => /Orion en direct/.test(label)));
  assert.equal(req.measures.includes('Orion en direct'), false);
  assert.equal(req.measures.includes('cartes'), false);
  assert.ok(req.measures.includes('prix'));
});

test('le schéma attendu écarte un agrégat global avant l’appel', () => {
  const planned = planAcquisitions('Affiche le prix de Orion.', catalog);
  assert.equal(planned.find((item) => item.claim === 'prix')?.hint?.method, 'client.items.get');
  const rows = [{ active_count: 12, total_market_cap: 90 }];
  const verdict = responseInScope(rows, requirementsOf('Affiche le prix de Orion.'));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.scopeMismatch, true);
  assert.match(verdict.reason, /global/);
});

test('deux scripts de la même méthode et des mêmes arguments sont une seule tentative', () => {
  const code = 'async function run(client) { return client.items.get({ id: "orion", currency: "eur" }); }';
  const fact = callIdentity(code)[0];
  assert.equal(fact?.method, 'client.items.get');
  assert.equal(attemptKey(fact!.method, fact!.args, ['prix']), attemptKey('client.items.get', 'currency="eur"&id="orion"', ['prix']));
});

test('une réponse hors périmètre fait choisir une autre méthode, sur deux MCP', async () => {
  const calls: string[] = [];
  const offer = await collectSource(
    'Affiche le prix de Orion.',
    '',
    async () => ([
      { id: 'atlas__search_docs', description: 'docs SDK', serverName: 'Atlas', schema: { required: ['query'], properties: { query: { type: 'string' } } } },
      { id: 'atlas__execute', description: 'Runs JavaScript code to interact with the API', serverName: 'Atlas', schema: { required: ['code'], properties: { code: { type: 'string' } } } },
    ]),
    async (tool, args) => {
      calls.push(tool);
      if (tool === 'atlas__search_docs') return catalog.map((doc) => ({ ...doc }));
      const code = String(args.code ?? '');
      if (/catalog\.totals/.test(code)) return [{ active_count: 12, total_market_cap: 90 }];
      return [{ id: 'orion', name: 'Orion', price: 4, market_cap: 8 }];
    },
    async () => '{"reads":[{"tool":"atlas__search_docs","args":{"query":"prix"}}]}',
    async (mission) => {
      if (!/Méthodes exclues/.test(mission)) return 'async function run(client) { return client.catalog.totals(); }';
      assert.match(mission, /client\.catalog\.totals/);
      assert.match(mission, /client\.items\.get/);
      return 'async function run(client) { return client.items.get("orion"); }';
    },
  );
  assert.equal(calls.filter((tool) => tool === 'atlas__execute').length, 1);
  assert.equal(offer.canBuild, true);
  assert.equal(offer.samples[0]?.rows[0]?.price, 4);
  assert.match(offer.log, /client\.items\.get/);
  assert.match(offer.log, /périmètre/);
  assert.match(offer.log, /progression/);
});

test('un second MCP ne prend pas les statistiques globales pour une liste', async () => {
  const docs = [
    { method: 'client.repos.stats', summary: 'stats globales du dépôt', response: '{ stars: number, forks: number }', params: 'owner: string; repo: string' },
    { method: 'client.issues.list', summary: 'liste des issues', params: 'owner: string; repo: string; state?: string', response: '[{ title: string, state: string }]' },
  ];
  const calls: string[] = [];
  const offer = await collectSource(
    'Montre le tableau des issues ouvertes du dépôt acme/widgets, avec le statut.',
    '',
    async () => ([
      { id: 'depot__search_docs', description: 'docs SDK', serverName: 'Depot', schema: { required: ['query'], properties: { query: { type: 'string' } } } },
      { id: 'depot__execute', description: 'Runs JavaScript code to interact with the API', serverName: 'Depot', schema: { required: ['code'], properties: { code: { type: 'string' } } } },
    ]),
    async (tool, args) => {
      calls.push(tool + (String(args.code ?? '').includes('repos.stats') ? ':stats' : String(args.code ?? '').includes('issues.list') ? ':issues' : ''));
      if (tool.endsWith('search_docs')) return docs;
      if (String(args.code).includes('repos.stats')) return [{ stars: 3, forks: 1 }];
      return [{ title: 'bug', state: 'open' }, { title: 'doc', state: 'closed' }];
    },
    async () => '{"reads":[{"tool":"depot__search_docs","args":{"query":"issues"}}]}',
    async (mission) => {
      if (!/issues\.list/.test(mission)) return 'async function run(client) { return client.repos.stats({ owner: "acme", repo: "widgets" }); }';
      return 'async function run(client) { return client.issues.list("acme", { repo: "widgets", state: "open" }); }';
    },
  );
  assert.equal(calls.includes('depot__execute:stats'), false);
  assert.equal(calls.includes('depot__execute:issues'), true);
  assert.equal(offer.canBuild, true);
  assert.equal(offer.samples[0]?.rows[0]?.state, 'open');
});

test('une méthode qui couvre deux mesures n’est appelée qu’une fois', async () => {
  let writes = 0;
  let executions = 0;
  const offer = await collectSource(
    'Affiche le prix et le volume.',
    '',
    async () => ([
      { id: 'box__search_docs', description: 'docs SDK', serverName: 'Box', schema: { required: ['query'], properties: { query: { type: 'string' } } } },
      { id: 'box__execute', description: 'Runs JavaScript code to interact with the API', serverName: 'Box', schema: { required: ['code'], properties: { code: { type: 'string' } } } },
    ]),
    async (tool) => {
      if (tool.endsWith('search_docs')) return [{ method: 'client.items.list', summary: 'liste', params: 'limit?: number', response: '[{ name: string, price: number, volume: number }]' }];
      executions += 1;
      return [{ name: 'nord', price: 2, volume: 5 }, { name: 'sud', price: 3, volume: 8 }];
    },
    async () => '{"reads":[{"tool":"box__search_docs","args":{"query":"prix"}}]}',
    async () => {
      writes += 1;
      return 'async function run(client) { return client.items.list({ limit: 10 }); }';
    },
  );
  assert.equal(writes, 1);
  assert.equal(executions, 1);
  assert.equal(offer.canBuild, true);
});

test('une série documentée écarte le cliché qui porte le même prix', async () => {
  const methods = registerMethods(catalog);
  const curve = requirementsOf('Affiche la courbe du prix sur 30 jours.');
  assert.equal(selectMethod(methods, curve)?.method.method, 'client.items.history');
  const point = responseInScope([{ name: 'Orion', price: 4 }], curve);
  assert.equal(point.ok, false);
  const series = responseInScope([{ timestamp: '2026-11-01', price: 4 }, { timestamp: '2026-11-02', price: 5 }], curve);
  assert.equal(series.ok, true);
});

test('une demande mélange instantané, historique et agrégat', () => {
  const plan = acquisitionsOf('Affiche le prix et le volume de Orion, la courbe du prix sur 30 jours, et le top 10 par capitalisation.');
  const grains = plan.map((item) => item.grain).sort();
  assert.deepEqual(grains, ['liste', 'point', 'serie']);
  const serie = plan.find((item) => item.grain === 'serie')!;
  const point = plan.find((item) => item.grain === 'point')!;
  assert.deepEqual(serie.measures, ['prix']);
  assert.ok(point.measures.includes('volume'));
  assert.equal(serie.measures.includes('volume'), false);
  assert.equal(serie.measures.includes('capitalisation'), false);
  const rows = [{ timestamp: '2026-11-01', price: 4 }, { timestamp: '2026-11-02', price: 5 }];
  assert.equal(responseInScope(rows, serie).ok, true);
  assert.equal(responseInScope(rows, point).ok, false);
});

test('trois cartes est une quantité, pas une entité', () => {
  const claims = claimsFromPrompt('Ajoute Trois cartes du prix de Orion.');
  assert.equal(claims.some((claim) => claim.kind === 'entite' && /trois/i.test(claim.text)), false);
  assert.equal(claims.some((claim) => claim.kind === 'entite' && claim.text === 'Orion'), true);
  assert.equal(claims.some((claim) => claim.kind === 'mesure' && claim.text === 'prix'), true);
});

test('l’entité et l’unité portées par les arguments restent tenues', () => {
  const one = requirementsOf('Affiche le prix de Orion en EUR.');
  const verdict = responseInScope([{ price: 4 }], one, { args: 'id="orion" currency="eur"' });
  assert.equal(verdict.ok, true);
  assert.ok(verdict.carried.some((item) => /orion/i.test(item)));
  assert.ok(verdict.carried.some((item) => /eur/i.test(item)));
});

test('une restriction de paramètre optionnel retombe sur l’alternative autorisée', async () => {
  const calls: string[] = [];
  assert.equal(classifyRestriction('403 {"error":"plan_restricted","message":"The optional parameter interval is available on a paid plan"}'), 'PARAMETER_RESTRICTION');
  assert.equal(classifyRestriction('401 unauthorized'), 'AUTH_INVALID');
  assert.equal(dropOptionalArgument('client.items.history({ id: "orion", interval: "hourly", days: 30 })', 'interval')?.includes('interval'), false);
  const offer = await collectSource(
    'Affiche la courbe du prix sur 30 jours.',
    '',
    async () => ([
      { id: 'atlas__search_docs', description: 'docs SDK', serverName: 'Atlas', schema: { required: ['query'], properties: { query: { type: 'string' } } } },
      { id: 'atlas__execute', description: 'Runs JavaScript code to interact with the API', serverName: 'Atlas', schema: { required: ['code'], properties: { code: { type: 'string' } } } },
    ]),
    async (tool, args) => {
      const code = String(args.code ?? '');
      calls.push(code);
      if (tool.endsWith('search_docs')) return catalog;
      if (/interval/.test(code)) throw new Error('403 {"error":"plan_restricted","message":"The optional parameter interval is available on a paid plan"}');
      return [{ timestamp: '2026-11-01', price: 4 }, { timestamp: '2026-11-02', price: 5 }];
    },
    async () => '{"reads":[{"tool":"atlas__search_docs","args":{"query":"prix"}}]}',
    async () => 'async function run(client) { return client.items.history("orion", { interval: "hourly", days: 30 }); }',
  );
  assert.equal(calls.filter((code) => /interval/.test(code)).length, 1);
  assert.equal(calls.some((code) => /items\.history/.test(code) && !/interval/.test(code)), true);
  assert.equal(offer.canBuild, true);
  assert.match(offer.log, /PARAMETER_RESTRICTION|paramètre interval retiré/);
});

test('un échec local laisse vivre les autres acquisitions', async () => {
  const calls: string[] = [];
  const offer = await collectSource(
    'Affiche le prix de Orion et le total global.',
    '',
    async () => ([
      { id: 'atlas__search_docs', description: 'docs SDK', serverName: 'Atlas', schema: { required: ['query'], properties: { query: { type: 'string' } } } },
      { id: 'atlas__execute', description: 'Runs JavaScript code to interact with the API', serverName: 'Atlas', schema: { required: ['code'], properties: { code: { type: 'string' } } } },
    ]),
    async (tool, args) => {
      const code = String(args.code ?? '');
      calls.push(code || tool);
      if (tool.endsWith('search_docs')) return catalog;
      if (/items\.get/.test(code)) throw new Error('401 unauthorized');
      if (/catalog\.totals/.test(code)) return [{ active_count: 12, total_market_cap: 90 }];
      return [];
    },
    async () => '{"reads":[{"tool":"atlas__search_docs","args":{"query":"prix"}}]}',
    async (mission) => {
      const imposed = mission.match(/Méthode imposée : (\S+)/)?.[1] ?? '';
      if (imposed === 'client.catalog.totals') return 'async function run(client) { return client.catalog.totals(); }';
      return 'async function run(client) { return client.items.get("orion"); }';
    },
  );
  assert.equal(calls.some((code) => /items\.get/.test(code)), true);
  assert.equal(calls.some((code) => /catalog\.totals/.test(code)), true);
  assert.equal(offer.canBuild, false);
  assert.equal(offer.samples.some((sample) => sample.rows.some((row) => row.total_market_cap === 90)), true);
  assert.match(offer.text, /total/);
  assert.match(offer.log, /AUTH_INVALID|auth/);
  assert.doesNotMatch(offer.text, /Données obtenues : aucune/);
});
