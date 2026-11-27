import { createService, listen, ServiceError } from '@formule/service-kit';

/**
 * STT/TTS. Le LLM ne reçoit que du texte. Avec clé OpenAI-compatible : transcription et synthèse serveur.
 * Sans clé : le Studio utilise la reconnaissance/synthèse du navigateur ; ce service reste l'arbitre des confirmations vocales.
 */
const key = process.env.OPENAI_API_KEY;
const base = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
const app = await createService('voice-gateway', () => ({ stt: key ? 'serveur' : 'navigateur', tts: key ? 'serveur' : 'navigateur' }));

app.addContentTypeParser(/^audio\//, { parseAs: 'buffer' }, (_r, body, done) => done(null, body));

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Une transcription ambiguë ne confirme jamais une action à risque. */
export function interpretConfirmation(transcript: string, confidence: number | null): 'yes' | 'no' | 'ambiguous' {
  const t = norm(transcript);
  if (confidence !== null && confidence < 0.75) return 'ambiguous';
  const yes = /^(jarvis )?(oui|oui execute|oui executer|je confirme|confirme|execute|vas y)$/.test(t);
  const no = /^(jarvis )?(non|annule|stop|arrete|refuse)$/.test(t);
  if (yes && !no) return 'yes';
  if (no && !yes) return 'no';
  return 'ambiguous';
}

/** Mot d'éveil « Jarvis » en mode mains libres. */
export function stripWakeWord(transcript: string): string | null {
  const m = transcript.trim().match(/^\s*(jarvis|djarvis|jarvice)[\s,.:!-]+(.*)$/i);
  return m ? m[2].trim() || null : null;
}

app.post<{ Body: { transcript: string; confidence?: number | null } }>('/interpret/confirmation', async (r) => ({ decision: interpretConfirmation(String(r.body.transcript ?? ''), r.body.confidence ?? null) }));
app.post<{ Body: { transcript: string } }>('/interpret/wake', async (r) => ({ command: stripWakeWord(String(r.body.transcript ?? '')) }));

app.post('/stt', async (r) => {
  if (!key) throw new ServiceError(501, 'unavailable', 'STT serveur indisponible sans clé : reconnaissance du navigateur utilisée.');
  const form = new FormData();
  form.append('file', new Blob([r.body as Buffer], { type: r.headers['content-type'] ?? 'audio/webm' }), 'audio.webm');
  form.append('model', process.env.FORMULE_STT_MODEL ?? 'whisper-1');
  form.append('language', 'fr');
  const res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) throw new ServiceError(502, 'stt_failed', `STT : ${res.status}`);
  const j = await res.json() as { text: string };
  return { text: j.text };
});

app.post<{ Body: { text: string } }>('/tts', async (r, reply) => {
  if (!key) throw new ServiceError(501, 'unavailable', 'TTS serveur indisponible sans clé : synthèse du navigateur utilisée.');
  const res = await fetch(`${base}/audio/speech`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: process.env.FORMULE_TTS_MODEL ?? 'tts-1', voice: 'alloy', input: String(r.body.text).slice(0, 1000) }) });
  if (!res.ok) throw new ServiceError(502, 'tts_failed', `TTS : ${res.status}`);
  reply.header('content-type', 'audio/mpeg');
  return reply.send(Buffer.from(await res.arrayBuffer()));
});

if (process.env.VITEST !== 'true') await listen(app, 'voice-gateway');
