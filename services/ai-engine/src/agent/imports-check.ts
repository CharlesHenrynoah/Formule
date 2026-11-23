/**
 * Validation statique des imports d'une mini-app AVANT de la livrer (complète tsc, filtré sur les erreurs « runtime »).
 * Chaque nom importé doit exister avec le bon type d'export :
 *  - lucide-react : liste blanche = exports réels du paquet installé (icône inexistante → React #130) ;
 *  - '@/components/ui/*', '@/components/es/*', '@/lib/*' et imports relatifs : exports réels du fichier
 *    (sous-composant shadcn absent, import par défaut d'un module sans export default…) ;
 *  - autres paquets (react, recharts…) : exports réels du module, ou déclarations de types (.d.ts).
 * Vérifie aussi que les composants d'action / scènes cités en dur existent dans les registres du template.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';

export type ImportProblem = { file: string; line: number; module: string; name: string; kind: 'missing-module' | 'missing-export' | 'missing-default' | 'unknown-icon' | 'unknown-action' | 'unknown-scene'; message: string };

type ImportSpec = { file: string; line: number; module: string; defaultName?: string; names: string[]; typeOnly: boolean };

/** Parse les `import … from '…'` d'un fichier TS/TSX (hors `import type`). */
export function parseImports(src: string, file = 'src/App.tsx'): ImportSpec[] {
  const out: ImportSpec[] = [];
  const re = /(^|\n)\s*import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (let m; (m = re.exec(src));) {
    const typeOnly = !!m[2];
    const clause = m[3].trim();
    const line = src.slice(0, m.index + m[1].length).split('\n').length;
    const spec: ImportSpec = { file, line, module: m[4], names: [], typeOnly };
    const braces = /\{([\s\S]*)\}/.exec(clause);
    const head = clause.replace(/\{[\s\S]*\}/, '').replace(/,\s*$/, '').trim().replace(/,$/, '').trim();
    if (head && !head.startsWith('*')) spec.defaultName = head.split(',')[0].trim() || undefined;
    if (braces) for (const raw of braces[1].split(',')) {
      const part = raw.trim();
      if (!part || /^type\s/.test(part)) continue;
      spec.names.push(part.split(/\s+as\s+/)[0].trim());
    }
    out.push(spec);
  }
  return out;
}

/** Exports (valeurs + types) d'un fichier source TS/TSX, par analyse textuelle. `star` = contient `export *` (non vérifiable). */
export function exportsOfSource(src: string): { names: Set<string>; hasDefault: boolean; star: boolean } {
  const names = new Set<string>();
  for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) for (const p of m[1].split(',')) { const n = p.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim(); if (n) names.add(n); }
  const hasDefault = /export\s+default\b/.test(src) || names.has('default');
  return { names, hasDefault, star: /export\s+\*\s+from/.test(src) };
}

const EXT = ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts'];
function resolveLocal(dir: string, fromFile: string, mod: string): string | null {
  const base = mod.startsWith('@/') ? join(dir, 'src', mod.slice(2)) : resolve(dirname(join(dir, fromFile)), mod);
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const e of EXT) if (existsSync(base + e)) return base + e;
  return null;
}

const pkgCache = new Map<string, { runtime: Set<string> | null; hasDefault: boolean; dts: string }>();
function packageExports(dir: string, mod: string) {
  const key = `${dir}::${mod}`;
  const hit = pkgCache.get(key); if (hit) return hit;
  const req = createRequire(join(dir, 'package.json'));
  let runtime: Set<string> | null = null; let hasDefault = false; let dts = '';
  try { const m = req(mod); runtime = new Set(Object.keys(m)); hasDefault = 'default' in m || typeof m === 'function'; } catch { runtime = null; }
  try {
    const pj = req.resolve(`${mod.split('/').slice(0, mod.startsWith('@') ? 2 : 1).join('/')}/package.json`);
    const p = JSON.parse(readFileSync(pj, 'utf8'));
    const t = p.types ?? p.typings;
    if (t && existsSync(join(dirname(pj), t))) dts = readFileSync(join(dirname(pj), t), 'utf8');
  } catch { /* exports inaccessibles */ }
  const v = { runtime, hasDefault, dts };
  pkgCache.set(key, v);
  return v;
}

/** Composants d'action et scènes déclarés dans le template de l'app (registres). */
function registries(dir: string) {
  const read = (p: string) => (existsSync(join(dir, p)) ? readFileSync(join(dir, p), 'utf8') : '');
  const actions = /ACTION_COMPONENTS\s*=\s*\[([^\]]*)\]/.exec(read('src/components/es/actions.tsx'))?.[1];
  const scenes = /SCENES\s*=\s*\{([^}]*)\}/.exec(read('src/components/es/scenes.tsx'))?.[1];
  const list = (s?: string) => (s ? new Set([...s.matchAll(/'([^']+)'/g)].map((m) => m[1])) : null);
  return { actions: list(actions), scenes: list(scenes) };
}

function walk(dir: string, sub: string, out: string[] = []) {
  const abs = join(dir, sub);
  if (!existsSync(abs)) return out;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const rel = join(sub, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist' && rel !== join('src', 'components', 'ui')) walk(dir, rel, out); }
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(rel);
  }
  return out;
}

/** Vérifie tous les imports des fichiers de src/ (hors composants shadcn générés). */
export function checkImports(dir: string, files?: string[]): ImportProblem[] {
  const problems: ImportProblem[] = [];
  const reg = registries(dir);
  const list = files ?? walk(dir, 'src');
  const registered = new Set<string>();
  for (const f of walk(dir, 'src')) { try { for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/registerScene\(\s*['"]([^'"]+)['"]/g)) registered.add(m[1]); } catch { /* ignore */ } }
  for (const file of list) {
    const abs = join(dir, file);
    if (!existsSync(abs)) continue;
    const src = readFileSync(abs, 'utf8');
    for (const imp of parseImports(src, file)) {
      if (imp.typeOnly || /\.(css|svg|png|jpe?g|json)(\?.*)?$/.test(imp.module)) continue;
      const push = (kind: ImportProblem['kind'], name: string, message: string) => problems.push({ file, line: imp.line, module: imp.module, name, kind, message });
      if (imp.module.startsWith('@/') || imp.module.startsWith('.')) {
        const target = resolveLocal(dir, file, imp.module);
        if (!target) {
          const uiName = imp.module.startsWith('@/components/ui/') ? imp.module.split('/').pop() ?? '' : '';
          const hint = uiName === 'use-toast' || uiName === 'toaster'
            ? ` (toast : import { toast, Toaster } from 'sonner')`
            : uiName ? ` (lance shadcn_add(['${uiName}']))` : '';
          push('missing-module', '*', `module introuvable '${imp.module}'${hint}`);
          continue;
        }
        const ex = exportsOfSource(readFileSync(target, 'utf8'));
        if (ex.star) continue;
        const where = relative(dir, target);
        if (imp.defaultName && !ex.hasDefault) push('missing-default', imp.defaultName, `import par défaut « ${imp.defaultName} » mais ${where} n'a pas d'export default (utilise import { ${imp.defaultName} } from '${imp.module}')`);
        for (const n of imp.names) if (!ex.names.has(n)) push('missing-export', n, `« ${n} » n'est pas exporté par ${where}. Exports disponibles : ${[...ex.names].filter((x) => /^[A-Z]/.test(x)).slice(0, 25).join(', ')}`);
        continue;
      }
      const pkg = packageExports(dir, imp.module);
      const isType = (n: string) => new RegExp(`(?:type|interface|class)\\s+${n}\\b`).test(pkg.dts);
      if (imp.module === 'lucide-react') {
        if (!pkg.runtime) continue;
        if (imp.defaultName) push('missing-default', imp.defaultName, `lucide-react n'a pas d'export par défaut : import { ${imp.defaultName} } from 'lucide-react'`);
        for (const n of imp.names) if (!pkg.runtime.has(n) && !isType(n)) {
          const base = [...pkg.runtime].filter((x) => /^[A-Z]/.test(x) && !/^Lucide/.test(x) && !/Icon$/.test(x));
          const stem = n.replace(/Icon$/, '').replace(/^Lucide/, '');
          const near = [...base.filter((x) => x.startsWith(stem.slice(0, 6))), ...base.filter((x) => !x.startsWith(stem.slice(0, 6)) && x.toLowerCase().includes(stem.toLowerCase().slice(0, 5)))].slice(0, 6);
          push('unknown-icon', n, `icône lucide-react inexistante « ${n} »${near.length ? ` (proches : ${near.join(', ')})` : ''}`);
        }
        continue;
      }
      if (!pkg.runtime) continue; // paquet ESM-only non chargeable en CJS : laissé à tsc
      if (imp.defaultName && !pkg.hasDefault) push('missing-default', imp.defaultName, `'${imp.module}' n'a pas d'export par défaut`);
      for (const n of imp.names) if (!pkg.runtime.has(n) && !isType(n)) push('missing-export', n, `« ${n} » n'est pas exporté par '${imp.module}'`);
    }
    // Registres : composants d'action / scènes cités en dur dans le code de l'app.
    const usesActions = /from\s+['"](@\/components\/es\/actions|\.\/actions)['"]/.test(src);
    const usesScenes = /from\s+['"](@\/components\/es\/scenes|\.\/scenes)['"]/.test(src);
    if (reg.actions && usesActions) for (const m of src.matchAll(/component\s*:\s*['"]([A-Z]\w*)['"]/g)) if (!reg.actions.has(m[1]) && m[1] !== 'Scene') problems.push({ file, line: src.slice(0, m.index).split('\n').length, module: 'actions', name: m[1], kind: 'unknown-action', message: `composant d'action inconnu « ${m[1]} » (registre : ${[...reg.actions].join(', ')})` });
    if (reg.scenes && usesScenes) for (const m of src.matchAll(/scene\s*:\s*['"]([a-z0-9-]+)['"]/g)) if (!reg.scenes.has(m[1]) && !registered.has(m[1])) problems.push({ file, line: src.slice(0, m.index).split('\n').length, module: 'scenes', name: m[1], kind: 'unknown-scene', message: `scène inconnue « ${m[1]} » (catalogue : ${[...reg.scenes].join(', ')} ; ou registerScene('${m[1]}', …))` });
  }
  return problems;
}

const CHART_EXPORTS = new Set(['ChartContainer', 'ChartTooltip', 'ChartTooltipContent', 'ChartLegend', 'ChartLegendContent', 'ChartStyle']);

/** Composants shadcn importés alors que le fichier n'est pas encore dans src/components/ui. */
export function missingUiModules(dir: string, allowed: readonly string[]): string[] {
  const allow = new Set(allowed);
  const wanted = new Set<string>();
  for (const file of walk(dir, 'src')) {
    let src = '';
    try { src = readFileSync(join(dir, file), 'utf8'); } catch { continue; }
    for (const imp of parseImports(src, file)) {
      const name = /^@\/components\/ui\/([a-z0-9-]+)$/.exec(imp.module)?.[1];
      if (!name || !allow.has(name)) continue;
      if (!existsSync(join(dir, 'src/components/ui', `${name}.tsx`))) wanted.add(name);
    }
  }
  return [...wanted];
}

/** ChartContainer et ses voisins vivent dans @/components/ui/chart, jamais dans les molécules. */
export function retargetChartImports(src: string): { code: string; changed: boolean } {
  let changed = false;
  const code = src.replace(/import\s+\{([^}]+)\}\s+from\s+(['"])@\/components\/(molecules|atoms|organisms)\2;?/g, (full, inner: string, q: string, layer: string) => {
    const parts = inner.split(',').map((part) => part.trim()).filter(Boolean);
    const chart = parts.filter((part) => CHART_EXPORTS.has(part.split(/\s+as\s+/)[0].trim()));
    const keep = parts.filter((part) => !chart.includes(part));
    if (!chart.length) return full;
    changed = true;
    const lines = [`import { ${chart.join(', ')} } from ${q}@/components/ui/chart${q};`];
    if (keep.length) lines.push(`import { ${keep.join(', ')} } from ${q}@/components/${layer}${q};`);
    return lines.join('\n');
  });
  return { code, changed };
}

function ensureNamedImport(src: string, module: string, names: string[]): string {
  const re = new RegExp(`import\\s+\\{([^}]+)\\}\\s+from\\s+(['"])${module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\2`);
  const match = re.exec(src);
  if (!match) return `import { ${names.join(', ')} } from '${module}';\n${src}`;
  const have = match[1].split(',').map((part) => part.trim()).filter(Boolean);
  const missing = names.filter((name) => !have.includes(name));
  if (!missing.length) return src;
  return src.replace(re, `import { ${[...have, ...missing].join(', ')} } from ${match[2]}${module}${match[2]}`);
}

function matchingParen(body: string, open: number): number {
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Le return JSX de la page. Un `return () =>` de useEffect n'est pas ce return. */
function wrapJsxReturn(body: string): string | null {
  const re = /return\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) {
    const open = body.indexOf('(', match.index);
    const close = matchingParen(body, open);
    if (close < 0) return null;
    const inner = body.slice(open + 1, close);
    const rest = body.slice(close + 1).replace(/^\s*/, '');
    if (rest.startsWith('=>') || !/^\s*</.test(inner)) {
      re.lastIndex = close + 1;
      continue;
    }
    return body.slice(0, open + 1) + '<AppShell title="Pilotage">' + inner + '</AppShell>' + body.slice(close);
  }
  return null;
}

/** Pose l'enveloppe dashboard + chat si la page l'a oubliée. Une revue ne doit pas relancer un correcteur pour ça. */
export function ensureAppShell(src: string): { code: string; changed: boolean } {
  const undone = src.replace(/return\s*\(\s*<AppShell\b[^>]*>\s*<\/AppShell>\s*\)\s*=>/g, 'return () =>');
  let changed = undone !== src;
  if (/<AppShell\b/.test(undone) && /@\/components\/es\/app-shell/.test(undone)) return { code: undone, changed };
  let code = undone;
  if (!/@\/components\/es\/app-shell/.test(code)) {
    code = /^(import\s)/m.test(code)
      ? code.replace(/^(import\s)/m, `import { AppShell } from '@/components/es/app-shell';\n$1`)
      : `import { AppShell } from '@/components/es/app-shell';\n${code}`;
    changed = true;
  }
  const start = code.search(/export\s+default\s+function/);
  const head = start >= 0 ? code.slice(0, start) : '';
  const body = start >= 0 ? code.slice(start) : code;
  const wrapped = wrapJsxReturn(body);
  if (!wrapped) return { code, changed };
  return { code: head + wrapped, changed: true };
}

/** <ChartContainer data xKey yKey /> n'existe pas : le vrai composant attend config et un graphique recharts. */
export function repairChartUsage(src: string): { code: string; changed: boolean } {
  let changed = false;
  const code = src.replace(/<ChartContainer\b([^>]*?)\/>/g, (full, attrs: string) => {
    if (/\bconfig\s*=/.test(attrs)) return full;
    const data = /\bdata=\{([^}]+)\}/.exec(attrs)?.[1]?.trim();
    const xKey = /\bxKey=\{([^}]+)\}/.exec(attrs)?.[1]?.trim();
    const yKey = /\byKey=\{([^}]+)\}/.exec(attrs)?.[1]?.trim();
    if (!data || !xKey || !yKey) return full;
    changed = true;
    return `<ChartContainer config={{ serie: { label: ${yKey}, color: 'var(--chart-1)' } }}>\n  <BarChart data={${data}}>\n    <XAxis dataKey={${xKey}} />\n    <Bar dataKey={${yKey}} fill="var(--color-serie)" />\n  </BarChart>\n</ChartContainer>`;
  });
  if (!changed) return { code: src, changed: false };
  return { code: ensureNamedImport(code, 'recharts', ['Bar', 'BarChart', 'XAxis']), changed: true };
}

const REACT_HOOKS = ['useState', 'useEffect', 'useMemo', 'useCallback', 'useRef', 'useId', 'useReducer', 'useContext'];

/** Ajoute à l'import react les hooks appelés sans être importés (useMemo is not defined). */
export function repairReactHooks(src: string): { code: string; changed: boolean } {
  const missing = REACT_HOOKS.filter((hook) => new RegExp(`(?<!\\.)\\b${hook}\\s*[<(]`).test(src) && !new RegExp(`import\\s+\\{[^}]*\\b${hook}\\b[^}]*\\}\\s+from\\s+['"]react['"]`).test(src));
  if (!missing.length) return { code: src, changed: false };
  return { code: ensureNamedImport(src, 'react', missing), changed: true };
}

/** use-toast et toaster sont l'ancienne API shadcn : le template sert sonner. */
export function repairToastImports(src: string): { code: string; changed: boolean } {
  const hadHook = /@\/components\/ui\/use-toast/.test(src);
  const hadToaster = /@\/components\/ui\/toaster['"]/.test(src);
  if (!hadHook && !hadToaster) return { code: src, changed: false };
  let code = src
    .replace(/import\s+\{[^}]*\}\s+from\s+['"]@\/components\/ui\/use-toast['"];?\n?/g, '')
    .replace(/import\s+\{[^}]*\}\s+from\s+['"]@\/components\/ui\/toaster['"];?\n?/g, '')
    .replace(/const\s+\{\s*toast\s*\}\s*=\s*useToast\s*\(\s*\)\s*;?\n?/g, '');
  if (hadHook) {
    code = code.replace(/\btoast\(\s*\{([^{}]*)\}\s*\)/g, (full, body: string) => {
      const title = /\btitle\s*:\s*([^,}]+)/.exec(body)?.[1]?.trim();
      return title ? `toast(${title})` : full;
    });
  }
  const names = [...(hadHook && /\btoast\s*\(/.test(code) ? ['toast'] : []), ...(/<Toaster\b/.test(code) ? ['Toaster'] : [])];
  if (names.length) code = ensureNamedImport(code, 'sonner', names);
  return { code, changed: code !== src };
}

const RECHARTS_TAGS = ['ResponsiveContainer', 'LineChart', 'BarChart', 'AreaChart', 'PieChart', 'ComposedChart', 'ScatterChart', 'XAxis', 'YAxis', 'ZAxis', 'CartesianGrid', 'Tooltip', 'Legend', 'Line', 'Bar', 'Area', 'Pie', 'Cell', 'Scatter', 'ReferenceLine', 'LabelList'];

/** Un graphique recharts utilisé en JSX sans import vaut undefined au rendu. */
export function repairRechartsImports(src: string): { code: string; changed: boolean } {
  const imported = (src.match(/import\s+\{[^}]+\}/g) ?? []).join(' ');
  const missing = RECHARTS_TAGS.filter((name) => new RegExp(`<${name}\\b`).test(src) && !new RegExp(`\\b${name}\\b`).test(imported) && !new RegExp(`(?:function|const|class|let)\\s+${name}\\b`).test(src));
  if (!missing.length) return { code: src, changed: false };
  return { code: ensureNamedImport(src, 'recharts', missing), changed: true };
}

/** La page passe parfois data= là où TablePanel lit rows. */
export function repairPanelCalls(src: string): { code: string; changed: boolean } {
  let changed = false;
  let out = '';
  let i = 0;
  for (const match of src.matchAll(/<TablePanel\b/g)) {
    const from = match.index ?? 0;
    const end = jsxTagEnd(src, from);
    if (end < 0) break;
    const tag = src.slice(from, end + 1);
    out += src.slice(i, from);
    if (!/\brows\s*=/.test(tag) && /\bdata\s*=/.test(tag)) {
      changed = true;
      out += tag.replace(/\bdata\s*=/, 'rows=');
    } else out += tag;
    i = end + 1;
  }
  out += src.slice(i);
  return { code: out, changed };
}

/** TablePanel attend des string, la page envoie parfois { key, label }. */
export function repairTableColumnShape(src: string): { code: string; changed: boolean } {
  if (!/function TablePanel\b/.test(src) || !/\{col\}/.test(src)) return { code: src, changed: false };
  const code = src
    .replace(/\{col\}/g, `{typeof col === 'string' ? col : String(col.label ?? col.key ?? '')}`)
    .replace(/row\[col\]/g, `row[typeof col === 'string' ? col : String(col.key ?? '')]`);
  return { code, changed: code !== src };
}

function jsxTagEnd(src: string, from: number): number {
  let depth = 0;
  let quote = '';
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote && src[i - 1] !== '\\') quote = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === '>' && depth === 0) return i;
  }
  return -1;
}

export const formatImportProblems = (ps: ImportProblem[]) => ps.map((p) => `${p.file}:${p.line} — ${p.message}`).join('\n');
