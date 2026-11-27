// Parcours contre de VRAIS serveurs MCP (officiels @modelcontextprotocol/*), enregistrés avec scripts/mcp-add.mjs.
// Prérequis : serveurs « fs » (filesystem sur un dossier contenant seattle-weather.csv et co2-concentration.csv),
// « everything » (stdio) et « memory ». Usage : node scripts/e2e-real.mjs
const G = process.env.FORMULE_GATEWAY_URL ?? 'http://127.0.0.1:4000';
const j = async (path, body) => { const r = await fetch(G + path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); if (!r.ok) throw new Error(`${path} ${r.status} ${t.slice(0, 200)}`); return JSON.parse(t); };
async function run(prompt, approve = true) {
  const c = await j('/api/chat', { mode: 'agent', message: prompt });
  if (c.kind !== 'job') return { answer: c.text };
  let after = 0; const out = { events: [] };
  for (;;) {
    for (const e of (await j(`/api/jobs/${c.jobId}/log`)).filter((e) => e.seq > after)) {
      after = e.seq; out.events.push(e);
      if (e.type === 'source') { out.source = e.payload; if (approve && e.payload.canApprove) await j(`/api/jobs/${c.jobId}/approve`, {}); }
      if (e.type === 'log' && /Lecture|argument/.test(e.payload.text)) console.log(`   · ${e.payload.text}`);
      if (e.type === 'answer') { out.answer = e.payload.text; console.log(`   » ${e.payload.text}`); }
      if (e.type === 'certification') out.cert = e.payload;
      if (e.type === 'published') out.projectId = e.payload.projectId;
      if (e.type === 'job.done') return out;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}
let ok = true; const expect = (c, m) => { console.log(`   ${c ? '✓' : '✗'} ${m}`); if (!c) ok = false; };

console.log('\n▶ filesystem · seattle-weather.csv (données publiques réelles, 1 461 jours)');
let r = await run('Crée une interface des températures de Seattle depuis le fichier seattle-weather.csv avec une simulation');
expect(r.source?.sources[0]?.tool === 'read_text_file' && r.source.sources[0].rows === 1461, `lecture réelle : ${r.source?.sources[0]?.rows} lignes`);
expect(r.cert?.certified, r.cert?.message);
const seattle = r.projectId;

console.log('\n▶ filesystem · co2-concentration.csv');
r = await run('Crée une console du CO2 atmosphérique depuis co2-concentration.csv avec une simulation');
expect(r.cert?.certified, r.cert?.message);

console.log('\n▶ everything · objet structuré (argument énuméré tiré de la demande)');
r = await run('Crée une interface météo pour « Chicago » avec get-structured-content');
expect(r.cert?.certified, r.cert?.message);

console.log('\n▶ argument obligatoire inconnu : pas d’invention');
r = await run('Crée une interface météo avec get-structured-content');
expect(/arguments? obligatoires?/.test(r.answer ?? ''), 'blocage expliqué');

console.log('\n▶ memory · graphe vide : vide ≠ zéro, pas de succès fictif');
r = await run('Crée une interface du graphe de connaissances avec read_graph');
expect(!r.cert?.certified, r.answer ?? r.cert?.message);

console.log('\n▶ question sur l’app Seattle');
const q = await j('/api/chat', { mode: 'ask', message: 'Quelle est la dernière température max ?', projectId: seattle });
console.log(`   » ${q.text}`); expect(/observé|source/.test(q.text), 'fait + provenance');

console.log(ok ? '\nE2E réel : tout est vert.' : '\nE2E réel : des contrôles ont échoué.');
process.exit(ok ? 0 : 1);
