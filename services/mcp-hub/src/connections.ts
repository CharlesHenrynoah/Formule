import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { FailureKind } from '@formule/contracts';
import type { ServerConfig } from './config.js';
import { serverEnvSecret, serverToken } from '@formule/service-kit/secrets';
import { parseCsv } from './files.js';
import { parseMarkdown } from './markdown.js';

interface Conn { client: Client; status: 'connected' | 'error'; error?: string; version?: string }
const conns = new Map<string, Conn>();

export class HubError extends Error {
  constructor(public kind: FailureKind, message: string, public status = 502, public retryAfterMs?: number) { super(message); }
}

export { classifyError } from './failure.js';
import { classifyError, retryAfterMs } from './failure.js';

export async function getClient(cfg: ServerConfig): Promise<Client> {
  const existing = conns.get(cfg.id);
  if (existing?.status === 'connected') return existing.client;
  const client = new Client({ name: 'formule-hub', version: '1.0.0' });
  const token = serverToken(cfg.id);
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  try {
    let transport;
    if (cfg.transport === 'stdio') {
      if (!cfg.command) throw new HubError('not_connected', 'commande stdio absente');
      // env nettoyé : aucun secret de Formule transmis au processus
      // env nettoyé + variables DÉCLARÉES du serveur ; secrets lus à la connexion, jamais journalisés
      const secretVars = Object.fromEntries((cfg.secretEnv ?? []).map((n) => [n, serverEnvSecret(cfg.id, n)]).filter(([, v]) => v)) as Record<string, string>;
      const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_OPTIONS: '', ...(cfg.env ?? {}), ...secretVars, ...(cfg.demo ? Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('DEMO_')) as [string, string][]) : {}) };
      transport = new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env, stderr: 'ignore' });
    } else if (cfg.transport === 'http') {
      transport = new StreamableHTTPClientTransport(new URL(cfg.url!), { requestInit: { headers } });
    } else if (cfg.transport === 'sse') {
      transport = new SSEClientTransport(new URL(cfg.url!), { requestInit: { headers }, eventSourceInit: { fetch: (u, i) => fetch(u, { ...i, headers: { ...(i?.headers as Record<string, string>), ...headers } }) } });
    } else throw new HubError('not_connected', 'transport non MCP');
    await withTimeout(client.connect(transport), 15_000, 'connexion');
    conns.set(cfg.id, { client, status: 'connected', version: client.getServerVersion()?.version });
    client.onclose = () => conns.delete(cfg.id);
    return client;
  } catch (e) {
    conns.set(cfg.id, { client, status: 'error', error: (e as Error).message });
    throw e instanceof HubError ? e : new HubError(classifyError(e), (e as Error).message, 502, retryAfterMs(e));
  }
}

export function connStatus(id: string) { const c = conns.get(id); return c ? { status: c.status, error: c.error, version: c.version } : { status: 'idle' as const }; }
export async function disconnect(id: string) { const c = conns.get(id); conns.delete(id); try { await c?.client.close(); } catch { /* ignore */ } }

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new HubError('timeout', `${what} : délai de ${ms} ms dépassé`, 504)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/**
 * Extrait le résultat d'un appel d'outil : structuredContent, sinon JSON du texte, sinon CSV (conversion DÉCLARÉE),
 * sinon texte brut (documentation : jamais une mesure).
 */
export function extractResult(res: { content?: unknown; structuredContent?: unknown; isError?: boolean }): { raw: unknown; textOnly: boolean; note?: string } {
  let text: string | null = null;
  const sc = res.structuredContent as Record<string, unknown> | undefined;
  if (sc !== undefined) {
    const keys = sc && typeof sc === 'object' ? Object.keys(sc) : [];
    // certains serveurs (filesystem) renvoient { content: "<texte du fichier>" }
    if (keys.length === 1 && typeof sc[keys[0]] === 'string' && keys[0] === 'content') text = sc.content as string;
    else return { raw: sc, textOnly: false };
  }
  if (text === null) {
    const texts = Array.isArray(res.content) ? (res.content as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text ?? '') : [];
    text = texts.join('\n');
  }
  try {
    const j = JSON.parse(text);
    // serveurs « code mode » : la valeur utile est celle retournée par run()
    if (j && typeof j === 'object' && !Array.isArray(j) && 'result' in j && Object.keys(j).every((k) => ['result', 'logs', 'log_lines', 'err', 'error'].includes(k))) {
      if (j.err || j.error) return { raw: { texte: String(j.err ?? j.error) }, textOnly: true, note: 'exécution en erreur' };
      return { raw: j.result, textOnly: false, note: 'valeur retournée par le gabarit de code' };
    }
    return { raw: j, textOnly: false };
  } catch { /* pas du JSON */ }
  const md = parseMarkdown(text);
  if (md) return { raw: md.raw, textOnly: false, note: md.note };
  const csv = looksLikeCsv(text);
  if (csv) {
    const { rows, numericColumns } = parseCsv(text);
    return { raw: { lignes: rows }, textOnly: false, note: `texte CSV converti (conversion déclarée) ; colonnes numériques : ${numericColumns.join(', ') || 'aucune'}` };
  }
  return { raw: { texte: text }, textOnly: true };
}

function looksLikeCsv(text: string): boolean {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim()).slice(0, 20);
  if (lines.length < 3) return false;
  for (const sep of [',', ';', '\t']) {
    const n = lines[0].split(sep).length;
    if (n >= 2 && lines.every((l) => l.split(sep).length === n)) return true;
  }
  return false;
}
