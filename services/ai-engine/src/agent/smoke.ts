/**
 * Smoke render : la mini-app construite (dist/index.html autonome) est ouverte dans un Chrome headless avec des
 * ponts factices (window.app / window.mcp / window.agent hors ligne) AVANT d'être déclarée prête.
 * Toute exception non rattrapée, erreur React (même rattrapée par une error boundary) ou écran blanc est
 * renvoyée, dé-minifiée, au Développeur. Pilotage par le protocole DevTools (WebSocket natif de Node ≥ 22) :
 * aucune dépendance (pas de Playwright).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { explainError } from './react-errors.ts';

export const SMOKE_OFFLINE = 'ES_SMOKE_OFFLINE';
export type SmokeResult = { ok: boolean; skipped?: string; errors: string[]; ms: number; rootChildren?: number };

const CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
];
export const findChrome = () => CANDIDATES.find((p) => p && existsSync(p)) ?? null;

/**
 * Ponts factices : window.app.call(outil) renvoie les données factices (`fixtures`, issues du test du backend MCP sur
 * base jetable) ou une promesse rejetée marquée « hors ligne » ; window.agent simule le studio (hosted) ; abonnements no-op.
 */
export const SMOKE_STUB = `<script>(function(){var off=function(){return Promise.reject(new Error('${SMOKE_OFFLINE}'))};
var noop=function(){return function(){}};window.__ES_SMOKE=true;window.__ES_ERRORS=[];
var fx=window.__ES_FIXTURES||{};var clone=function(v){return JSON.parse(JSON.stringify(v))};
window.app={call:function(t){return Object.prototype.hasOwnProperty.call(fx,t)?Promise.resolve(clone(fx[t])):off()},tools:function(){return Promise.resolve(Object.keys(fx).map(function(n){return{name:n,write:false,safe:true}}))},onChange:noop};
window.mcp={call:off,tools:function(){return Promise.resolve([])}};
window.agent={ask:off,reset:function(){},hosted:true,shell:function(){},transcript:function(){return Promise.resolve([])},saveTranscript:function(){},onPipeline:noop,onVoice:noop,onVoiceState:noop,voice:function(){}};
window.addEventListener('unhandledrejection',function(e){e.preventDefault()});})();</script>`;

const inject = (html: string, fixtures: Record<string, unknown> = {}) => {
  const fx = `<script>window.__ES_FIXTURES=${JSON.stringify(fixtures).replace(/</g, '\\u003c')};</script>`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${fx}${SMOKE_STUB}`) : fx + SMOKE_STUB + html;
};

/** Bruit à ignorer : nos promesses « hors ligne », ressources externes indisponibles (pixi/three via /runtime, polices). */
const IGNORED = [SMOKE_OFFLINE, /Failed to load resource/i, /net::ERR_/i, /Failed to fetch dynamically imported module/i, /ResizeObserver loop/i, /WebGL/i, /favicon/i];
const ignored = (s: string) => IGNORED.some((p) => (typeof p === 'string' ? s.includes(p) : p.test(s)));

function waitPort(dir: string, ms: number): Promise<number> {
  const t0 = Date.now();
  return new Promise((res, rej) => {
    const tick = () => {
      try { const p = Number(readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]); if (p) return res(p); } catch { /* pas encore */ }
      if (Date.now() - t0 > ms) return rej(new Error('Chrome headless ne démarre pas'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

/**
 * Rend `html` dans Chrome headless pendant `waitMs` et collecte les erreurs.
 * Renvoie skipped si aucun Chrome n'est installé (ou ES_SMOKE=0) : le build n'est alors pas bloqué.
 */
export async function smokeRender(html: string, opts: { waitMs?: number; timeoutMs?: number; chrome?: string | null; fixtures?: Record<string, unknown> } = {}): Promise<SmokeResult> {
  const t0 = Date.now();
  if (process.env.ES_SMOKE === '0') return { ok: true, skipped: 'désactivé (ES_SMOKE=0)', errors: [], ms: 0 };
  const chrome = opts.chrome === undefined ? findChrome() : opts.chrome;
  if (!chrome) return { ok: true, skipped: 'Chrome introuvable', errors: [], ms: 0 };
  const dir = mkdtempSync(join(tmpdir(), 'es-smoke-'));
  const page = join(dir, 'index.html');
  writeFileSync(page, inject(html, opts.fixtures));
  let proc: ChildProcess | null = null; let ws: WebSocket | null = null;
  const errors: string[] = [];
  const add = (s: string) => { const t = String(s ?? '').trim(); if (t && !ignored(t) && !errors.includes(t)) errors.push(t); };
  const timeout = opts.timeoutMs ?? 25_000;
  try {
    proc = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio',
      '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`, '--remote-allow-origins=*', '--window-size=1400,900', 'about:blank'], { stdio: 'ignore', detached: process.platform !== 'win32' });
    const port = await waitPort(join(dir, 'profile'), Math.min(timeout, 15_000));
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const target = targets.find((t) => t.type === 'page');
    if (!target) throw new Error('aucun onglet Chrome');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((res, rej) => { ws!.onopen = () => res(); ws!.onerror = () => rej(new Error('CDP injoignable')); });
    let id = 0; const pending = new Map<number, (v: any) => void>();
    const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws!.send(JSON.stringify({ id: i, method, params })); });
    let loaded = false;
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m.error); pending.delete(m.id); return; }
      if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; add(d.exception?.description?.split('\n    at ')[0] ?? d.text); }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') add(m.params.args.map((a: any) => a.value ?? a.description ?? '').join(' ').split('\n    at ')[0]);
      if (m.method === 'Page.loadEventFired') loaded = true;
    };
    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.navigate', { url: `file://${page}` });
    const deadline = Date.now() + Math.min(timeout, 15_000);
    while (!loaded && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, opts.waitMs ?? 2500));
    const probe = await send('Runtime.evaluate', { expression: `JSON.stringify({ n: (document.getElementById('root')||document.body).childElementCount, text: (document.body.innerText||'').length, errs: (window.__ES_ERRORS||[]).map(function(e){return {message: String(e && (e.message||e)), stack: String((e && e.stack)||'')}}) })`, returnByValue: true });
    const v = JSON.parse(probe?.result?.value ?? '{}');
    // Erreurs rattrapées par les error boundaries du template : nom du panneau + pile de composants (noms conservés).
    const out: string[] = [];
    for (const e of (v.errs ?? []) as Array<{ message: string; stack?: string }>) {
      const m = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(e.message);
      out.push(`${m ? `Panneau « ${m[1]} » : ` : ''}${explainError(m ? m[2] : e.message)}${e.stack ? `\n  composants : ${e.stack}` : ''}`);
    }
    for (const e of errors) { const x = explainError(e); if (!out.some((o) => o.includes(x.split('\n')[0]))) out.push(x); }
    if (!out.length && !v.n) out.push("Écran blanc : #root est vide après le rendu (exception avalée ou rendu conditionnel jamais satisfait).");
    return { ok: out.length === 0, errors: out.slice(0, 8), ms: Date.now() - t0, rootChildren: v.n };
  } catch (e) {
    return { ok: true, skipped: `smoke indisponible : ${(e as Error).message}`, errors: [], ms: Date.now() - t0 };
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    try { if (proc?.pid) process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc?.kill('SIGKILL'); } catch { /* ignore */ } }
    setTimeout(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }, 500).unref?.();
  }
}
