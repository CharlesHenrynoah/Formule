import { useCallback, useEffect, useRef, useState } from 'react';

/* Voix : mêmes droits que le texte. Une transcription ambiguë ne confirme jamais une action (arbitrage serveur). */
type SR = { lang: string; continuous: boolean; interimResults: boolean; start(): void; stop(): void; abort(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null; onspeechstart: (() => void) | null };
const SRCtor = (globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition;
export const voiceSupported = !!SRCtor && typeof speechSynthesis !== 'undefined';

export function useVoice(opts: { onFinal: (text: string, confidence: number | null, auto: boolean) => void }) {
  const [listening, setListening] = useState(false);
  const [auto, setAuto] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [level, setLevel] = useState(0);
  const recog = useRef<SR | null>(null);
  const autoRef = useRef(false);
  const meter = useRef<{ stream: MediaStream; ctx: AudioContext; raf: number } | null>(null);
  const onFinal = useRef(opts.onFinal); onFinal.current = opts.onFinal;

  const startMeter = useCallback(async () => {
    if (meter.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const tick = () => { an.getByteTimeDomainData(buf); let s = 0; for (const v of buf) s += ((v - 128) / 128) ** 2; setLevel(Math.min(1, Math.sqrt(s / buf.length) * 4)); meter.current!.raf = requestAnimationFrame(tick); };
      meter.current = { stream, ctx, raf: requestAnimationFrame(tick) };
    } catch { /* micro refusé : pas de barre de niveau */ }
  }, []);
  const stopMeter = useCallback(() => { const m = meter.current; if (!m) return; cancelAnimationFrame(m.raf); m.stream.getTracks().forEach((t) => t.stop()); void m.ctx.close(); meter.current = null; setLevel(0); }, []);

  const make = useCallback((continuous: boolean) => {
    const r: SR = new SRCtor(); r.lang = 'fr-FR'; r.continuous = continuous; r.interimResults = false;
    r.onspeechstart = () => { if (speechSynthesis.speaking) { speechSynthesis.cancel(); setSpeaking(false); } }; // couper la parole
    r.onresult = (e: any) => {
      const res = e.results[e.results.length - 1];
      if (res?.isFinal) onFinal.current(res[0].transcript, typeof res[0].confidence === 'number' && res[0].confidence > 0 ? res[0].confidence : null, continuous);
    };
    r.onerror = () => {};
    r.onend = () => { if (continuous && autoRef.current) { try { r.start(); } catch { /* déjà démarrée */ } } else { setListening(false); if (!autoRef.current) stopMeter(); } };
    return r;
  }, [stopMeter]);

  const pressStart = useCallback(() => { if (!voiceSupported || autoRef.current) return; speechSynthesis.cancel(); const r = make(false); recog.current = r; r.start(); setListening(true); void startMeter(); }, [make, startMeter]);
  const pressEnd = useCallback(() => { if (!autoRef.current) recog.current?.stop(); }, []);
  const toggleAuto = useCallback(() => {
    if (!voiceSupported) return;
    if (autoRef.current) { autoRef.current = false; setAuto(false); recog.current?.abort(); setListening(false); stopMeter(); return; }
    autoRef.current = true; setAuto(true); const r = make(true); recog.current = r; r.start(); setListening(true); void startMeter();
  }, [make, startMeter, stopMeter]);

  const speak = useCallback((text: string) => {
    if (!voiceSupported || !(autoRef.current || listening)) return;
    const u = new SpeechSynthesisUtterance(text.slice(0, 400)); u.lang = 'fr-FR';
    u.onstart = () => setSpeaking(true); u.onend = () => setSpeaking(false); u.onerror = () => setSpeaking(false);
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }, [listening]);
  const interrupt = useCallback(() => { speechSynthesis.cancel(); setSpeaking(false); }, []);

  useEffect(() => () => { autoRef.current = false; recog.current?.abort(); stopMeter(); }, [stopMeter]);
  const subtitle = speaking ? 'parle… (parle pour l’interrompre)' : listening ? 'j’écoute…' : null;
  return { supported: voiceSupported, listening, auto, speaking, level, subtitle, pressStart, pressEnd, toggleAuto, speak, interrupt };
}
