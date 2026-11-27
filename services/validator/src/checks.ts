import { AppSpecSchema } from '@formule/contracts';

export interface Finding { rule: string; severity: 'error' | 'warning'; detail: string }

/** Domaines tolérés dans les chaînes du bundle (messages d'erreur React, espaces de noms SVG). Aucun appel réseau n'est permis (CSP connect-src 'none'). */
// Chaînes de messages d'erreur des bibliothèques (React, Recharts/Redux). Jamais appelées : la CSP interdit tout réseau.
const ALLOWED_URL_HOSTS = ['react.dev', 'reactjs.org', 'www.w3.org', 'fb.me', 'tailwindcss.com', 'github.com', 'lucide.dev', 'radix-ui.com', 'redux.js.org', 'redux-toolkit.js.org', 'bit.ly', 'recharts.org'];

/** window.parent n'est permis que pour postMessage ou une comparaison d'identité (vérification de event.source). */
function parentMisuse(html: string): boolean {
  const re = /window\.parent/g; let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const after = html.slice(m.index + 13, m.index + 30);
    const before = html.slice(Math.max(0, m.index - 4), m.index);
    if (/^\s*\.postMessage\(/.test(after) || /^\s*[!=]==?/.test(after) || /[!=]==?\s*$/.test(before)) continue;
    return true;
  }
  return false;
}

export function checkHtml(html: string, dataHosts: string[] = []): Finding[] {
  const f: Finding[] = [];
  const add = (rule: string, detail: string, severity: Finding['severity'] = 'error') => f.push({ rule, severity, detail });
  if (html.length > 3_000_000) add('taille', `bundle de ${html.length} octets > 3 Mo`);
  if (/<script[^>]+src\s*=\s*["']?(https?:)?\/\//i.test(html)) add('script-externe', 'script chargé depuis une origine externe');
  if (/<link[^>]+href\s*=\s*["']?(https?:)?\/\//i.test(html)) add('ressource-externe', 'feuille ou ressource externe');
  if (/<iframe/i.test(html)) add('iframe-imbriquee', 'iframe dans l’app générée');
  if (/<form[^>]*action\s*=\s*["']?https?:/i.test(html)) add('formulaire-externe', 'formulaire vers une origine externe');
  if (/document\.cookie/.test(html)) add('cookie', 'accès à document.cookie');
  if (/\b(window\.)?top\.location|window\.top\b/.test(html)) add('window-top', 'accès à window.top');
  if (parentMisuse(html)) add('window-parent', 'accès à window.parent hors pont postMessage');
  if (/\bnew\s+WebSocket\b|\bEventSource\s*\(/.test(html)) add('reseau', 'connexion réseau directe');
  if (/\bimportScripts\s*\(|\bnavigator\.sendBeacon\b/.test(html)) add('reseau', 'canal réseau indirect');
  if (/localStorage\./.test(html) && !/try\s*\{[^}]*localStorage/.test(html)) add('localstorage', 'localStorage hors try/catch', 'warning');
  const urls = html.match(/https?:\/\/[a-z0-9.-]+/gi) ?? [];
  for (const u of new Set(urls)) {
    const host = u.replace(/^https?:\/\//i, '').toLowerCase();
    if (dataHosts.includes(host)) continue; // URL issue des données lues (lien vers une source), pas du code
    if (!ALLOWED_URL_HOSTS.some((h) => host === h || host.endsWith('.' + h))) add('url-inconnue', `URL ${u} présente dans le bundle`);
  }
  if (/\bsk-[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._-]{12,}/.test(html)) add('secret', 'motif de secret dans le bundle');
  return f;
}

export function checkSpec(spec: unknown, catalog: { serverId: string; tools: { name: string; permission: string }[] }[]): Finding[] {
  const f: Finding[] = [];
  const r = AppSpecSchema.safeParse(spec);
  if (!r.success) return [{ rule: 'schema', severity: 'error', detail: r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join(' ; ') }];
  const s = r.data;
  const ids = new Set<string>();
  for (const x of [...s.views, ...s.queries, ...s.actions]) { if (ids.has(x.id)) f.push({ rule: 'id-duplique', severity: 'error', detail: x.id }); ids.add(x.id); }
  const qids = new Set(s.queries.map((q) => q.id));
  for (const v of s.views) if ('queryId' in v && !qids.has(v.queryId)) f.push({ rule: 'vue-sans-requete', severity: 'error', detail: `${v.id} → ${v.queryId}` });
  for (const q of s.queries) {
    const srv = catalog.find((c) => c.serverId === q.serverId);
    const t = srv?.tools.find((x) => x.name === q.tool);
    if (!t) f.push({ rule: 'outil-invente', severity: 'error', detail: `${q.serverId}__${q.tool} absent du catalogue` });
    else if (t.permission !== 'read') f.push({ rule: 'requete-non-lecture', severity: 'error', detail: `${q.tool} n’est pas autorisé en lecture` });
  }
  for (const a of s.actions) {
    const t = catalog.find((c) => c.serverId === a.serverId)?.tools.find((x) => x.name === a.tool);
    if (!t || t.permission !== 'write') f.push({ rule: 'action-non-autorisee', severity: 'error', detail: `${a.serverId}__${a.tool}` });
  }
  return f;
}
