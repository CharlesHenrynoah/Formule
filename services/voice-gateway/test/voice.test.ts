import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

process.env.VOICE_MOCK = '1'; process.env.VOICE_NO_LISTEN = '1'; process.env.ENV_FILE = '/nonexistent';
const { app } = await import('../src/index.ts');
const { sentences, verdict } = await import('../src/google.ts');
await app.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
const post = (p: string, body: unknown) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);

function client(id: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?session=${id}`, { headers: { origin: 'http://localhost:5174' } });
  const msgs: any[] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  return new Promise<{ ws: WebSocket; msgs: any[] }>((res) => ws.on('open', () => res({ ws, msgs })));
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('utilitaires : phrases prononçables et verdict oral', () => {
  assert.deepEqual(sentences("✅ C'est fait, monsieur. **CA** +4 % ! 🔗 Sources : demo"), ["C'est fait, monsieur.", 'CA +4 % !', 'Sources : demo']);
  assert.equal(verdict('Oui, confirme'), true); assert.equal(verdict('non merci'), false); assert.equal(verdict('peut-être'), null);
});

test('voice.speak / listen / confirm / stop (moteur factice)', async () => {
  assert.equal((await post('/sessions/app1/speak', { text: 'Bonjour.' })).ok, false, 'sans navigateur connecté');
  const { ws, msgs } = await client('app1');
  const h = await (await fetch(`${base}/sessions/app1`)).json() as any;
  assert.ok(h.connected && h.enabled);
  const r = await post('/sessions/app1/speak', { text: "C'est fait, monsieur. Les ventes remontent." });
  assert.equal(r.ok, true); assert.equal(r.sentences, 2);
  await wait(50);
  const audio = msgs.filter((m) => m.type === 'audio');
  assert.equal(audio.length, 2); assert.ok(Buffer.from(audio[0].data, 'base64').length > 44); assert.equal(audio[1].last, true);
  // listen : la prochaine transcription finale est consommée par l'outil
  const pending = post('/sessions/app1/listen', { timeoutMs: 3000 });
  await wait(50); ws.send(JSON.stringify({ type: 'text', text: 'compare mars et avril' }));
  assert.deepEqual(await pending, { ok: true, text: 'compare mars et avril' });
  assert.ok(msgs.some((m) => m.type === 'final' && m.consumed));
  // transcription non attendue → renvoyée au navigateur pour le chat
  ws.send(JSON.stringify({ type: 'text', text: 'pourquoi ça baisse' })); await wait(50);
  assert.ok(msgs.some((m) => m.type === 'final' && m.text === 'pourquoi ça baisse' && !m.consumed));
  // confirm oral
  const c = post('/sessions/app1/confirm', { question: 'J’envoie l’alerte ?', timeoutMs: 3000 });
  await wait(80); ws.send(JSON.stringify({ type: 'text', text: 'Oui, confirme' }));
  assert.equal((await c).answer, 'oui');
  // stop + timeout listen
  assert.equal((await post('/sessions/app1/listen', { timeoutMs: 1000 })).timeout, true);
  ws.close();
});

test('origine non locale refusée', async () => {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?session=x`, { headers: { origin: 'https://evil.example' } });
  await new Promise((res) => { ws.on('error', res); ws.on('close', res); });
  assert.notEqual(ws.readyState, WebSocket.OPEN);
});

test('Google réel (court) : TTS d’une phrase puis STT streaming sur ce fichier', { skip: !process.env.GOOGLE_API_KEY && 'GOOGLE_API_KEY absente', timeout: 60_000 }, async () => {
  const { GoogleVoice } = await import('../src/google.ts');
  const g = new GoogleVoice(process.env.GOOGLE_API_KEY!);
  const a = await g.tts("C'est fait, monsieur. Les ventes ont baissé de douze pour cent hier.");
  assert.ok(a.data.length > 10_000, 'audio non vide');
  // WAV 24 kHz → PCM 16 kHz, envoyé en flux comme le micro
  const rate = a.data.readUInt32LE(24); const src = new Int16Array(a.data.buffer.slice(a.data.byteOffset + 44, a.data.byteOffset + a.data.length - ((a.data.length - 44) % 2)));
  const n = Math.floor(src.length * 16000 / rate); const pcm = new Int16Array(n); for (let i = 0; i < n; i++) pcm[i] = src[Math.min(src.length - 1, Math.round(i * rate / 16000))];
  const finals: string[] = []; const interims: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const stt = g.openStt({ onInterim: (t) => interims.push(t), onFinal: (t) => { finals.push(t); stt.close(); resolve(); }, onError: (m) => reject(new Error(m)) });
    (async () => { const b = Buffer.from(pcm.buffer); for (let i = 0; i < b.length; i += 3200) { stt.send(b.subarray(i, i + 3200)); await wait(20); } stt.end(); })();
    setTimeout(() => reject(new Error("pas de transcription finale")), 30_000).unref();
  });
  assert.match(finals.join(' '), /vente/i);
  assert.ok(interims.length > 0, 'transcription intermédiaire en direct');
});

test.after(() => app.close());
