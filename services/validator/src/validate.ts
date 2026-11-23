/**
 * Validation statique d'une mini-app HTML auto-contenue :
 *  - structure HTML complète (détecte les sorties tronquées)
 *  - analyse syntaxique de chaque <script> (JS classique, module ou JSX/Babel) via @babel/parser
 *  - règles de sécurité de base (cookies, navigation hors iframe, scripts externes non autorisés...)
 */
import { parse } from '@babel/parser';

export type Issue = { code: string; message: string; line?: number };
export type ValidationResult = {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  stats: { bytes: number; scripts: number; externalScripts: string[] };
};

export const ALLOWED_CDN_HOSTS = [
  'unpkg.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'cdn.tailwindcss.com',
  'esm.sh',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

const FORBIDDEN: Array<{ re: RegExp; code: string; message: string }> = [
  { re: /document\s*\.\s*cookie/, code: 'cookie', message: "Accès à document.cookie interdit" },
  { re: /\b(window\s*\.\s*)?(top|parent)\s*\.\s*(location|document)/, code: 'frame-escape', message: "Accès à la page parente (top/parent) interdit" },
  { re: /navigator\s*\.\s*sendBeacon/, code: 'beacon', message: "navigator.sendBeacon interdit" },
  { re: /<meta[^>]+http-equiv\s*=\s*["']?refresh/i, code: 'meta-refresh', message: "Redirection <meta refresh> interdite" },
  { re: /<form[^>]+action\s*=\s*["']https?:/i, code: 'external-form', message: "Formulaire envoyé vers un site externe interdit" },
  { re: /\bimportScripts\s*\(/, code: 'import-scripts', message: "importScripts interdit" },
];

const SUSPICIOUS: Array<{ re: RegExp; code: string; message: string }> = [
  { re: /\beval\s*\(/, code: 'eval', message: "Utilisation de eval()" },
  { re: /new\s+Function\s*\(/, code: 'new-function', message: "Utilisation de new Function()" },
  { re: /\bfetch\s*\(\s*["'`]https?:/, code: 'external-fetch', message: "Appel réseau vers une URL externe" },
  { re: /XMLHttpRequest|new\s+WebSocket/, code: 'network', message: "Accès réseau (XHR / WebSocket)" },
];

/** Modules importables depuis un <script type="text/jsx"> (fournis par /runtime/es-runtime.js). */
export const RUNTIME_MODULES = /^(react|react-dom|react-dom\/client|react\/jsx-runtime|lucide-react|sonner|@\/lib\/utils|@\/components\/ui\/[a-z-]+)$/;
export const UI_COMPONENTS = ['accordion', 'alert-dialog', 'alert', 'avatar', 'badge', 'button', 'card', 'checkbox', 'dialog', 'dropdown-menu', 'input', 'label', 'popover', 'progress', 'radio-group', 'scroll-area', 'select', 'separator', 'sheet', 'skeleton', 'slider', 'sonner', 'switch', 'table', 'tabs', 'textarea', 'toggle-group', 'toggle', 'tooltip'];

const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length;

export function extractScripts(html: string) {
  const out: Array<{ attrs: string; body: string; line: number }> = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push({ attrs: m[1] ?? '', body: m[2] ?? '', line: lineOf(html, m.index) });
  return out;
}

export function validateHtml(html: string): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const externalScripts: string[] = [];
  const code = (html ?? '').trim();

  if (!code) {
    return { ok: false, errors: [{ code: 'empty', message: 'Code vide' }], warnings, stats: { bytes: 0, scripts: 0, externalScripts } };
  }
  if (code.length > 3_000_000) errors.push({ code: 'too-large', message: 'Code trop volumineux (> 3 Mo)' });
  if (!/<html[\s>]/i.test(code)) errors.push({ code: 'no-html', message: 'Balise <html> manquante' });
  if (!/<\/html\s*>/i.test(code)) errors.push({ code: 'truncated', message: 'Balise </html> manquante (sortie tronquée ?)' });
  if (!/<body[\s>]/i.test(code)) warnings.push({ code: 'no-body', message: 'Balise <body> manquante' });

  // Balises <script> non fermées : ce qui reste après retrait des blocs <script>…</script> complets
  // (les bundles minifiés peuvent contenir la chaîne "<script" dans un littéral).
  const leftover = code.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const opens = (leftover.match(/<script\b/gi) ?? []).length;
  const closes = (leftover.match(/<\/script\s*>/gi) ?? []).length;
  if (opens || closes) errors.push({ code: 'unclosed-script', message: `Balises <script> déséquilibrées (${opens} ouverte(s) sans fermeture, ${closes} fermeture(s) orpheline(s))` });

  const scripts = extractScripts(code);
  for (const s of scripts) {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(s.attrs)?.[1];
    const type = (/\btype\s*=\s*["']([^"']+)["']/i.exec(s.attrs)?.[1] ?? 'text/javascript').toLowerCase();
    if (src) {
      externalScripts.push(src);
      try {
        const host = new URL(src, 'https://local.invalid').hostname;
        if (host !== 'local.invalid' && !ALLOWED_CDN_HOSTS.includes(host)) {
          errors.push({ code: 'script-host', message: `Script externe non autorisé : ${host}`, line: s.line });
        }
      } catch {
        errors.push({ code: 'script-src', message: `URL de script invalide : ${src}`, line: s.line });
      }
      continue;
    }
    if (!s.body.trim()) continue;
    if (!/javascript|module|babel|jsx|^text\/javascript$/.test(type)) continue; // ex. application/json, template
    const isModule = type === 'module' || /data-type\s*=\s*["']module/i.test(s.attrs);
    const isJsx = /babel|jsx/.test(type);
    const isRuntimeJsx = type === 'text/jsx';
    try {
      const ast = parse(s.body, {
        sourceType: isModule || isJsx ? 'module' : 'script',
        plugins: isRuntimeJsx ? ['jsx', 'typescript'] : isJsx ? ['jsx'] : [],
        errorRecovery: false,
      });
      if (isRuntimeJsx) {
        if (!/\/runtime\/es-runtime\.js/.test(code)) errors.push({ code: 'runtime-missing', message: 'Script text/jsx sans <script src="/runtime/es-runtime.js">', line: s.line });
        let hasDefault = false;
        for (const node of ast.program.body) {
          if (node.type === 'ExportDefaultDeclaration') hasDefault = true;
          if (node.type === 'ImportDeclaration') {
            const mod = node.source.value;
            const ui = /^@\/components\/ui\/(.+)$/.exec(mod)?.[1];
            if (!RUNTIME_MODULES.test(mod) || (ui && !UI_COMPONENTS.includes(ui))) {
              errors.push({ code: 'import', message: `Import non disponible dans le runtime : « ${mod} »`, line: s.line + (node.loc?.start.line ?? 1) - 1 });
            }
          }
        }
        if (!hasDefault) errors.push({ code: 'no-default-export', message: 'Le script text/jsx doit faire « export default » du composant App', line: s.line });
      }
    } catch (e) {
      const err = e as { message: string; loc?: { line: number } };
      errors.push({
        code: 'syntax',
        message: `Erreur de syntaxe JS : ${err.message.replace(/\s*\(\d+:\d+\)$/, '')}`,
        line: err.loc ? s.line + err.loc.line - 1 : s.line,
      });
    }
  }

  for (const r of FORBIDDEN) {
    const m = r.re.exec(code);
    if (m) errors.push({ code: r.code, message: r.message, line: lineOf(code, m.index) });
  }
  for (const r of SUSPICIOUS) {
    const m = r.re.exec(code);
    if (m) warnings.push({ code: r.code, message: r.message, line: lineOf(code, m.index) });
  }

  return { ok: errors.length === 0, errors, warnings, stats: { bytes: code.length, scripts: scripts.length, externalScripts } };
}
