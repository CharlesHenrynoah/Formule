// E2E contrat analytique contre une instance lancée (npm run dev).
// Usage : node scripts/e2e-contract.mjs
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
      if (e.type === 'source') await onSource?.(e.payload);
      if (e.type === 'job.done') return seen;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}
let ok = true;
const expect = (c, m) => { if (!c) { ok = false; console.log(`   ✗ ${m}`); } else console.log(`   ✓ ${m}`); };

console.log('\n▶ Contrat figé → liaison → certification');
const prompt = [
  'Crée une interface marché :',
  '- Nombre d’éléments',
  '- Prix de Bitcoin',
  '- Courbe du prix',
].join('\n');
const c = await j('/api/chat', { mode: 'agent', message: prompt });
expect(c.kind === 'job', 'job démarré');
const evs = await follow(c.jobId, async (s) => {
  expect(s.canApprove || s.requirements?.length > 0, 'sources / exigences présentées');
  if (s.canApprove) await j(`/api/jobs/${c.jobId}/approve`, {});
});
const logs = evs.filter((e) => e.type === 'log').map((e) => e.payload.text ?? '');
expect(logs.some((t) => /Contrat analytique figé/.test(t)), 'contrat figé avant lecture');
expect(logs.some((t) => /Lien ·/.test(t)), 'liaison point par point');
const cert = evs.find((e) => e.type === 'certification');
expect(!!cert, `certification émise (${cert?.payload?.message ?? '∅'})`);

console.log('\n▶ Exigence impossible nommée (négatif)');
const bad = await j('/api/chat', { mode: 'agent', message: 'Crée une interface : Prix de EntiteInexistanteXYZ en USD sur le marche options en 2019' });
const badEvs = await follow(bad.jobId, async (s) => { if (s.canApprove) await j(`/api/jobs/${bad.jobId}/approve`, {}); });
const blocked = badEvs.some((e) => e.type === 'job.state' && e.payload.to === 'BLOCKED')
  || badEvs.some((e) => e.type === 'answer' && /compatible|indisponible|aucune/i.test(e.payload.text ?? ''));
const partial = badEvs.find((e) => e.type === 'certification');
expect(blocked || (partial && !partial.payload.certified), 'échec ou non-certification sur contrat impossible');

console.log(ok ? '\nOK contrat e2e' : '\nÉCHEC contrat e2e');
process.exit(ok ? 0 : 1);
