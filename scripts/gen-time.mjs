// Mesure le temps de génération par l'équipe d'agents via la gateway (Basic Auth lue dans .access, jamais affichée).
// Usage : node scripts/gen-time.mjs [url] "<prompt>" ["<prompt>"…]
import { readFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
const GW = /^https?:/.test(args[0] ?? '') ? args.shift() : 'http://127.0.0.1:4000';
const headers = { 'Content-Type': 'application/json' };
if (existsSync('.access')) headers.Authorization = 'Basic ' + Buffer.from(readFileSync('.access', 'utf8').trim()).toString('base64');
for (const prompt of args) {
  const t0 = Date.now();
  const res = await fetch(`${GW}/api/generate`, { method: 'POST', headers, body: JSON.stringify({ prompt, mode: 'agent' }) });
  const ev = (await res.text()).split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
  const done = ev.find((e) => e.type === 'done'); const err = ev.find((e) => e.type === 'error');
  const sum = ev.find((e) => e.kind === 'summary');
  console.log(JSON.stringify({ prompt: prompt.slice(0, 60), secondes: +((Date.now() - t0) / 1000).toFixed(1), valide: done?.validation?.ok, erreur: err?.message?.slice(0, 200),
    briefPertinent: ev.find((e) => e.kind === 'brief')?.relevant, revues: ev.filter((e) => e.kind === 'review').map((e) => e.verdict), cliShadcn: sum?.cliCalls, builds: sum?.builds, ko: done ? Math.round(done.code.length / 1024) : 0 }));
}
