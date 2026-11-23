// Test de bout en bout via l'api-gateway (services lancés : npm run dev).
// Usage : node scripts/e2e.mjs [http://localhost:4000]
import { readFileSync } from 'node:fs';
const GW = process.argv[2] ?? 'http://localhost:4000';
// Mode public : E2E_ACCESS_FILE=.access → en-tête Basic Auth (le secret n'est jamais affiché)
const AUTH = process.env.E2E_ACCESS_FILE ? { Authorization: 'Basic ' + Buffer.from(readFileSync(process.env.E2E_ACCESS_FILE, 'utf8').trim()).toString('base64') } : {};
const _fetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => _fetch(url, { ...init, headers: { ...AUTH, ...(init.headers ?? {}) } });
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✖'} ${msg}`); if (!cond) failures++; };

async function generate(body) {
  const res = await fetch(`${GW}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'direct', ...body }) });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; const events = [];
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true }); let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const l of chunk.split('\n')) if (l.startsWith('data:')) events.push(JSON.parse(l.slice(5)));
    }
  }
  const count = (t) => events.filter((e) => e.type === t).length;
  return { events, count, get: (t) => events.find((e) => e.type === t) };
}
const json = (path, init) => fetch(`${GW}${path}`, init).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (path, body) => json(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const health = await json('/health');
ok(health.body.status === 'ok', `santé globale : ${health.body.status} (${Object.keys(health.body.services).join(', ')})`);

const t0 = Date.now();
const a = await generate({ prompt: 'Une calculatrice' });
ok(a.count('plan_delta') > 5 && a.count('code_delta') > 50, `streaming : ${a.count('plan_delta')} morceaux de plan, ${a.count('code_delta')} morceaux de code en ${Date.now() - t0} ms`);
ok(a.get('validation')?.ok === true, 'validation OK du premier coup');
const saved = a.get('saved');
ok(!!saved?.projectId && saved.number === 1, `enregistré : projet ${saved?.projectId} v${saved?.number} « ${saved?.title} »`);

const it = await generate({ prompt: 'passe en thème clair, couleur verte', projectId: saved.projectId });
ok(it.get('saved')?.number === 2 && /data-iteration/.test(it.get('done')?.code ?? ''), 'itération → v2 avec modifications');

const p = await json(`/api/projects/${saved.projectId}`);
ok(p.body.versions.length === 2 && p.body.versions[1].kind === 'iterate', `storage : ${p.body.versions.length} versions relues depuis SQLite`);

const ed = await post(`/api/projects/${saved.projectId}/versions`, { code: p.body.versions[1].code.replace('Calculatrice', 'Ma calculette') });
ok(ed.status === 201 && ed.body.number === 3 && ed.body.validation.ok, 'édition manuelle → v3 validée');

const bug = await generate({ prompt: 'Un minuteur pomodoro [bug]' });
const vals = bug.events.filter((e) => e.type === 'validation');
ok(vals.length === 2 && !vals[0].ok && vals[1].ok && bug.events.some((e) => e.type === 'phase' && e.phase === 'fix'),
  `validator → correction auto : tentative 1 = ${vals[0]?.errors?.map((e) => e.code).join(',')}, tentative 2 = ${vals[1]?.ok ? 'OK' : 'KO'}`);

const dif = await generate({ prompt: "Un convertisseur d'unités", diffusing: true });
ok(dif.count('code_snapshot') >= 10 && dif.get('meta')?.diffusing === true, `mode diffusion : ${dif.count('code_snapshot')} instantanés de débruitage`);

const met = await generate({ prompt: 'Une app météo pour Lyon' });
const tc = met.get('tool_call'); const tr = met.get('tool_result');
ok(tc?.name === 'demo__get_weather' && tr?.result?.ville === 'Lyon', `MCP pendant la génération : ${tc?.name}(${JSON.stringify(tc?.args)}) → ${tr?.result?.temperature_c}°C ${tr?.result?.condition}`);
ok(/load\('Lyon'\)/.test(met.get('done')?.code ?? ''), "le résultat MCP est intégré dans l'app générée");

const tools = await json('/api/mcp/tools');
ok(tools.body.length >= 5, `outils MCP autorisés : ${tools.body.map((t) => t.id + (t.write ? '[écriture]' : '')).join(', ')}`);
const r1 = await post('/api/mcp/call', { tool: 'demo__get_time', args: { timezone: 'Europe/Paris' } });
ok(r1.status === 200 && !!r1.body.data?.local, `pont d'exécution : demo__get_time → ${r1.body.data?.local}`);
const r2 = await post('/api/mcp/call', { tool: 'demo__add_note', args: { text: 'test e2e' } });
ok(r2.status === 428 && r2.body.needsConfirmation, 'outil en écriture sans confirmation → 428 (confirmation requise)');
const r3 = await post('/api/mcp/call', { tool: 'demo__add_note', args: { text: 'test e2e' }, confirmed: true });
ok(r3.status === 200 && r3.body.data?.ajoutee?.text === 'test e2e', 'outil en écriture avec confirmation → exécuté');
await json('/api/mcp/servers/demo', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allowedTools: ['get_weather', 'get_time', 'list_notes', 'add_note'] }) });
const r4 = await post('/api/mcp/call', { tool: 'demo__calculate', args: { expression: '2+2' } });
ok(r4.status === 403, 'outil retiré de la liste blanche → 403');
await json('/api/mcp/servers/demo', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allowedTools: ['get_weather', 'get_time', 'calculate', 'list_notes', 'add_note'] }) });
const r5 = await post('/api/mcp/servers', { id: 'x', transport: 'stdio', command: 'sh' });
ok(r5.status === 403, "ajout d'un serveur stdio depuis l'UI refusé par défaut");

// ---- Équipe d'agents : Data Engineer → Product Owner → Développeur (CLI shadcn + vite build) → revue PO ----
const ta = Date.now();
const ag = await generate({ prompt: 'Une app météo pour Lyon [revue]', mode: 'agent' });
const A = ag.events.filter((e) => e.type === 'agent');
const roleSeq = A.filter((e) => e.kind === 'role').map((e) => e.role).join('→');
ok(/^data→po→dev→po→dev→po/.test(roleSeq), `chaîne d'agents : ${roleSeq}`);
const brief = A.find((e) => e.kind === 'brief');
ok(brief?.relevant && /demo__get_weather/.test(brief.text) && /Schéma des données/.test(brief.text), 'Data Engineer : brief données depuis un échantillon MCP réel');
ok(A.some((e) => e.kind === 'tool' && e.role === 'data' && e.tool === 'mcp_call'), 'Data Engineer : appel MCP en lecture');
const spec = A.find((e) => e.kind === 'spec');
ok(/User stories/.test(spec?.text ?? '') && /Critères d'acceptation/.test(spec?.text ?? '') && spec.components.includes('card'), `Product Owner : spec (${spec?.components?.join(', ')})`);
const clis = A.filter((e) => e.kind === 'cli');
ok(clis.some((e) => e.ok && /^npx shadcn@latest add /.test(e.command)) && clis.some((e) => e.ok && e.command === 'vite build'), `Développeur : ${clis.map((e) => e.command.split(' ').slice(0, 3).join(' ')).join(' | ')}`);
const reviews = A.filter((e) => e.kind === 'review');
ok(reviews.length === 2 && reviews[0].verdict === 'a_corriger' && reviews[1].verdict === 'ok', `revue PO : ${reviews.map((r) => r.verdict).join(' → ')}`);
const agDone = ag.get('done');
ok(agDone?.mode === 'agent' && agDone.validation.ok && /^<!doctype html>/i.test(agDone.code) && !!agDone.files?.['src/App.tsx'], `app agent validée (${Math.round(agDone.code.length / 1024)} Ko mono-fichier, ${Object.keys(agDone.files ?? {}).length} fichiers source) en ${Date.now() - ta} ms`);
const agSaved = ag.get('saved');
const agProj = await json(`/api/projects/${agSaved.projectId}`);
ok(agProj.body.versions[0].files?.['src/App.tsx'] && agProj.body.versions[0].agent?.trace?.length > 10, 'fichiers source + trace agent enregistrés');
const agIt = await generate({ prompt: 'passe en thème clair, couleur verte', projectId: agSaved.projectId, mode: 'agent' });
const itDone = agIt.get('done');
ok(itDone?.mode === 'agent' && /#22c55e/.test(itDone.code) && !/<html[^>]*class="dark"/.test(itDone.code), "itération par l'agent sur les fichiers existants → thème clair + vert");
const calc = await generate({ prompt: 'Une calculatrice', mode: 'agent' });
const cb = calc.events.find((e) => e.type === 'agent' && e.kind === 'brief');
ok(cb && !cb.relevant && /^Aucune source MCP pertinente/.test(cb.text) && calc.get('done')?.validation?.ok, 'Data Engineer : « aucune source pertinente » puis la chaîne continue');

console.log(failures ? `\n${failures} échec(s)` : '\nTout est vert ✅');
process.exit(failures ? 1 : 0);
