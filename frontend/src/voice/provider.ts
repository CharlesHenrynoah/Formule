/**
 * Client VOIX du studio — Google (via le voice-gateway local, la clé ne quitte jamais le serveur).
 * Mercury 3 (Inception) est un modèle TEXTE : il reste le cerveau. La voix est un OUTIL du contremaître :
 *   - micro → PCM 16 kHz → WS /voice/ws → Gemini Live (transcription en streaming) → transcription finale
 *     → envoyée au contremaître comme un message du chat (ou consommée par voice.listen / voice.confirm)
 *   - voice.speak (décidé par Mercury) → TTS Gemini phrase par phrase → audio reçu ici et joué (interruptible)
 *   - barge-in : si l'utilisateur parle pendant la lecture, la lecture est coupée (côté gateway et ici)
 */
export type VoiceMode = 'off' | 'ptt' | 'handsfree';
export type VoiceState = { enabled: boolean; connected: boolean; mode: VoiceMode; listening: boolean; speaking: boolean; interim: string; level: number; out: number; error?: string; provider?: string };
type Handlers = { onState(s: VoiceState): void; onFinal(text: string, consumed: boolean): void };

export class GoogleVoiceClient {
  state: VoiceState = { enabled: false, connected: false, mode: 'off', listening: false, speaking: false, interim: '', level: 0, out: 0 };
  private ws?: WebSocket;
  private mic?: { stream: MediaStream; ctx: AudioContext; node: ScriptProcessorNode; src: MediaStreamAudioSourceNode };
  private out?: AudioContext;
  private analyser?: AnalyserNode;
  private playing: AudioBufferSourceNode[] = [];
  private playAt = 0;
  private lastUtter = 0;
  private raf = 0;
  private closed = false;
  constructor(private session: string, private h: Handlers) { this.connect(); }

  private set(p: Partial<VoiceState>) { this.state = { ...this.state, ...p }; this.h.onState(this.state); }

  private connect() {
    if (this.closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/voice/ws?session=${encodeURIComponent(this.session)}`);
    this.ws = ws;
    ws.onopen = () => this.set({ connected: true, error: undefined });
    ws.onclose = () => { this.set({ connected: false }); if (!this.closed) setTimeout(() => this.connect(), 3000); };
    ws.onerror = () => this.set({ error: 'voice-gateway injoignable (port 4006)' });
    ws.onmessage = (e) => {
      let m: any; try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.type === 'hello') this.set({ enabled: !!m.enabled, provider: m.provider, error: m.enabled ? undefined : 'voix désactivée : GOOGLE_API_KEY absente du .env' });
      else if (m.type === 'interim') this.set({ interim: m.text });
      else if (m.type === 'final') { this.set({ interim: '' }); this.h.onFinal(String(m.text ?? ''), !!m.consumed); }
      else if (m.type === 'audio') void this.play(m);
      else if (m.type === 'stop') this.stopPlayback();
      else if (m.type === 'listen' && this.state.mode === 'off') void this.startMic('ptt', Number(m.timeoutMs) || 8000); // voice.listen / voice.confirm : ouvre le micro le temps de la réponse
      else if (m.type === 'error') this.set({ error: String(m.message) });
    };
  }

  /** Mode push-to-talk (Espace maintenu) ou mains libres (micro ouvert, mot d'activation « Jarvis »). */
  async setMode(mode: VoiceMode) {
    if (mode === this.state.mode) return;
    if (mode === 'off') { this.stopMic(); this.set({ mode }); return; }
    await this.startMic(mode);
  }

  private async startMic(mode: VoiceMode, autoStopMs?: number) {
    if (!this.state.enabled) { this.set({ error: this.state.error ?? 'voix indisponible' }); return; }
    if (this.mic) { this.set({ mode }); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const ctx = new AudioContext({ sampleRate: 16000 });
      const src = ctx.createMediaStreamSource(stream);
      const node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (ev) => {
        const f = ev.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(f.length); let sum = 0;
        for (let i = 0; i < f.length; i++) { const v = Math.max(-1, Math.min(1, f[i])); pcm[i] = v * 0x7fff; sum += v * v; }
        const level = Math.min(1, Math.sqrt(sum / f.length) * 5);
        if (this.ws?.readyState === 1) this.ws.send(pcm.buffer);
        if (this.state.speaking && level > 0.35) { this.ws?.send(JSON.stringify({ type: 'barge' })); this.stopPlayback(); } // barge-in local
        this.set({ level });
      };
      src.connect(node); node.connect(ctx.destination);
      this.mic = { stream, ctx, node, src };
      this.set({ mode, listening: true, error: undefined });
      if (autoStopMs) setTimeout(() => { if (this.state.mode === 'ptt') this.stopMic(); }, autoStopMs);
    } catch (e) {
      this.set({ error: (e as Error).name === 'NotAllowedError' ? 'micro refusé : autorise le micro pour localhost' : `micro : ${(e as Error).message}` });
    }
  }

  private stopMic() {
    if (!this.mic) return;
    this.mic.node.disconnect(); this.mic.src.disconnect(); this.mic.stream.getTracks().forEach((t) => t.stop()); void this.mic.ctx.close();
    this.mic = undefined;
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'mic', on: false }));
    this.set({ listening: false, level: 0, mode: this.state.mode === 'handsfree' ? 'off' : this.state.mode === 'ptt' ? 'off' : this.state.mode });
  }
  pttDown() { if (this.state.mode !== 'handsfree') void this.startMic('ptt'); }
  pttUp() { if (this.state.mode === 'ptt') setTimeout(() => this.stopMic(), 350); } // laisse partir la fin de phrase

  private async play(m: { utterance: number; seq: number; last: boolean; data: string }) {
    this.out ??= new AudioContext();
    if (!this.analyser) { this.analyser = this.out.createAnalyser(); this.analyser.fftSize = 256; this.analyser.connect(this.out.destination); }
    if (m.utterance !== this.lastUtter) { this.stopPlayback(); this.lastUtter = m.utterance; }
    const bytes = Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0));
    const buf = await this.out.decodeAudioData(bytes.buffer);
    if (m.utterance !== this.lastUtter) return;
    const s = this.out.createBufferSource(); s.buffer = buf; s.connect(this.analyser);
    const at = Math.max(this.out.currentTime + 0.03, this.playAt);
    s.start(at); this.playAt = at + buf.duration; this.playing.push(s);
    this.set({ speaking: true }); this.meter();
    s.onended = () => {
      this.playing = this.playing.filter((x) => x !== s);
      if (!this.playing.length) { this.set({ speaking: false, out: 0 }); if (m.last) this.ws?.send(JSON.stringify({ type: 'played', utterance: m.utterance })); }
    };
  }
  private meter() {
    cancelAnimationFrame(this.raf);
    const a = this.analyser; if (!a) return;
    const d = new Uint8Array(a.frequencyBinCount);
    const loop = () => { if (!this.state.speaking) return; a.getByteTimeDomainData(d); let s = 0; for (const v of d) s += ((v - 128) / 128) ** 2; this.set({ out: Math.min(1, Math.sqrt(s / d.length) * 4) }); this.raf = requestAnimationFrame(loop); };
    loop();
  }
  stopPlayback() { this.playing.forEach((s) => { try { s.stop(); } catch { /* ignore */ } }); this.playing = []; this.playAt = 0; this.set({ speaking: false, out: 0 }); }
  /** voice.stop côté navigateur : coupe la parole (et prévient le gateway). */
  stop() { this.ws?.send(JSON.stringify({ type: 'barge' })); this.stopPlayback(); }
  close() { this.closed = true; this.stopMic(); this.stopPlayback(); this.ws?.close(); void this.out?.close(); }
}

/** Commande vocale de confirmation : « oui, confirme » / « non, annule ». */
export const voiceVerdict = (t: string): boolean | null =>
  /^\W*(oui|ouais|confirme|je confirme|vas-y|ok|d'accord|valide|go)\b/i.test(t) ? true : /^\W*(non|annule|refuse|stop|pas question)\b/i.test(t) ? false : null;

/** Mot d'activation « Jarvis » : renvoie la commande qui suit ('' si seul le mot a été dit), sinon null. */
export const afterWakeWord = (t: string, word = 'jarvis') => {
  const m = new RegExp(`\\b${word}\\b[\\s,.:!?-]*`, 'i').exec(t);
  return m ? t.slice(m.index + m[0].length).trim() : null;
};
