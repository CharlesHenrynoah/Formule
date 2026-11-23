/**
 * Répare une mini-app existante en créant une NOUVELLE version (rollback possible vers la précédente) :
 *   node --import tsx scripts/repair-app-version.mts <appId> <workspaceDir> "<note>" [--post] [--sober] [--light]
 * Le workspace doit contenir les fichiers corrigés (src/App.tsx, server/tools.ts…). Le script copie les fichiers
 * runtime du template (error boundaries, main.tsx, vite.config.ts), valide les imports, filtre tsc, construit,
 * fait le smoke render headless, valide le HTML (validator), puis (avec --post) enregistre la version dans storage.
 */
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { checkImports, formatImportProblems } from '../services/ai-engine/src/agent/imports-check.ts';
import { PLATFORM_FILES, TEMPLATE_SRC_DIR, runtimeTscErrors } from '../services/ai-engine/src/agent/workspace.ts';
import { smokeRender } from '../services/ai-engine/src/agent/smoke.ts';
import { monochromeClasses, mirrorPaletteClasses } from '../services/ai-engine/src/agent/theme-guard.ts';
import { relabelVisible, findDjLabels } from '../services/ai-engine/src/agent/ui-labels.ts';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [appId, wsArg, note = 'Correction automatique'] = args.filter((a) => !a.startsWith('--'));
const flag = flags.has('--post') ? '--post' : '';
if (!appId || !wsArg) { console.error('usage : repair-app-version.mts <appId> <workspaceDir> "<note>" [--post]'); process.exit(2); }
const ROOT = resolve(import.meta.dirname, '..');
const W = resolve(wsArg);
const STORAGE = process.env.STORAGE_URL ?? 'http://127.0.0.1:4003';
const VALIDATOR = process.env.VALIDATOR_URL ?? 'http://127.0.0.1:4002';
// Fichiers plateforme à jour (thème monochrome centralisé, AppShell, error boundaries, scènes, theme.ts)
for (const f of PLATFORM_FILES) { const src = join(TEMPLATE_SRC_DIR, f); if (existsSync(src)) cpSync(src, join(W, f), { recursive: true, force: true }); }
// --sober : couleurs néon codées en dur dans le code de l'app (séries, scènes) → palette sobre des données
// --light : app conçue pour fond sombre → interface claire (fond blanc, éléments noirs) : classes de palette nommées en miroir
//           dans le code de l'app, classes arbitraires inversées, couleurs de scène pour fond clair.
const SOBER: Record<string, string> = { '22d3ee': '6f9fd8', '06b6d4': '6f9fd8', '38bdf8': '7fc0cf', '0ea5e9': '7fc0cf', '60a5fa': '6f9fd8', '3b82f6': '6f9fd8', 'a855f7': 'a391d0', '8b5cf6': 'a391d0', 'c084fc': 'a391d0', 'e879f9': 'a391d0', 'd946ef': 'a391d0', 'ec4899': 'd88a7a', 'f472b6': 'd88a7a', 'f43f5e': 'd9705f', 'fb7185': 'd88a7a', '34d399': '6cc2a4', '10b981': '6cc2a4', '4ade80': '8fae7c', '22c55e': '8fae7c', 'fbbf24': 'd9c27a', 'f59e0b': 'd9c27a', 'facc15': 'd9c27a', '0f172a': '0d0d0d', '1e293b': '171717', '334155': '3a3a3a', '94a3b8': '8a8a8a', 'cbd5e1': 'd4d4d4', '1e3a5f': '3a3a3a', '13233d': '2a2a2a' };
const LIGHT: Record<string, string> = { '6f9fd8': '3f6fb0', '6cc2a4': '2f8f6f', 'd9c27a': 'a8862a', 'a391d0': '6e5aa8', 'd88a7a': 'b5523f', '7fc0cf': '3d8a9c', '8fae7c': '5a7d48', '8e95a6': '5f6675', 'd9705f': 'c0442e', '5fb98a': '2e9e6a', 'd9b55f': 'c08a1e', '0d0d0d': 'ffffff', '171717': 'f5f5f5', '3a3a3a': 'cfcfcf', '2a2a2a': 'e5e5e5', '8a8a8a': '737373', 'd4d4d4': '262626', 'f5f5f5': '111111', 'ffffff': '111111', 'e2e8f0': '262626', 'e5e7eb': '262626', 'f1f5f9': '262626', 'e5e5e5': '262626' };
const LEGACY_MARK_RE = /^if \(typeof document !== 'undefined'\) document\.documentElement\.dataset\.esLegacy = 'dark';.*\n?/m;
if (flags.has('--sober') || flags.has('--light')) {
  const targets = ['src/App.tsx', ...(existsSync(join(W, 'src/scenes')) ? readdirSync(join(W, 'src/scenes')).filter((f) => /\.tsx?$/.test(f)).map((f) => `src/scenes/${f}`) : [])];
  // idempotent : une app déjà passée en clair (marqueur dans App.tsx) n'est ni ré-inversée ni re-mappée
  const freshLight = flags.has('--light') && !readFileSync(join(W, 'src/App.tsx'), 'utf8').includes('es-theme: light');
  for (const f of targets) {
    const before = readFileSync(join(W, f), 'utf8');
    const isScene = f.startsWith('src/scenes/');
    let n = 0;
    let after = before.replace(/(0x|#)([0-9a-fA-F]{6})\b/g, (m, pre, hex) => {
      let h = hex.toLowerCase(); const s0 = h;
      if (flags.has('--sober') && SOBER[h]) h = SOBER[h];
      const uiGray = ['0d0d0d', '171717', '3a3a3a', '2a2a2a', '8a8a8a', 'd4d4d4', 'f5f5f5', 'ffffff', 'e2e8f0', 'e5e7eb', 'f1f5f9', 'e5e5e5'].includes(h);
      if (freshLight && LIGHT[h] && (isScene || !uiGray)) h = LIGHT[h];
      if (h === s0) return m; n++; return pre + h;
    });
    const mono = monochromeClasses(after, { invert: freshLight }); after = mono.code;
    let mir = 0;
    if (flags.has('--light')) {
      after = after.replace(LEGACY_MARK_RE, '');
      const LIGHT_MARK = '// es-theme: light (classes de palette passées en miroir pour fond blanc)';
      if (!isScene && freshLight) {
        const r = mirrorPaletteClasses(after); after = r.code; mir = r.changed;
        const lines = after.split('\n'); let k = 0; for (let i = 0; i < lines.length; i++) if (/^import\s/.test(lines[i])) k = i + 1;
        lines.splice(k, 0, LIGHT_MARK); after = lines.join('\n');
      }
    }
    if (after !== before) { writeFileSync(join(W, f), after); console.log(`thème : ${f} (${n} couleur(s) de données, ${mono.changed} classe(s) d'interface, ${mir} classe(s) de palette en miroir)`); }
  }
}
// --relabel : libellés visibles DJ → termes métier (texte JSX + chaînes affichables ; identifiants et code intacts).
// --gray    : teintes pastel d'interface (cyan, sky, teal, bleu, indigo, violet, pourpre, fuchsia, rose, pink) → gris neutres ;
//             les couleurs de statut (vert / rouge / ambre) et les données (var(--chart-*), VIZ) sont conservées.
if (flags.has('--relabel') || flags.has('--gray')) {
  const appFiles = ['src/App.tsx', ...(existsSync(join(W, 'server/tools.ts')) ? ['server/tools.ts'] : []), ...(existsSync(join(W, 'src/components')) ? readdirSync(join(W, 'src/components')).filter((f) => /\.tsx$/.test(f)).map((f) => `src/components/${f}`) : [])];
  for (const f of appFiles) {
    const before = readFileSync(join(W, f), 'utf8'); let after = before; let lab = 0; let gr = 0;
    // server/tools.ts : textes renvoyés à l'écran (recommandations, journal) — chaînes affichables seulement.
    if (flags.has('--relabel')) { const r = relabelVisible(after); after = r.code; lab = r.changed; }
    if (flags.has('--gray') && !f.startsWith('server/')) after = after.replace(/(?<![\w-])((?:[a-z]+:)*(?:text|bg|border(?:-[trblxy])?|ring|from|via|to|fill|stroke|shadow|decoration|outline)-)(cyan|sky|teal|blue|indigo|violet|purple|fuchsia|rose|pink)-(\d{2,3})/g, (_m, pre, _p, n) => { gr++; return `${pre}neutral-${n}`; });
    if (after !== before) { writeFileSync(join(W, f), after); console.log(`libellés : ${f} (${lab} zone(s) renommée(s), ${gr} classe(s) pastel → gris)`); }
  }
  const left = findDjLabels(readFileSync(join(W, 'src/App.tsx'), 'utf8'));
  console.log(left.length ? `libellés DJ restants : ${left.join(' | ')}` : 'libellés DJ restants : aucun');
}
const problems = checkImports(W);
if (problems.length) { console.error('Imports invalides :\n' + formatImportProblems(problems)); process.exit(1); }
let tsc = ''; try { execFileSync(process.execPath, [join(W, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', '.'], { cwd: W, encoding: 'utf8' }); } catch (e: any) { tsc = String(e.stdout ?? ''); }
const fatal = runtimeTscErrors(tsc, (x) => { try { return readFileSync(join(W, x), 'utf8'); } catch { return ''; } });
if (fatal.length) { console.error('Erreurs tsc bloquantes :\n' + fatal.join('\n')); process.exit(1); }
execFileSync(process.execPath, [join(W, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: W, env: { ...process.env, NODE_ENV: 'production' }, stdio: 'ignore' });
const html = readFileSync(join(W, 'dist/index.html'), 'utf8');
const smoke = await smokeRender(html, { waitMs: 3500 });
console.log(`imports OK · tsc runtime OK · build ${Math.round(html.length / 1024)} Ko · smoke ${smoke.skipped ? 'ignoré (' + smoke.skipped + ')' : smoke.ok ? 'OK' : 'KO'}`);
if (!smoke.ok) { console.error(smoke.errors.join('\n')); process.exit(1); }
if (flag !== '--post') { console.log('(simulation : ajoute --post pour enregistrer la version)'); process.exit(0); }
const latest = await (await fetch(`${STORAGE}/projects/${appId}/latest`)).json() as any;
const files = { ...(latest.files ?? {}) };
for (const k of Object.keys(files)) { try { files[k] = readFileSync(join(W, k), 'utf8'); } catch { /* conservé */ } }
const validation = await (await fetch(`${VALIDATOR}/validate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: html }) })).json();
const r = await fetch(`${STORAGE}/projects/${appId}/versions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: note, kind: 'edit', plan: latest.plan ?? null, code: html, provider: latest.provider ?? 'manuel', model: latest.model ?? null, validation, files, app: latest.app ?? undefined, agent: latest.agent ?? undefined }) });
console.log('version enregistrée :', r.status, JSON.stringify(await r.json()), '· validation', (validation as any)?.ok);
// Mémoire de la crew (rétroactive) : la prochaine évolution repart de cette version
const AGENTS = process.env.APP_AGENTS_URL ?? 'http://127.0.0.1:4005';
try { const m = await fetch(`${AGENTS}/apps/${appId}/crew-memory/retro`, { method: 'POST' }); console.log('mémoire crew :', m.status, JSON.stringify(await m.json())); } catch (e) { console.log('mémoire crew : app-agents injoignable', (e as Error).message); }
