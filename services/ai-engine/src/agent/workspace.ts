/**
 * Workspaces isolés de l'agent Développeur : un dossier par génération, copié depuis le template
 * (Vite + React + Tailwind + `shadcn init`). node_modules est lié en dur (cp -al) : création < 0,5 s.
 * Sécurité : chemins confinés au workspace, extensions limitées, commandes en LISTE BLANCHE
 * (shadcn add <composants connus> et vite build), exécutées sans shell, env nettoyé, timeouts.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { guardBackendSource } from './engine/backend/compile.ts';
import { checkImports, formatImportProblems, missingUiModules, repairChartUsage, repairPanelCalls, repairReactHooks, repairRechartsImports, repairTableColumnShape, repairToastImports, retargetChartImports } from './imports-check.ts';
import { smokeRender, type SmokeResult } from './smoke.ts';
import { achromeSource, monochromeClasses } from './theme-guard.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../../..');
export const TEMPLATE_DIR = resolve(process.env.AGENT_TEMPLATE_DIR ?? join(ROOT, 'data/agent-template'));
/** Sources du template (versionnées) : les fichiers PLATEFORME sont recopiés à chaque workspace (thème, AppShell, scènes…). */
export const TEMPLATE_SRC_DIR = resolve(process.env.AGENT_TEMPLATE_SRC_DIR ?? join(ROOT, 'services/ai-engine/agent-template'));
export const PLATFORM_FILES = ['src/index.css', 'src/main.tsx', 'vite.config.ts', 'src/components/es'];
export const WORKSPACES_DIR = resolve(process.env.AGENT_WORKSPACES_DIR ?? join(ROOT, 'data/workspaces'));
const KEEP_WORKSPACES = Number(process.env.AGENT_KEEP_WORKSPACES ?? 20);
/** Composants copiés hors ligne si le registre shadcn est injoignable (même style radix-nova). */
const OFFLINE_UI_DIR = resolve(process.env.AGENT_OFFLINE_UI_DIR ?? join(ROOT, 'frontend/src/components/ui'));

/** Composants officiels shadcn/ui autorisés pour `shadcn add`. */
/** Blocs gratuits du registre @shadcn-dashboard (shadcndashboard.dev). Les blocs PRO sont refusés. */
export const DASHBOARD_BLOCKS = [
  'sidebar-01', 'sidebar-06',
  'total-sales-card', 'total-assets-card', 'revenue-growth-card', 'latest-products-card',
  'sales-trend-chart', 'area-chart-01', 'bar-chart-01', 'line-chart-01',
  'table-01', 'datatable-01',
  'update-banner',
];

export const SHADCN_COMPONENTS = [
  'accordion', 'alert', 'alert-dialog', 'aspect-ratio', 'avatar', 'badge', 'breadcrumb', 'button', 'button-group', 'calendar',
  'card', 'carousel', 'chart', 'checkbox', 'collapsible', 'combobox', 'command', 'context-menu', 'dialog', 'drawer',
  'dropdown-menu', 'empty', 'field', 'hover-card', 'input', 'input-group', 'input-otp', 'item', 'kbd', 'label', 'menubar',
  'navigation-menu', 'pagination', 'popover', 'progress', 'radio-group', 'resizable', 'scroll-area', 'select', 'separator',
  'sheet', 'sidebar', 'skeleton', 'slider', 'sonner', 'spinner', 'switch', 'table', 'tabs', 'textarea', 'toggle',
  'toggle-group', 'tooltip',
];

/** src/** (front), server/tools.ts (backend MCP de l'app), index.html. */
const WRITABLE = /^(src\/(?!components\/ui\/)[\w\-/.]+\.(tsx|ts|css|json)|src\/components\/ui\/[\w-]+\.tsx|server\/tools\.ts|index\.html)$/;
const MAX_FILE = 200_000;
const MAX_FILES = 60;

const SAFE_ENV = () => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  HOME: process.env.HOME ?? '/tmp',
  npm_config_prefer_offline: 'true',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
  ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
  ...(process.env.https_proxy ? { https_proxy: process.env.https_proxy } : {}),
  ...(process.env.http_proxy ? { http_proxy: process.env.http_proxy } : {}),
  ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
  ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
});
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');

/** Passes de correction automatique accordées au Développeur quand le smoke render échoue. */
export const MAX_SMOKE_FIXES = Number(process.env.ES_SMOKE_FIXES ?? 3);

/**
 * Erreurs tsc qui plantent l'app à l'exécution (les autres écarts de typage sont tolérés, strict: false) :
 * nom/module/export introuvable, import par défaut inexistant, « Did you mean » sur une propriété,
 * élément JSX non constructible, et propriété inexistante utilisée comme balise JSX (<p.Icon /> → React #130).
 */
export const RUNTIME_TSC_CODES = [2304, 2305, 2307, 2552, 2614, 2724, 1192, 2613, 2551, 2604, 2786];
export function runtimeTscErrors(output: string, source: (file: string) => string = () => ''): string[] {
  const out: string[] = [];
  for (const l of String(output ?? '').split('\n')) {
    const m = /^(.+?)\((\d+),(\d+)\): error TS(\d+):/.exec(l.trim());
    if (!m || /node_modules/.test(m[1])) continue;
    const code = Number(m[4]);
    if (RUNTIME_TSC_CODES.includes(code)) { out.push(l.trim()); continue; }
    if (code === 2339) { // propriété inexistante : fatale seulement en position de balise JSX
      const line = source(m[1]).split('\n')[Number(m[2]) - 1] ?? '';
      const before = line.slice(0, Number(m[3]) - 1);
      if (/<\/?\s*[\w$.]*$/.test(before) && /<\/?\s*[A-Za-z_$][\w$]*\.[\w$.]*$/.test(before + 'x')) out.push(`${l.trim()} (utilisé comme composant JSX → undefined → React #130)`);
    }
  }
  return out;
}

export type CmdResult = { ok: boolean; command: string; output: string; ms: number };

function runNode(cwd: string, script: string, args: string[], label: string, timeoutMs: number): Promise<CmdResult> {
  const t0 = Date.now();
  return new Promise((res) => {
    execFile(process.execPath, [script, ...args], { cwd, env: { ...SAFE_ENV(), ...(label === 'vite build' ? { NODE_ENV: 'production' } : {}) }, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = stripAnsi(`${stdout}\n${stderr}`).split('\n').filter((l) => l.trim() && !/^[-✔]\s*$/.test(l.trim()) && !/^\s+at\s/.test(l)).join('\n').replace(new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/', 'g'), '').slice(-4000);
      res({ ok: !err, command: label, output: err && (err as { killed?: boolean }).killed ? `${output}\n(délai dépassé)` : output, ms: Date.now() - t0 });
    });
  });
}

/** Une seule commande CLI/build à la fois par workspace (les appels d'outils parallèles du LLM faisaient courir la CLI shadcn). */
const locks = new Map<string, Promise<unknown>>();
function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  locks.set(key, next.catch(() => undefined));
  return next;
}

export class Workspace {
  readonly files = new Map<string, string>();      // fichiers écrits par l'agent (source de vérité pour l'itération)
  readonly components = new Set<string>();        // composants ajoutés via la CLI
  readonly preinstalled = new Set<string>();      // composants déjà dans le template (chart…)
  private constructor(readonly id: string, readonly dir: string) {}

  static templateReady() { return existsSync(join(TEMPLATE_DIR, 'node_modules/shadcn')) && existsSync(join(TEMPLATE_DIR, 'components.json')); }

  static async create(seed?: { files?: Record<string, string>; components?: string[] }): Promise<Workspace> {
    if (!Workspace.templateReady()) throw new Error(`Template agent absent (${TEMPLATE_DIR}) : lancez « bash scripts/setup-agent-template.sh »`);
    await mkdir(WORKSPACES_DIR, { recursive: true });
    const id = `ws-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 6)}`;
    const dir = join(WORKSPACES_DIR, id);
    await cp(TEMPLATE_DIR, dir, { recursive: true, filter: (src) => !src.includes('/node_modules') && !src.endsWith('/dist') });
    await new Promise<void>((ok, ko) => execFile('cp', ['-al', join(TEMPLATE_DIR, 'node_modules'), join(dir, 'node_modules')], (e) => (e ? ko(e) : ok())));
    // Fichiers plateforme à jour (le template installé peut dater : thème monochrome, error boundaries…)
    for (const f of PLATFORM_FILES) { const src = join(TEMPLATE_SRC_DIR, f); if (existsSync(src)) await cp(src, join(dir, f), { recursive: true, force: true }).catch(() => {}); }
    const ws = new Workspace(id, dir);
    // Composants déjà présents dans le template (ex. button, chart pré-installés) : connus du Développeur.
    try { for (const f of readdirSync(join(dir, 'src/components/ui'))) if (f.endsWith('.tsx')) ws.preinstalled.add(f.slice(0, -4)); } catch { /* ignore */ }
    // Pas de nettoyage ici : tsx watch surveille déjà des fichiers de data/workspaces.
    // Les effacer redémarre le moteur au milieu de la construction (liaison coupée).
    if (seed?.components?.length) await ws.shadcnAdd(seed.components);
    for (const [p, c] of Object.entries(seed?.files ?? {})) await ws.write(p, c);
    return ws;
  }

  static async cleanup() {
    try {
      const all = readdirSync(WORKSPACES_DIR).filter((d) => d.startsWith('ws-')).map((d) => ({ d, t: statSync(join(WORKSPACES_DIR, d)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const { d } of all.slice(KEEP_WORKSPACES)) await rm(join(WORKSPACES_DIR, d), { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  /** Résout un chemin relatif en refusant toute sortie du workspace. */
  private safe(rel: string, forWrite = false): string {
    const clean = normalize(String(rel ?? '').replace(/^\.?\/+/, '')).replace(/\\/g, '/');
    if (!clean || clean.startsWith('..') || clean.includes('/../') || clean.includes('node_modules')) throw new Error(`Chemin refusé : ${rel}`);
    if (forWrite && !WRITABLE.test(clean)) throw new Error(`Écriture refusée hors de src/ (ou extension non autorisée) : ${rel}`);
    const abs = resolve(this.dir, clean);
    if (relative(this.dir, abs).startsWith('..')) throw new Error(`Chemin refusé : ${rel}`);
    return abs;
  }

  async write(rel: string, content: string) {
    if (typeof content !== 'string') throw new Error('content doit être une chaîne');
    if (content.length > MAX_FILE) throw new Error(`Fichier trop gros (${content.length} > ${MAX_FILE})`);
    const abs = this.safe(rel, true);
    const key = relative(this.dir, abs);
    if (key === 'server/tools.ts') {
      const problems = guardBackendSource(content);
      if (problems.length) throw new Error(problems.join(' ; '));
    }
    if (!this.files.has(key) && this.files.size >= MAX_FILES) throw new Error('Trop de fichiers');
    await mkdir(dirname(abs), { recursive: true });
    await rm(abs, { force: true });                // jamais d'écriture dans un fichier lié en dur au template
    await writeFile(abs, content, 'utf8');
    this.files.set(key, content);
    return { path: key, bytes: Buffer.byteLength(content), lines: content.split('\n').length };
  }

  /**
   * Patch ciblé : chaque édition remplace UNE occurrence exacte de `find` (unique dans le fichier) par `replace`,
   * ou insère `insert` après (`after`) / avant (`before`) un ancrage unique. Évite de réécrire des fichiers entiers.
   */
  async edit(rel: string, edits: Array<{ find?: string; replace?: string; after?: string; before?: string; insert?: string }>) {
    if (!Array.isArray(edits) || !edits.length) throw new Error('edits vide');
    const abs = this.safe(rel, true);
    const key = relative(this.dir, abs);
    let text = this.files.get(key) ?? await readFile(abs, 'utf8').catch(() => { throw new Error(`Fichier introuvable : ${rel} (utilise write_file pour le créer)`); });
    const before0 = text;
    const where = (needle: string) => {
      const first = text.indexOf(needle);
      if (first < 0) {
        const probe = needle.trim().split('\n')[0].trim().slice(0, 40);
        const hits = probe ? text.split('\n').map((l, i) => (l.includes(probe) ? `${i + 1}: ${l.trim().slice(0, 120)}` : '')).filter(Boolean).slice(0, 5) : [];
        throw new Error(`Ancrage introuvable dans ${key} : « ${needle.slice(0, 80)} »${hits.length ? `\nLignes proches :\n${hits.join('\n')}` : ''}\nRelis la zone avec read_file({path, from, to}) puis réessaie avec le texte EXACT.`);
      }
      if (text.indexOf(needle, first + 1) >= 0) throw new Error(`Ancrage ambigu dans ${key} (plusieurs occurrences) : « ${needle.slice(0, 80)} » — ajoute du contexte pour le rendre unique.`);
      return first;
    };
    for (const e of edits) {
      if (typeof e.find === 'string' && e.find) { const i = where(e.find); text = text.slice(0, i) + String(e.replace ?? '') + text.slice(i + e.find.length); }
      else if (typeof e.after === 'string' && e.after) { const i = where(e.after) + e.after.length; text = text.slice(0, i) + String(e.insert ?? '') + text.slice(i); }
      else if (typeof e.before === 'string' && e.before) { const i = where(e.before); text = text.slice(0, i) + String(e.insert ?? '') + text.slice(i); }
      else throw new Error('chaque édition doit avoir find+replace, after+insert ou before+insert');
    }
    const r = await this.write(key, text);
    const a = before0.split('\n'), b = text.split('\n');
    let same = 0; while (same < a.length && same < b.length && a[same] === b[same]) same++;
    let tail = 0; while (tail < a.length - same && tail < b.length - same && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    return { ...r, edits: edits.length, changedLines: Math.max(a.length, b.length) - same - tail };
  }

  /** Lecture d'une plage de lignes (1-indexées, incluses), numérotées. */
  async readRange(rel: string, from = 1, to = from + 199) {
    const abs = this.safe(rel);
    const lines = (await readFile(abs, 'utf8')).split('\n');
    const a = Math.max(1, Math.floor(from)), b = Math.min(lines.length, Math.max(a, Math.floor(to)));
    return { path: rel, total: lines.length, from: a, to: b, text: lines.slice(a - 1, b).map((l, i) => `${a + i}| ${l}`).join('\n') };
  }

  /** Recherche (texte littéral, insensible à la casse) dans les fichiers de l'app (hors composants générés). */
  async search(pattern: string, max = 60) {
    const p = String(pattern ?? '').toLowerCase();
    if (!p) throw new Error('motif vide');
    const out: string[] = [];
    const files = [...(await this.list('src')).filter((f) => !f.startsWith('src/components/ui/') && !f.startsWith('src/components/es/')), ...(existsSync(join(this.dir, 'server/tools.ts')) ? ['server/tools.ts'] : [])];
    for (const f of files) {
      const t = await readFile(join(this.dir, f), 'utf8').catch(() => '');
      t.split('\n').forEach((l, i) => { if (out.length < max && l.toLowerCase().includes(p)) out.push(`${f}:${i + 1}: ${l.trim().slice(0, 160)}`); });
    }
    return out;
  }

  async read(rel: string) {
    const abs = this.safe(rel);
    const s = await stat(abs);
    if (!s.isFile()) throw new Error(`Pas un fichier : ${rel}`);
    const text = await readFile(abs, 'utf8');
    return text.length > 30_000 ? text.slice(0, 30_000) + '\n/* … tronqué … */' : text;
  }

  async list(sub = 'src'): Promise<string[]> {
    const base = this.safe(sub);
    const out: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist') continue;
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p); else out.push(relative(this.dir, p));
      }
    };
    await walk(base);
    return out.sort();
  }

  /** `npx shadcn@latest add …` — composants vérifiés contre la liste blanche, CLI locale du template. */
  shadcnAdd(components: string[]): Promise<CmdResult & { added: string[]; offline?: boolean }> {
    return exclusive(this.dir, () => this.shadcnAddNow(components));
  }

  private async shadcnAddNow(components: string[]): Promise<CmdResult & { added: string[]; offline?: boolean }> {
    const wanted = [...new Set(components.map((c) => String(c).trim().toLowerCase()))].filter(Boolean);
    const bad = wanted.filter((c) => !SHADCN_COMPONENTS.includes(c));
    if (bad.length) return { ok: false, command: `shadcn add ${wanted.join(' ')}`, output: `Composants inconnus refusés : ${bad.join(', ')}. Autorisés : ${SHADCN_COMPONENTS.join(', ')}`, ms: 0, added: [] };
    const todo = wanted.filter((c) => !existsSync(join(this.dir, 'src/components/ui', `${c}.tsx`)));
    const command = `npx shadcn@latest add ${wanted.join(' ')} --yes`;
    if (!todo.length) { wanted.forEach((c) => this.components.add(c)); return { ok: true, command, output: 'Déjà présents.', ms: 0, added: [] }; }
    const copiedFirst: string[] = [];
    for (const c of todo) {
      const src = join(OFFLINE_UI_DIR, `${c}.tsx`);
      if (!existsSync(src)) continue;
      await mkdir(join(this.dir, 'src/components/ui'), { recursive: true });
      await cp(src, join(this.dir, 'src/components/ui', `${c}.tsx`));
      copiedFirst.push(c);
    }
    const needCli = todo.filter((c) => !copiedFirst.includes(c));
    if (!needCli.length) {
      wanted.forEach((c) => this.components.add(c));
      return { ok: true, command, output: `Copie locale de ${copiedFirst.join(', ')}`, ms: 0, added: copiedFirst, offline: true };
    }
    const cli = join(this.dir, 'node_modules/shadcn/dist/index.js');
    const r = await runNode(this.dir, cli, ['add', ...needCli, '--yes'], command, 180_000);
    const missing = needCli.filter((c) => !existsSync(join(this.dir, 'src/components/ui', `${c}.tsx`)));
    if (missing.length) {
      // Repli hors ligne : copie locale des mêmes composants (style radix-nova) si le registre est injoignable.
      const copied: string[] = [];
      for (const c of missing) {
        const src = join(OFFLINE_UI_DIR, `${c}.tsx`);
        if (existsSync(src)) { await mkdir(join(this.dir, 'src/components/ui'), { recursive: true }); await cp(src, join(this.dir, 'src/components/ui', `${c}.tsx`)); copied.push(c); }
      }
      const still = missing.filter((c) => !copied.includes(c));
      wanted.filter((c) => !still.includes(c)).forEach((c) => this.components.add(c));
      return { ...r, ok: still.length === 0, offline: copied.length > 0 || copiedFirst.length > 0, added: [...copiedFirst, ...needCli.filter((c) => !still.includes(c))], output: `${r.output}\n${copiedFirst.length ? `Copie locale de ${copiedFirst.join(', ')}` : ''}${copied.length ? `\nRegistre injoignable : copie locale de ${copied.join(', ')}` : ''}${still.length ? `\nÉchec pour : ${still.join(', ')}` : ''}`.trim() };
    }
    wanted.forEach((c) => this.components.add(c));
    return { ...r, ok: true, added: [...copiedFirst, ...needCli], offline: copiedFirst.length > 0 };
  }

  /** Blocs shadcndashboard : `npx shadcn@latest add @shadcn-dashboard/<bloc>`. */
  dashboardAdd(blocks: string[]): Promise<CmdResult & { added: string[] }> {
    return exclusive(this.dir, () => this.dashboardAddNow(blocks));
  }

  private async dashboardAddNow(blocks: string[]): Promise<CmdResult & { added: string[] }> {
    const wanted = [...new Set(blocks.map((c) => String(c).trim().toLowerCase().replace(/^@shadcn-dashboard\//, '')))].filter(Boolean);
    const bad = wanted.filter((c) => !DASHBOARD_BLOCKS.includes(c));
    if (!wanted.length || bad.length) {
      return { ok: false, command: 'shadcn-dashboard', output: `Blocs refusés : ${bad.join(', ') || '(vide)'}. Autorisés (gratuits) : ${DASHBOARD_BLOCKS.join(', ')}`, ms: 0, added: [] };
    }
    const cfgPath = join(this.dir, 'components.json');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
    cfg.registries = { ...(cfg.registries ?? {}), '@shadcn-dashboard': { url: 'https://shadcndashboard.dev/r/{name}.json' } };
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
    const ids = wanted.map((c) => `@shadcn-dashboard/${c}`);
    const command = `npx shadcn@latest add ${ids.join(' ')} --yes`;
    const cli = join(this.dir, 'node_modules/shadcn/dist/index.js');
    const r = await runNode(this.dir, cli, ['add', ...ids, '--yes'], command, 180_000);
    const installed = wanted.filter((c) => existsSync(join(this.dir, 'src/components/shadcn-dashboard')) || existsSync(join(this.dir, 'components/shadcn-dashboard')));
    if (r.ok) wanted.forEach((c) => this.components.add(`dashboard:${c}`));
    return { ...r, added: r.ok ? wanted : installed };
  }

  /** Nombre de smoke renders en échec : au-delà de MAX_SMOKE_FIXES passes de correction, l'app est livrée avec un avertissement. */
  smokeFails = 0;
  lastSmoke: SmokeResult | null = null;

  /**
   * `vite build` → un seul index.html autonome (JS + CSS inline), puis 3 garde-fous AVANT de déclarer l'app prête :
   *  1. validation statique des imports (icônes lucide réelles, exports shadcn/es réels, défaut vs nommé, registres) ;
   *  2. tsc filtré sur les erreurs qui plantent à l'exécution (noms/modules/exports introuvables, <x.Prop /> inexistant…) ;
   *  3. smoke render headless (Chrome) avec des données factices : toute erreur React/JS est renvoyée dé-minifiée.
   */
  build(opts: { fixtures?: Record<string, unknown> } = {}): Promise<CmdResult & { html?: string; bytes?: number; smoke?: SmokeResult; warnings?: string[] }> {
    return exclusive(this.dir, () => this.buildNow(opts));
  }

  private async buildNow(opts: { fixtures?: Record<string, unknown> } = {}): Promise<CmdResult & { html?: string; bytes?: number; smoke?: SmokeResult; warnings?: string[] }> {
    await rm(join(this.dir, 'dist'), { recursive: true, force: true });
    // 0. Thème monochrome : couleurs ARBITRAIRES d'interface (bg-[oklch(…)], border-[#…]) ramenées en gris (données intactes).
    for (const f of (await this.list('src')).filter((x) => /\.tsx$/.test(x) && !x.startsWith('src/components/'))) {
      const src = await readFile(join(this.dir, f), 'utf8').catch(() => '');
      const m = monochromeClasses(src);
      const ach = achromeSource(m.code);
      if (m.changed || ach.changed) await this.write(f, ach.code);
    }
    // 0b. Imports réparables sans le modèle, puis primitives shadcn encore absentes.
    for (const f of (await this.list('src')).filter((x) => /\.tsx$/.test(x) && !x.startsWith('src/components/ui/') && !x.startsWith('src/components/es/'))) {
      const src = await readFile(join(this.dir, f), 'utf8').catch(() => '');
      const retargeted = retargetChartImports(src);
      const chart = repairChartUsage(retargeted.code);
      const hooks = repairReactHooks(chart.code);
      const toast = repairToastImports(hooks.code);
      const charts = repairRechartsImports(toast.code);
      const panels = repairPanelCalls(charts.code);
      const cols = repairTableColumnShape(panels.code);
      if (retargeted.changed || chart.changed || hooks.changed || toast.changed || charts.changed || panels.changed || cols.changed) await this.write(f, cols.code);
    }
    const missingUi = missingUiModules(this.dir, SHADCN_COMPONENTS);
    if (missingUi.length) await this.shadcnAddNow(missingUi);
    // 1. Imports, AVANT vite : liste complète et actionnable (icône lucide inexistante, défaut vs nommé, export shadcn absent…).
    const problems = (() => { try { return checkImports(this.dir); } catch { return []; } })();
    if (problems.length) return { ok: false, command: 'validation des imports', ms: 0, output: `Imports invalides — l'app planterait à l'exécution (React #130 « element type is invalid… got: undefined ») :\n${formatImportProblems(problems)}\nCorrige ces imports (icône lucide existante, export nommé vs défaut, shadcn_add si un composant manque) puis relance build().` };
    const r = await runNode(this.dir, join(this.dir, 'node_modules/vite/bin/vite.js'), ['build'], 'vite build', 120_000);
    const out = join(this.dir, 'dist/index.html');
    if (!r.ok || !existsSync(out)) return { ...r, ok: false, output: r.output || 'Build échoué' };
    // 2. vite ne vérifie pas les types : on bloque sur les erreurs tsc qui cassent l'app à l'exécution, pas sur les simples écarts de typage.
    const fatal: string[] = [];
    const tsc = join(this.dir, 'node_modules/typescript/bin/tsc');
    if (existsSync(tsc)) {
      const t = await runNode(this.dir, tsc, ['--noEmit', '-p', '.'], 'tsc', 90_000);
      fatal.push(...runtimeTscErrors(t.output, (f) => this.files.get(f) ?? (() => { try { return readFileSync(join(this.dir, f), 'utf8'); } catch { return ''; } })()));
    }
    if (fatal.length) {
      return { ...r, ok: false, output: `Le build compile mais l'app plantera à l'exécution (React #130 « element type is invalid… got: undefined » ou équivalent) :\n${fatal.slice(0, 15).join('\n')}\nCorrige ces imports/composants (export nommé vs défaut, shadcn_add si un composant manque, propriété bien nommée : <p.icon /> si le champ s'appelle icon) puis relance build().` };
    }
    const html = await readFile(out, 'utf8');
    // 3. Smoke render headless.
    const smoke = await smokeRender(html, { fixtures: opts.fixtures });
    this.lastSmoke = smoke;
    const warnings: string[] = [];
    if (!smoke.ok) {
      this.smokeFails++;
      const detail = smoke.errors.map((e) => `- ${e}`).join('\n');
      if (this.smokeFails <= MAX_SMOKE_FIXES) return { ...r, ok: false, smoke, output: `Le build compile mais l'app plante au premier rendu (smoke test headless, passe ${this.smokeFails}/${MAX_SMOKE_FIXES}) :\n${detail}\nCorrige le code (src/App.tsx…) puis relance build().` };
      warnings.push(`smoke render toujours en échec après ${MAX_SMOKE_FIXES} passes (livrée avec error boundaries) :\n${detail}`);
    }
    const note = smoke.skipped ? ` · smoke render ignoré (${smoke.skipped})` : smoke.ok ? ` · smoke render OK (${smoke.ms} ms)` : '';
    return { ...r, html, bytes: html.length, smoke, warnings, output: `${r.output || `dist/index.html (${Math.round(html.length / 1024)} Ko)`}${note}${warnings.length ? `\nAVERTISSEMENT : ${warnings.join('\n')}` : ''}` };
  }
}
