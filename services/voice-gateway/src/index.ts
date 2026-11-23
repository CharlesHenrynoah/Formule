/**
 * voice-gateway (:4006) — la VOIX comme OUTIL du contremaître Mercury (Google pour l'audio, Mercury pour le reste).
 *
 *   Navigateur (studio)  ⇄  WS /ws?session=<appId>   micro PCM 16 kHz → STT Google ; ← audio TTS, transcriptions, stop
 *   app-agents (outils)  →  POST /sessions/:id/speak   { text }        voice.speak  : TTS phrase par phrase, interruptible
 *                           POST /sessions/:id/listen  { timeoutMs }   voice.listen : prochaine transcription finale
 *                           POST /sessions/:id/confirm { question }    voice.confirm: question orale → oui / non / incertain
 *                           POST /sessions/:id/stop                    voice.stop   : coupe la parole
 *   GET /health · GET /sessions/:id
 * Les transcriptions finales non « consommées » par voice.listen/confirm sont renvoyées au navigateur, qui les envoie
 * au contremaître comme un message du chat. Barge-in : si l'utilisateur parle pendant la lecture, la lecture s'arrête.
 * Sans GOOGLE_API_KEY : voix désactivée proprement (VOICE_MOCK=1 pour un moteur factice de test).
 */
import { BIND_HOST } from './env.ts';
import Fastify from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { GoogleVoice, MockVoice, sentences, verdict, type SttStream, type VoiceEngine } from './google.ts';

const PORT = Number(process.env.VOICE_GATEWAY_PORT ?? 4006);
const KEY = process.env.GOOGLE_API_KEY?.trim();
export const engine: VoiceEngine | null = process.env.VOICE_MOCK === '1' ? new MockVoice() : KEY ? new GoogleVoice(KEY) : null;
const ID = /^[\w-]{1,64}$/;

type Waiter = { resolve: (text: string | null) => void; timer: NodeJS.Timeout };
type Session = { id: string; ws?: WebSocket; stt?: SttStream; sttIdle?: NodeJS.Timeout; waiters: Waiter[]; gen: number; speaking: boolean; listening: boolean; utter: number };
const sessions = new Map<string, Session>();
const session = (id: string) => { let s = sessions.get(id); if (!s) { s = { id, waiters: [], gen: 0, speaking: false, listening: false, utter: 0 }; sessions.set(id, s); } return s; };
const send = (s: Session, m: Record<string, unknown>) => { if (s.ws?.readyState === 1) s.ws.send(JSON.stringify(m)); };

function stopSpeech(s: Session, reason: string) {
  if (!s.speaking) return;
  s.gen++; s.speaking = false;
  send(s, { type: 'stop', reason });
}

function onFinal(s: Session, text: string) {
  if (!text) return;
  const w = s.waiters.shift();
  if (w) { clearTimeout(w.timer); w.resolve(text); send(s, { type: 'final', text, consumed: true }); }
  else send(s, { type: 'final', text });
}

function ensureStt(s: Session) {
  if (!engine) return;
  if (!s.stt) {
    s.stt = engine.openStt({
      onInterim: (t) => { send(s, { type: 'interim', text: t }); if (s.speaking && t.trim().length > 2) stopSpeech(s, 'barge-in'); },
      onFinal: (t) => onFinal(s, t),
      onError: (m) => send(s, { type: 'error', message: m }),
      onClose: () => { s.stt = undefined; },
    });
  }
  clearTimeout(s.sttIdle);
  s.sttIdle = setTimeout(() => { s.stt?.close(); s.stt = undefined; }, 20_000); s.sttIdle.unref(); // session STT fermée après 20 s de silence micro
}

/** voice.speak : synthèse phrase par phrase (préchargement de la suivante), envoi dans l'ordre, interruptible. */
export async function speak(s: Session, text: string, opts: { voice?: string } = {}) {
  if (!engine) return { ok: false, reason: 'voix désactivée (GOOGLE_API_KEY absente)' };
  if (s.ws?.readyState !== 1) return { ok: false, reason: 'aucun navigateur connecté à la voix pour cette app' };
  stopSpeech(s, 'nouvelle phrase');
  const gen = ++s.gen; const utter = ++s.utter; s.speaking = true;
  const parts = sentences(text);
  const t0 = Date.now(); let sent = 0;
  const synth = parts.map(() => null as Promise<Awaited<ReturnType<VoiceEngine['tts']>>> | null);
  const get = (i: number) => (synth[i] ??= engine.tts(parts[i], opts));
  send(s, { type: 'speak_start', utterance: utter, text });
  try {
    for (let i = 0; i < parts.length; i++) {
      const a = await get(i);
      if (i + 1 < parts.length) void get(i + 1).catch(() => {});
      if (gen !== s.gen) return { ok: true, interrupted: true, sentences: sent, ms: Date.now() - t0 };
      send(s, { type: 'audio', utterance: utter, seq: i, last: i === parts.length - 1, mime: a.mime, data: a.data.toString('base64'), text: parts[i] });
      sent++;
    }
  } catch (e) {
    s.speaking = false;
    return { ok: false, reason: (e as Error).message, sentences: sent };
  }
  send(s, { type: 'speak_end', utterance: utter });
  // `speaking` repasse à false quand le navigateur signale la fin de lecture (ou par sécurité après la durée estimée)
  setTimeout(() => { if (gen === s.gen) s.speaking = false; }, Math.min(30_000, text.length * 90)).unref();
  return { ok: true, sentences: sent, ms: Date.now() - t0 };
}

export function listen(s: Session, timeoutMs = 8000) {
  return new Promise<string | null>((resolve) => {
    if (s.ws?.readyState !== 1) { resolve(null); return; }
    send(s, { type: 'listen', on: true, timeoutMs });
    const w: Waiter = { resolve, timer: setTimeout(() => { s.waiters = s.waiters.filter((x) => x !== w); resolve(null); }, Math.min(30_000, Math.max(1000, timeoutMs))) };
    s.waiters.push(w);
  });
}

export const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 256 * 1024, forceCloseConnections: true });
app.get('/health', async () => ({ service: 'voice-gateway', status: 'ok', provider: engine?.name ?? 'off', enabled: !!engine, models: engine?.models ?? null, note: engine ? 'Google = voix uniquement ; Mercury 3 = cerveau' : 'GOOGLE_API_KEY absente : voix désactivée' }));
app.get<{ Params: { id: string } }>('/sessions/:id', async (req) => {
  const s = sessions.get(req.params.id);
  return { enabled: !!engine, connected: s?.ws?.readyState === 1, speaking: !!s?.speaking, listening: !!s?.listening };
});
app.post<{ Params: { id: string }; Body: { text?: string; voice?: string } }>('/sessions/:id/speak', async (req, reply) => {
  if (!ID.test(req.params.id)) return reply.code(400).send({ error: 'session invalide' });
  const text = String(req.body?.text ?? '').slice(0, 1200);
  if (!text.trim()) return reply.code(400).send({ error: 'text requis' });
  return speak(session(req.params.id), text, { voice: req.body?.voice });
});
app.post<{ Params: { id: string } }>('/sessions/:id/stop', async (req) => { const s = sessions.get(req.params.id); if (s) stopSpeech(s, 'voice.stop'); return { ok: true }; });
app.post<{ Params: { id: string }; Body: { timeoutMs?: number } }>('/sessions/:id/listen', async (req, reply) => {
  if (!engine) return reply.code(503).send({ error: 'voix désactivée' });
  const text = await listen(session(req.params.id), req.body?.timeoutMs);
  return text === null ? { ok: false, timeout: true } : { ok: true, text };
});
app.post<{ Params: { id: string }; Body: { question?: string; timeoutMs?: number } }>('/sessions/:id/confirm', async (req, reply) => {
  if (!engine) return reply.code(503).send({ error: 'voix désactivée' });
  const s = session(req.params.id);
  const q = String(req.body?.question ?? 'Je confirme ?').slice(0, 300);
  const said = await speak(s, q);
  if (!said.ok) return { ok: false, answer: 'incertain', reason: said.reason };
  const text = await listen(s, req.body?.timeoutMs ?? 10_000);
  const v = text === null ? null : verdict(text);
  return { ok: true, answer: v === true ? 'oui' : v === false ? 'non' : 'incertain', text };
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
app.addHook('onClose', async () => { for (const c of wss.clients) c.terminate(); wss.close(); });
app.server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const id = url.searchParams.get('session') ?? '';
  const origin = String(req.headers.origin ?? '');
  if (!url.pathname.endsWith('/ws') || !ID.test(id) || (origin && !LOCAL_ORIGIN.test(origin) && process.env.VOICE_ALLOW_ORIGIN !== origin)) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const s = session(id);
    s.ws?.close(4000, 'remplacé'); s.ws = ws;
    send(s, { type: 'hello', enabled: !!engine, provider: engine?.name ?? 'off', models: engine?.models ?? null });
    ws.on('message', (data, isBinary) => {
      if (isBinary) { if (!engine) return; s.listening = true; ensureStt(s); s.stt!.send(data as Buffer); return; }
      let m: any; try { m = JSON.parse(String(data)); } catch { return; }
      if (m.type === 'barge') stopSpeech(s, 'barge-in');
      else if (m.type === 'played') { if (m.utterance === s.utter) s.speaking = false; }
      else if (m.type === 'mic' && !m.on) { s.listening = false; s.stt?.end(); }
      else if (m.type === 'text' && engine?.name === 'mock') onFinal(s, String(m.text ?? '')); // injection de test
    });
    ws.on('close', () => { if (s.ws === ws) { s.ws = undefined; s.stt?.close(); s.stt = undefined; s.waiters.splice(0).forEach((w) => { clearTimeout(w.timer); w.resolve(null); }); } });
  });
});

if (process.env.VOICE_NO_LISTEN !== '1') {
  await app.listen({ port: PORT, host: BIND_HOST });
  console.log(`[voice-gateway] :${PORT} · ${engine ? `${engine.name} (TTS ${engine.models.tts}, STT ${engine.models.stt})` : 'voix désactivée (GOOGLE_API_KEY absente)'}`);
}
