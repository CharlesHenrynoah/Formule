// Parcours de bout en bout contre une instance lancée (npm run dev) : création, validation des sources,
// certification, question, évolution incrémentale, action confirmée. Usage : node scripts/e2e.mjs
const G = process.env.FORMULE_GATEWAY_URL ?? 'http://127.0.0.1:4000';
const j = async (path, body, method) => {
  const r = await fetch(G + path, { method: method ?? (body ? 'POST' : 'GET'), headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let x; try { x = JSON.parse(t); } catch { x = t; }
  if (!r.ok) throw Object.assign(new Error(`${path} ${r.status} ${t.slice(0, 200)}`), { status: r.status, body: x });
  return x;
};
async function follow(jobId, onSource) {
  let after = 0; const seen = [];
  for (;;) {
    const evs = await j(`/api/jobs/${jobId}/log`);
    for (const e of evs.filter((e) => e.seq > after)) {
      after = e.seq; seen.push(e);
      if (e.type === 'job.state') console.log(`   · ${e.payload.from} → ${e.payload.to}`);
      if (e.type === 'source') await onSource?.(e.payload);
      if (e.type === 'answer') console.log(`   » ${e.payload.text}`);
      if (e.type === 'job.done') return seen;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}
const step = (s) => console.log(`\n▶ ${s}`);
let ok = true; const expect = (c, m) => { if (!c) { ok = false; console.log(`   ✗ ${m}`); } else console.log(`   ✓ ${m}`); };

step('Question simple (aucune app créée)');
const before = (await j('/api/projects')).length;
const a = await j('/api/chat', { mode: 'ask', message: 'Quel est le revenu du mois ?' });
console.log(`   » ${a.text}`);
expect(a.kind === 'answer' && /EUR/.test(a.text) && (await j('/api/projects')).length === before, 'réponse factuelle, pas de projet');

step('Écriture demandée en Ask : refusée');
const refused = await j('/api/chat', { mode: 'ask', message: 'Crée une interface du pipeline commercial' });
expect(/Passe en Agent/.test(refused.text), refused.text);

step('Création : Revenu du mois');
const c = await j('/api/chat', { mode: 'agent', message: 'Crée une interface du revenu du mois avec le détail des factures' });
expect(c.kind === 'job', 'job de construction démarré');
let evs = await follow(c.jobId, async (s) => { console.log(`   sources : ${s.sources.map((x) => `${x.tool} ${x.status} ${x.rows ?? ''}`).join(', ')}`); expect(s.canApprove, 'Valider actif'); await j(`/api/jobs/${c.jobId}/approve`, {}); });
const cert = evs.find((e) => e.type === 'certification');
expect(cert?.payload.certified, `certifiée (${cert?.payload.message})`);
const projectId = evs.find((e) => e.type === 'published')?.payload.projectId;

step('Question sur l’interface');
const q = await j('/api/chat', { mode: 'ask', message: 'Quel est le revenu du mois ?', projectId });
console.log(`   » ${q.text}`);
expect(/EUR, observé à/.test(q.text), 'fait d’abord, unité, heure, provenance');

step('Changement de style : aucune collecte');
const s1 = await j('/api/chat', { mode: 'agent', message: 'Renomme en Revenu · Novembre', projectId });
evs = await follow(s1.jobId);
expect(evs.some((e) => e.type === 'log' && /aucune collecte/.test(e.payload.text)), 'pas de nouvelle lecture');
expect(evs.some((e) => e.type === 'certification' && e.payload.certified), 'v2 certifiée');

step('Ajout incrémental : classement par client');
const s2 = await j('/api/chat', { mode: 'agent', message: 'Ajoute un classement par client', projectId });
evs = await follow(s2.jobId);
const g7 = evs.find((e) => e.type === 'certification')?.payload.gates.find((g) => g.gate === 'G7');
expect(g7?.passed, `non-régression : ${g7?.details.join(' ; ')}`);

step('Exigence impossible : livraison partielle');
const p = await j('/api/chat', { mode: 'agent', message: 'Crée une console publicités rentables avec le CAC' });
evs = await follow(p.jobId, async () => j(`/api/jobs/${p.jobId}/approve`, {}));
const pc = evs.find((e) => e.type === 'certification');
expect(pc && !pc.payload.certified && /Non certifiée complète/.test(pc.payload.message), pc?.payload.message);

step('Action : préparer → confirmation exacte → exécuter');
const pubs = await j('/api/chat', { mode: 'agent', message: 'Crée une interface des publicités rentables' });
evs = await follow(pubs.jobId, async () => j(`/api/jobs/${pubs.jobId}/approve`, {}));
const adsProject = evs.find((e) => e.type === 'published')?.payload.projectId;
const act = await j('/api/chat', { mode: 'agent', message: 'Mets en pause la campagne la moins rentable', projectId: adsProject });
console.log(`   » ${act.text}`);
expect(act.kind === 'confirm', 'carte de confirmation');
try { await j(`/api/actions/${act.card.opId}/execute`, { args: { ...act.card.args, campagne_id: 'CMP-1' }, projectId: adsProject }); expect(false, 'arguments modifiés acceptés !'); }
catch (e) { expect(e.status === 409 || e.status === 428, `arguments modifiés refusés (${e.status})`); }
const act2 = await j('/api/chat', { mode: 'agent', message: 'Mets en pause la campagne la moins rentable', projectId: adsProject });
const done = await j(`/api/actions/${act2.card.opId}/execute`, { args: act2.card.args, projectId: adsProject });
expect(done.status === 'done', done.text);
try { await j(`/api/actions/${act2.card.opId}/execute`, { args: act2.card.args, projectId: adsProject }); expect(false, 'double exécution !'); }
catch (e) { expect(e.status === 409, 'pas de seconde exécution'); }

console.log(ok ? '\nE2E : tout est vert.' : '\nE2E : des contrôles ont échoué.');
process.exit(ok ? 0 : 1);
