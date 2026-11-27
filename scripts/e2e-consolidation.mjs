// E2E consolidation post PR#6/#7 — formulations variées, multi-MCP, traçabilité.
// Prérequis : stack lancée (npm run dev). Usage : node scripts/e2e-consolidation.mjs
const G = process.env.FORMULE_GATEWAY_URL ?? 'http://127.0.0.1:4000';
const j = async (path, body, method) => {
  const r = await fetch(G + path, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let x; try { x = JSON.parse(t); } catch { x = t; }
  if (!r.ok) throw Object.assign(new Error(`${path} ${r.status} ${t.slice(0, 200)}`), { status: r.status, body: x });
  return x;
};

async function follow(jobId, { approve = true } = {}) {
  let after = 0;
  const seen = [];
  for (;;) {
    const evs = await j(`/api/jobs/${jobId}/log`);
    for (const e of evs.filter((e) => e.seq > after)) {
      after = e.seq;
      seen.push(e);
      if (e.type === 'source' && approve && e.payload?.canApprove) {
        await j(`/api/jobs/${jobId}/approve`, {});
      }
      if (e.type === 'job.done') return seen;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
}

let ok = true;
const expect = (c, m) => {
  console.log(`   ${c ? '✓' : '✗'} ${m}`);
  if (!c) ok = false;
};

const prompts = [
  {
    name: 'marché crypto compact',
    text: 'Crée une interface marché : capitalisation totale, prix de Bitcoin, courbe BTC 30 jours.',
  },
  {
    name: 'formulation longue / sections',
    text: [
      'Interface analytique',
      '1. KPI du nombre d’actifs suivis',
      '2. Tableau des trois premiers',
      '3. Classement des performances',
    ].join('\n'),
  },
  {
    name: 'fichier CSV (filesystem si présent)',
    text: 'Crée une interface des températures depuis le fichier seattle-weather.csv',
  },
];

console.log('\n▶ Consolidation · formulations variées');
for (const p of prompts) {
  console.log(`\n· ${p.name}`);
  const c = await j('/api/chat', { mode: 'agent', message: p.text });
  expect(c.kind === 'job', `${p.name} : job démarré`);
  if (c.kind !== 'job') continue;
  const evs = await follow(c.jobId);
  const logs = evs.filter((e) => e.type === 'log').map((e) => e.payload?.text ?? '');
  const source = evs.find((e) => e.type === 'source')?.payload;
  const cert = evs.find((e) => e.type === 'certification')?.payload;
  const answer = evs.filter((e) => e.type === 'answer').map((e) => e.payload?.text ?? '').join(' ');

  expect(logs.some((t) => /Contrat analytique (figé|scellé)/.test(t)), `${p.name} : contrat scellé`);
  expect(!logs.some((t) => /Lecture .*search_docs/i.test(t)), `${p.name} : pas d’acquisition docs parasite`);
  expect(
    source?.contractFingerprint || logs.some((t) => /fingerprint|scellé/i.test(t)),
    `${p.name} : empreinte contrat traçable`,
  );
  // Budget exposé ou acquisition bornée
  expect(
    source?.mcpBudget != null || source?.llmBudgetUsed != null || logs.some((t) => /budget MCP/i.test(t)),
    `${p.name} : budgets visibles`,
  );
  // Chaque exigence présentée doit avoir un statut + label (traçabilité)
  if (source?.requirements?.length) {
    expect(
      source.requirements.every((r) => r.id && r.label && r.status),
      `${p.name} : exigences traçables (${source.requirements.length})`,
    );
  }
  const terminal = cert || /BLOCKED|Échec|compatible|couvre pas/i.test(answer);
  expect(!!terminal, `${p.name} : issue explicite (certif ou blocage) — ${cert?.message ?? answer.slice(0, 80)}`);
}

console.log('\n▶ Consolidation · args invalides / négatif');
{
  const c = await j('/api/chat', { mode: 'agent', message: 'Interface météo avec get-structured-content sans ville' });
  const evs = await follow(c.jobId, { approve: true });
  const answer = evs.filter((e) => e.type === 'answer').map((e) => e.payload?.text ?? '').join(' ');
  const blocked = evs.some((e) => e.type === 'job.state' && /BLOCKED|FAILED/i.test(e.payload?.to ?? ''));
  const cert = evs.find((e) => e.type === 'certification')?.payload;
  expect(
    blocked || /argument|obligatoire|compatible|aucune/i.test(answer) || (cert && !cert.certified),
    'négatif : pas de certification artificielle',
  );
}

console.log(ok ? '\nE2E consolidation : vert.' : '\nE2E consolidation : échecs.');
process.exit(ok ? 0 : 1);
