/**
 * Contrôle navigateur headless (jsdom), exécuté dans un PROCESSUS FILS non privilégié :
 * env nettoyé, pas de clé, délai borné. Lit {html, expectations} sur stdin, écrit le rapport sur stdout.
 */
import { JSDOM, VirtualConsole } from 'jsdom';

interface Exp { viewId: string; kind: string; value?: string; points?: number; rows?: number; first?: string; count?: number }
const input = JSON.parse(await new Promise<string>((res) => { let s = ''; process.stdin.on('data', (c) => (s += c)); process.stdin.on('end', () => res(s)); }));
const errors: string[] = [];
const vc = new VirtualConsole();
// limites de jsdom (canvas, CSS moderne) : ce ne sont pas des erreurs de l'app
vc.on('jsdomError', (e) => { if (!/getContext|Not implemented|Could not parse CSS stylesheet/.test(e.message)) errors.push(e.message.slice(0, 200)); });
vc.on('error', (e) => errors.push(String(e).slice(0, 200)));
// jsdom n'exécute pas les scripts de type module : le bundle single-file est autonome, on le passe en script classique.
// Un script module est différé : on reproduit ce comportement en déplaçant les scripts en fin de body.
const scripts: string[] = [];
const html = String(input.html).replace(/<script type="module"( crossorigin)?>([\s\S]*?)<\/script>/g, (_m, _c, body: string) => { scripts.push(body); return ''; })
  .replace('</body>', () => `${scripts.map((b) => `<script>${b}</script>`).join('')}</body>`);
const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc, url: 'https://app.formule.invalid/',
  beforeParse(win) { (win as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; } });
const w = dom.window as unknown as Window & typeof globalThis;
const posted: unknown[] = [];
// pas de parent réel : on observe les messages d'erreur émis vers le pont
w.addEventListener('message', (e) => posted.push((e as MessageEvent).data));

await new Promise((r) => setTimeout(r, 400));
const doc = w.document;
const results = (input.expectations as Exp[]).map((x) => {
  const el = doc.querySelector(`[data-binding="${x.viewId}"]`);
  const view = doc.querySelector(`[data-view="${x.viewId}"]`);
  if (!view) return { viewId: x.viewId, ok: false, diag: 'vue absente du DOM' };
  if (x.kind === 'present') return { viewId: x.viewId, ok: true };
  if (!el) return { viewId: x.viewId, ok: false, diag: `aucun élément lié (data-binding) ; état affiché : ${view.getAttribute('data-state')}` };
  if (x.kind === 'kpi') { const got = el.getAttribute('data-value') ?? ''; return { viewId: x.viewId, ok: got === x.value, diag: got === x.value ? undefined : `brut → ${x.value || '(indisponible)'} ; DOM → ${got || '(vide)'}` }; }
  if (x.kind === 'line') { const got = Number(el.getAttribute('data-points')); return { viewId: x.viewId, ok: got === x.points, diag: got === x.points ? undefined : `points attendus ${x.points}, affichés ${got}` }; }
  if (x.kind === 'table') { const got = Number(el.getAttribute('data-rows')); return { viewId: x.viewId, ok: got === x.rows, diag: got === x.rows ? undefined : `lignes attendues ${x.rows}, affichées ${got}` }; }
  if (x.kind === 'count') { const got = Number(el.getAttribute('data-count')); return { viewId: x.viewId, ok: got === x.count, diag: got === x.count ? undefined : `éléments attendus ${x.count}, affichés ${got}` }; }
  if (x.kind === 'ranking') { const got = el.getAttribute('data-first') ?? ''; return { viewId: x.viewId, ok: got === x.first, diag: got === x.first ? undefined : `tête attendue ${x.first}, affichée ${got}` }; }
  return { viewId: x.viewId, ok: false, diag: 'type inconnu' };
});
// interaction : le tri d'un tableau ne doit pas faire planter l'app
const sortBtn = doc.querySelector('table thead button') as HTMLButtonElement | null;
sortBtn?.click();
await new Promise((r) => setTimeout(r, 50));
const alerts = [...doc.querySelectorAll('[role="alert"]')].map((a) => a.textContent?.slice(0, 160));
const blank = (doc.getElementById('root')?.children.length ?? 0) === 0;
process.stdout.write(JSON.stringify({ results, errors, alerts, blank, interacted: !!sortBtn }));
dom.window.close();
process.exit(0);
