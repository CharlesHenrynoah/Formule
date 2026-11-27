// Affiche le health agrégé de la gateway.
const url = process.env.FORMULE_GATEWAY_URL ?? 'http://127.0.0.1:4000';
const res = await fetch(`${url}/health`).catch(() => null);
if (!res) { console.error('gateway injoignable'); process.exit(1); }
const j = await res.json();
for (const [k, v] of Object.entries(j.services)) console.log(`${v.status === 'ok' ? '✓' : '✗'} ${k}${v.message ? ` — ${v.message}` : ''}`);
console.log(`→ ${j.status}`);
process.exit(j.status === 'ok' ? 0 : 1);
