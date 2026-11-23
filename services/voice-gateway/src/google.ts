/**
 * Couche VOIX Google (oreille + bouche du contremaître, JAMAIS le cerveau : Mercury 3 décide de tout).
 *  - TTS : Gemini TTS (generateContent, modalité AUDIO) — gemini-3.8-flash-lite-tts par défaut (latence ~2 s/phrase)
 *  - STT : Gemini Live transcription en streaming (WebSocket BidiGenerateContent) — gemini-3.5-transcribe-live,
 *          transcription intermédiaire + finale, détection d'activité vocale côté Google
 * La clé GOOGLE_API_KEY est lue côté serveur uniquement, passée en en-tête (jamais dans une URL ni un log).
 */
import WebSocket from 'ws';

export type Synth = { mime: string; data: Buffer; ms: number };
export type SttStream = { send(pcm16k: Buffer): void; end(): void; close(): void };
export type SttHandlers = { onInterim(text: string): void; onFinal(text: string): void; onError(msg: string): void; onClose?(): void };
export interface VoiceEngine {
  readonly name: string;
  readonly models: { tts: string; stt: string };
  tts(text: string, opts?: { voice?: string }): Promise<Synth>;
  openStt(h: SttHandlers): SttStream;
  transcribe?(audio: Buffer, mime: string): Promise<string>;
}

const API = 'https://generativelanguage.googleapis.com/v1beta';
const LIVE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const redact = (s: string) => s.replace(/key=[^&\s]+/g, 'key=***');

export class GoogleVoice implements VoiceEngine {
  readonly name = 'google';
  readonly models = { tts: process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-lite-tts', stt: process.env.GEMINI_STT_MODEL || 'gemini-3.5-transcribe-live' };
  private voice = process.env.GEMINI_TTS_VOICE || 'Charon';
  constructor(private key: string) {}

  async tts(text: string, opts: { voice?: string } = {}): Promise<Synth> {
    const t0 = Date.now();
    const r = await fetch(`${API}/models/${this.models.tts}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': this.key, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice || this.voice } } } },
      }),
    });
    const j = await r.json().catch(() => ({})) as any;
    if (!r.ok) throw new Error(`TTS Google ${r.status} : ${redact(String(j?.error?.message ?? '')).slice(0, 160)}`);
    const part = j?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
    if (!part) throw new Error('TTS Google : pas d’audio');
    return { mime: part.inlineData.mimeType ?? 'audio/wav', data: Buffer.from(part.inlineData.data, 'base64'), ms: Date.now() - t0 };
  }

  /** Transcription d'un fichier (WAV/MP3…) : gemini-3.5-transcribe (generateContent). */
  async transcribe(audio: Buffer, mime: string) {
    const r = await fetch(`${API}/models/${process.env.GEMINI_TRANSCRIBE_MODEL || 'gemini-3.5-transcribe'}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': this.key, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mime, data: audio.toString('base64') } }] }] }),
    });
    const j = await r.json().catch(() => ({})) as any;
    if (!r.ok) throw new Error(`STT Google ${r.status} : ${redact(String(j?.error?.message ?? '')).slice(0, 160)}`);
    return (j?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.audioTranscription?.text ?? p.text ?? '').join(' ').trim();
  }

  openStt(h: SttHandlers): SttStream {
    const ws = new WebSocket(LIVE, { headers: { 'x-goog-api-key': this.key } });
    let ready = false; const queue: Buffer[] = []; let closed = false;
    const sendAudio = (b: Buffer) => ws.send(JSON.stringify({ realtimeInput: { audio: { data: b.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
    ws.on('open', () => ws.send(JSON.stringify({ setup: { model: `models/${this.models.stt}` } })));
    ws.on('message', (raw) => {
      let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.setupComplete) { ready = true; queue.splice(0).forEach(sendAudio); return; }
      const sc = m.serverContent ?? {};
      if (sc.interimInputTranscription?.text) h.onInterim(sc.interimInputTranscription.text);
      if (sc.inputTranscription?.text) h.onFinal(String(sc.inputTranscription.text).trim());
      if (m.error) h.onError(redact(String(m.error.message ?? 'erreur STT')));
    });
    ws.on('error', (e) => h.onError(`STT Google : ${redact(e.message)}`));
    ws.on('close', (code, reason) => { closed = true; if (code !== 1000 && code !== 1005) h.onError(`STT Google fermé (${code}) ${redact(String(reason)).slice(0, 120)}`); h.onClose?.(); });
    return {
      send: (b) => { if (closed) return; if (ready) sendAudio(b); else if (queue.length < 200) queue.push(b); },
      end: () => { if (ready && !closed) ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); },
      close: () => { closed = true; try { ws.close(1000); } catch { /* ignore */ } },
    };
  }
}

/** Moteur factice (tests / démo sans clé si VOICE_MOCK=1) : silence WAV, transcription injectée en texte. */
export class MockVoice implements VoiceEngine {
  readonly name = 'mock';
  readonly models = { tts: 'mock-tts', stt: 'mock-stt' };
  async tts(text: string): Promise<Synth> {
    const samples = Math.min(24000 * 6, Math.max(2400, text.length * 1200));
    const data = Buffer.alloc(44 + samples * 2);
    data.write('RIFF', 0); data.writeUInt32LE(36 + samples * 2, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
    data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
    data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
    return { mime: 'audio/wav', data, ms: 1 };
  }
  openStt(): SttStream { return { send() {}, end() {}, close() {} }; }
  async transcribe() { return ''; }
}

/** Découpe en phrases prononçables (lecture phrase par phrase, interruptible entre deux phrases). */
export function sentences(text: string, max = 6) {
  const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>|]/g, ' ').replace(/\p{Extended_Pictographic}|\uFE0F/gu, ' ').replace(/https?:\/\/\S+/g, 'le lien').replace(/\s+/g, ' ').trim();
  return (clean.match(/[^.!?…]+[.!?…]*/g) ?? []).map((s) => s.trim()).filter((s) => s.length > 1).slice(0, max);
}

/** « oui, confirme » / « non, annule » → true / false / null. */
export const verdict = (t: string): boolean | null =>
  /^\W*(oui|ouais|confirme|je confirme|vas-y|ok|d'accord|valide|go|affirmatif)\b/i.test(t) ? true : /^\W*(non|annule|refuse|stop|pas question|négatif)\b/i.test(t) ? false : null;
