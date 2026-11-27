import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { assertWorkspaceWritable } from '@formule/contracts';
import { dataDir, findRepoRoot } from '@formule/service-kit';

const root = findRepoRoot();
const template = path.join(root, 'packages/app-runtime');

/** Workspace isolé par génération : gabarit copié, node_modules lié, écriture limitée à src/** et index.html. */
export function createWorkspace(jobId: string): string {
  const ws = path.join(dataDir('workspaces'), jobId.replace(/[^a-z0-9_]/gi, ''));
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(ws, { recursive: true });
  for (const f of ['index.html', 'src', 'components.json']) cpSync(path.join(template, f), path.join(ws, f), { recursive: true });
  // .mts : configuration ESM quel que soit le package.json environnant
  cpSync(path.join(template, 'vite.config.ts'), path.join(ws, 'vite.config.mts'));
  linkNodeModules(path.join(ws, 'node_modules'));
  return ws;
}

/** node_modules du workspace : liens vers la chaîne du gabarit (prioritaire) puis vers la racine du monorepo. */
function linkNodeModules(target: string) {
  mkdirSync(target, { recursive: true });
  const sources = [path.join(template, 'node_modules'), path.join(root, 'node_modules')];
  const link = (from: string, to: string) => { if (!existsSync(to)) symlinkSync(from, to, 'dir'); };
  for (const src of sources) {
    if (!existsSync(src)) continue;
    for (const e of readdirSync(src)) {
      if (e === '.bin' || e === '.cache' || e === '.vite' || e === '.vite-temp' || e === '.package-lock.json') continue;
      if (e.startsWith('@')) {
        mkdirSync(path.join(target, e), { recursive: true });
        for (const sub of readdirSync(path.join(src, e))) link(path.join(src, e, sub), path.join(target, e, sub));
      } else link(path.join(src, e), path.join(target, e));
    }
  }
}

export function writeWorkspaceFile(ws: string, rel: string, content: string) {
  const safe = assertWorkspaceWritable(rel);
  const target = path.join(ws, safe);
  const dir = path.dirname(target);
  mkdirSync(dir, { recursive: true });
  if (!realpathSync(dir).startsWith(realpathSync(ws) + path.sep) && realpathSync(dir) !== realpathSync(ws)) throw new Error('écriture hors workspace refusée');
  writeFileSync(target, content);
}

/** vite build via execFile, sans shell, env nettoyé (aucune clé), délai borné. */
export function buildWorkspace(ws: string, signal?: AbortSignal): Promise<{ ok: boolean; html?: string; log: string; ms: number }> {
  const t0 = Date.now();
  const vite = existsSync(path.join(template, 'node_modules/vite/bin/vite.js')) ? path.join(template, 'node_modules/vite/bin/vite.js') : path.join(root, 'node_modules/vite/bin/vite.js');
  return new Promise((resolve) => {
    execFile(process.execPath, [vite, 'build', '--logLevel', 'warn'], {
      cwd: ws, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, signal,
      env: { PATH: process.env.PATH ?? '', HOME: ws, NODE_ENV: 'production' },
    }, (err, stdout, stderr) => {
      const log = (stdout + stderr).slice(-4000);
      const out = path.join(ws, 'dist/index.html');
      if (err || !existsSync(out)) return resolve({ ok: false, log: log || String(err), ms: Date.now() - t0 });
      resolve({ ok: true, html: readFileSync(out, 'utf8'), log, ms: Date.now() - t0 });
    });
  });
}

export function cleanupWorkspace(ws: string) { try { rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ } }

/**
 * `npx shadcn@latest add <composant> --yes` dans le workspace, via execFile sans shell, sur LISTE BLANCHE.
 * Le gabarit préinstalle déjà `chart` (fonctionne hors ligne) ; cette commande n'est lancée que si
 * FORMULE_SHADCN_ONLINE=1 et si le composant manque. Liste blanche : FORMULE_SHADCN_ALLOW (défaut « chart »),
 * ex. « chart,@shadcn-dashboard/sales-trend-chart ».
 */
export const SHADCN_ALLOW = () => (process.env.FORMULE_SHADCN_ALLOW ?? 'chart').split(',').map((x) => x.trim()).filter(Boolean);

export function shadcnAdd(ws: string, items: string[], signal?: AbortSignal): Promise<{ ok: boolean; skipped: string[]; log: string }> {
  const allowed = SHADCN_ALLOW();
  const refused = items.filter((i) => !allowed.includes(i) || !/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/.test(i));
  if (refused.length) return Promise.resolve({ ok: false, skipped: refused, log: `hors liste blanche : ${refused.join(', ')}` });
  const missing = items.filter((i) => !existsSync(path.join(ws, 'src/components/ui', `${i.split('/').pop()}.tsx`)));
  if (!missing.length) return Promise.resolve({ ok: true, skipped: items, log: 'déjà préinstallé dans le gabarit' });
  if (process.env.FORMULE_SHADCN_ONLINE !== '1') return Promise.resolve({ ok: false, skipped: missing, log: 'registre shadcn hors ligne (FORMULE_SHADCN_ONLINE=1 pour l’autoriser)' });
  return new Promise((resolve) => {
    execFile('npx', ['--yes', 'shadcn@latest', 'add', ...missing, '--yes', '--silent'], {
      cwd: ws, timeout: 120_000, signal, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? '', HOME: ws, npm_config_cache: path.join(ws, '.npm') },
    }, (err, stdout, stderr) => resolve({ ok: !err, skipped: [], log: (stdout + stderr).slice(-2000) }));
  });
}
