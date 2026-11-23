/**
 * Secrets des serveurs MCP distants (jeton Bearer, en-têtes personnalisés).
 *   - stockés UNIQUEMENT côté serveur, dans un fichier JSON chmod 600 (dossier chmod 700) hors dépôt :
 *     data/secrets/mcp-servers.json par défaut (data/ est ignoré par git ; MCP_SECRETS_PATH pour changer)
 *   - surchargeables par variables d'environnement / .env : MCP_TOKEN_<ID> (ex. MCP_TOKEN_N8N)
 *   - mcp.config.json ne garde qu'une RÉFÉRENCE (auth: { secret: true }) ; jamais de valeur
 *   - l'API ne renvoie que des métadonnées (jeton enregistré oui/non, 4 derniers caractères masqués, noms d'en-têtes)
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type ServerSecret = { token?: string; headers?: Record<string, string> };
export type AuthView = { bearer: boolean; tokenHint?: string; headerNames: string[]; source: 'fichier' | 'env' | 'aucun' };

/** Noms d'en-têtes interdits (gérés par le transport) ou dangereux. */
const FORBIDDEN = /^(host|content-length|content-type|accept|connection|transfer-encoding|mcp-session-id|mcp-protocol-version|cookie)$/i;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

export const envTokenName = (id: string) => `MCP_TOKEN_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/** Normalise un jeton saisi : retire un éventuel préfixe « Bearer », refuse les retours ligne. */
export function cleanToken(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.trim().replace(/^Bearer\s+/i, '').trim();
  if (!t) return undefined;
  if (/[\r\n\0]/.test(t) || t.length > 8192) throw new Error('jeton invalide');
  return t;
}

/** Valide des en-têtes personnalisés (mode avancé). */
export function cleanHeaders(raw: unknown): Record<string, string> | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('en-têtes : objet { "Nom": "valeur" } attendu');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const name = k.trim();
    if (!name) continue;
    if (!HEADER_NAME.test(name) || FORBIDDEN.test(name)) throw new Error(`en-tête non autorisé : ${name}`);
    const val = String(v ?? '');
    if (/[\r\n\0]/.test(val) || val.length > 8192) throw new Error(`valeur invalide pour l'en-tête ${name}`);
    out[name] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

/** En-têtes HTTP à envoyer sur CHAQUE requête (POST, GET/SSE, DELETE, reconnexions). */
export function authHeaders(secret: ServerSecret | undefined): Record<string, string> {
  if (!secret) return {};
  const h: Record<string, string> = { ...(secret.headers ?? {}) };
  if (secret.token) {
    for (const k of Object.keys(h)) if (k.toLowerCase() === 'authorization') delete h[k];
    h.Authorization = `Bearer ${secret.token}`;
  }
  return h;
}

const hint = (t: string) => (t.length >= 12 ? `••••${t.slice(-4)}` : '••••');

export class SecretStore {
  private data: Record<string, ServerSecret> = {};
  constructor(private path: string, private env: NodeJS.ProcessEnv = process.env) {
    try { if (existsSync(path)) this.data = JSON.parse(readFileSync(path, 'utf8')) ?? {}; } catch { this.data = {}; }
  }
  private persist() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(this.path), 0o700); } catch { /* ignore */ }
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
  /** Secret effectif : fichier, surchargé par MCP_TOKEN_<ID> si défini. */
  get(id: string): ServerSecret | undefined {
    const file = this.data[id];
    const envTok = cleanToken(this.env[envTokenName(id)]);
    if (!file && !envTok) return undefined;
    return { ...(file ?? {}), ...(envTok ? { token: envTok } : {}) };
  }
  has(id: string) { const s = this.get(id); return !!(s?.token || (s?.headers && Object.keys(s.headers).length)); }
  /** token : string = remplacer, null = supprimer, undefined = inchangé ; idem headers. */
  update(id: string, patch: { token?: string | null; headers?: Record<string, string> | null }) {
    const cur = { ...(this.data[id] ?? {}) };
    if (patch.token === null) delete cur.token; else if (patch.token !== undefined) cur.token = patch.token;
    if (patch.headers === null) delete cur.headers; else if (patch.headers !== undefined) cur.headers = patch.headers;
    if (cur.token || cur.headers) this.data[id] = cur; else delete this.data[id];
    this.persist();
  }
  remove(id: string) { if (this.data[id]) { delete this.data[id]; this.persist(); } }
  view(id: string): AuthView {
    const s = this.get(id);
    const envTok = !!cleanToken(this.env[envTokenName(id)]);
    return { bearer: !!s?.token, tokenHint: s?.token ? hint(s.token) : undefined, headerNames: Object.keys(s?.headers ?? {}), source: envTok ? 'env' : s ? 'fichier' : 'aucun' };
  }
}

/** Message clair (français) pour les erreurs d'authentification ; ne contient jamais de valeur secrète. */
export function friendlyError(message: string, hasAuth: boolean, secretValues: string[] = []): string {
  let m = message;
  for (const v of secretValues) if (v && v.length >= 4) m = m.split(v).join('••••');
  if (/\b401\b|unauthori[sz]ed|authorization header|invalid[_ ]token|www-authenticate/i.test(m)) {
    return hasAuth
      ? `Jeton refusé par le serveur (401) : vérifie ou remplace le jeton Bearer. Détail : ${m.slice(0, 200)}`
      : `Le serveur demande une authentification : ajoute un jeton Bearer. Détail : ${m.slice(0, 200)}`;
  }
  if (/\b403\b|forbidden/i.test(m)) return `Accès refusé (403) : le jeton n'a pas les droits nécessaires. Détail : ${m.slice(0, 200)}`;
  return m;
}
