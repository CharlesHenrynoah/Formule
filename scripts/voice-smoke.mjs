// Test réel court de la voix via le voice-gateway en marche : voice.speak → audio WAV non vide (fichier),
// puis ce WAV est rejoué comme un micro (PCM 16 kHz) → transcription Google finale renvoyée par voice.listen.
// Usage : node scripts/voice-smoke.mjs [http://127.0.0.1:4006]
import WebSocket from 'ws';
import { writeFileSync } from 'node:fs';
const base = process.argv[2] ?? 'http://127.0.0.1:4006';
const health = await (await fetch(`${base}/health`)).json();
console.log('health', health.provider, JSON.stringify(health.models));
if (!health.enabled) { console.log('voix désactivée : rien à tester'); process.exit(0); }
const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?session=smoke`, { headers: { origin: 'http://localhost:5174' } });
const audio = []; const interims = [];
ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === 'audio') audio.push(Buffer.from(m.data, 'base64')); if (m.type === 'interim') interims.push(m.text); });
await new Promise((r) => ws.on('open', r));
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
let t0 = Date.now();
const said = await post('/sessions/smoke/speak', { text: 'Bien reçu. Les ventes ont baissé de douze pour cent hier.' });
await new Promise((r) => setTimeout(r, 100));
console.log('voice.speak', JSON.stringify(said), `${Date.now() - t0} ms`, audio.map((b) => b.length));
if (!audio.length) process.exit(1);
// Reconstitue un WAV unique 24 kHz (phrases bout à bout)
const pcm24 = Buffer.concat(audio.map((b) => b.subarray(44)));
const hdr = Buffer.from(audio[0].subarray(0, 44)); hdr.writeUInt32LE(36 + pcm24.length, 4); hdr.writeUInt32LE(pcm24.length, 40);
writeFileSync('/tmp/voice-smoke.wav', Buffer.concat([hdr, pcm24]));
const rate = hdr.readUInt32LE(24); const src = new Int16Array(pcm24.buffer, pcm24.byteOffset, Math.floor(pcm24.length / 2));
const n = Math.floor(src.length * 16000 / rate); const out = new Int16Array(n); for (let i = 0; i < n; i++) out[i] = src[Math.min(src.length - 1, Math.round(i * rate / 16000))];
t0 = Date.now();
const heard = post('/sessions/smoke/listen', { timeoutMs: 20000 });
const b = Buffer.from(out.buffer);
for (let i = 0; i < b.length; i += 3200) { ws.send(b.subarray(i, i + 3200)); await new Promise((r) => setTimeout(r, 20)); }
ws.send(JSON.stringify({ type: 'mic', on: false }));
const r = await heard;
console.log('voice.listen', JSON.stringify(r), `${Date.now() - t0} ms après début du flux`, `${interims.length} transcriptions intermédiaires`);
ws.close();
process.exit(r.ok && /vente/i.test(r.text) ? 0 : 1);
