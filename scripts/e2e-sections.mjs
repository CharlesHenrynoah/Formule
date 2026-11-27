// Demande structurée en sections (« AI Intelligence Monitor ») contre le serveur MCP Hugging Face
// (réel, ou servers/hf-contract-mcp enregistré avec --demo true). Vérifie : aucune section bloquante,
// outil exclu jamais appelé, une source par section, « Donnée indisponible » nommée, portes G0–G5 et G7 vertes.
import { readFileSync } from 'node:fs';
const G = process.env.FORMULE_GATEWAY_URL ?? 'http://127.0.0.1:4000';
const j = async (p, b) => (await fetch(G + p, { method: b ? 'POST' : 'GET', headers: b ? { 'content-type': 'application/json' } : {}, body: b ? JSON.stringify(b) : undefined })).json();
const prompt = readFileSync(new URL('../packages/formule-bench/fixtures/ai-intelligence-monitor.md', import.meta.url), 'utf8');
const c = await j('/api/chat', { mode: 'agent', message: prompt });
let ok = true; const expect = (x, m) => { console.log(`   ${x ? '✓' : '✗'} ${m}`); if (!x) ok = false; };
expect(c.kind === 'job', 'construction lancée (pas de blocage sur les arguments)');
let after = 0; const evs = [];
for (;;) { const e = (await j(`/api/jobs/${c.jobId}/log`)).filter((x) => x.seq > after); for (const x of e) { after = x.seq; evs.push(x); if (x.type === 'source' && x.payload.canApprove) await j(`/api/jobs/${c.jobId}/approve`, {}); } if (e.some((x) => x.type === 'job.done')) break; await new Promise((r) => setTimeout(r, 300)); }
const logs = evs.filter((e) => e.type === 'log').map((e) => e.payload.text);
expect(!logs.some((l) => /Lecture .*whoami/.test(l)), 'outil exclu (« f_whoami ») jamais appelé');
expect(logs.filter((l) => /^(AI Model Radar|Research Intelligence|Dataset Explorer|AI App Discovery) : .* → ok$/.test(l)).length === 4, '4 sections lues');
const cert = evs.find((e) => e.type === 'certification')?.payload;
expect(cert && ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G7'].every((g) => cert.gates.find((x) => x.gate === g)?.passed), 'portes G0–G5 et G7 vertes');
expect(cert && (cert.certified || /Non certifiée complète/.test(cert.message)), cert?.message?.slice(0, 120));
const src = evs.find((e) => e.type === 'source')?.payload;
expect(src?.requirements.filter((r) => r.status !== 'covered').every((r) => /Donnée indisponible/.test(r.reason ?? '')), 'chaque manque est nommé « Donnée indisponible » avec sa raison');
console.log(ok ? '\nE2E sections : tout est vert.' : '\nE2E sections : des contrôles ont échoué.');
process.exit(ok ? 0 : 1);
