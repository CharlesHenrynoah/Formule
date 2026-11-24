/**
 * Outils « contremaître » du sous-agent d'app :
 *  - plan de chantier : plan_tasks / update_task → événements « plan » affichés dans le chat (tâches + statut)
 *  - retrieval MCP : mcp_list_tools / mcp_list_resources / mcp_read_resource / mcp_call
 *    périmètre = backend de l'app + serveurs MCP de la liste blanche de l'app (contrat.externalTools) ;
 *    lecture libre sur ces serveurs, écriture uniquement pour les outils listés ET après confirmation.
 */
import type { HubTool } from './store.ts';
import { Workspace } from '../agent/workspace.ts';

/**
 * Budget d'étapes pondéré par ordre : écriture/action = 1, lecture/attente = 0,5, tenue du plan / UI / mémoire = 0,25.
 * (L'ancien plafond de 8 tours SDK s'épuisait sur des sondages d'exécution n8n.)
 */
export const MAX_STEPS = Number(process.env.APP_AGENT_MAX_STEPS ?? 20);
export const ASK_TIMEOUT_MS = Number(process.env.APP_AGENT_TIMEOUT_MS ?? 240_000);
export type Task = { id: string; title: string; status: 'todo' | 'doing' | 'done' | 'failed' | 'skipped'; note?: string };
const HUB = process.env.MCP_HUB_URL ?? 'http://127.0.0.1:4004';

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const mk = (server: string, name: string, description: string, inputSchema: unknown, write = false): HubTool =>
  ({ id: `${server}__${name}`, name, server, description, inputSchema, write, safe: true, allowed: true });

export function foremanTools(): HubTool[] {
  return [
    mk('foreman', 'plan_tasks', "Plan de chantier : décompose l'ordre de l'utilisateur en 2 à 7 tâches (affichées dans le chat). À appeler en premier pour tout ordre multi-étapes.",
      obj({ tasks: { type: 'array', items: { type: 'string' }, description: 'Intitulés courts des tâches, dans l’ordre' } }, ['tasks'])),
    mk('foreman', 'evolve_app', "Délègue une DEMANDE D'ÉVOLUTION de l'app (nouveau panneau, nouveau graphique, connecter un MCP, changer le layout…) à l'équipe Data Engineer → Product Owner → Développeur (CLI shadcn, build). Produit une nouvelle version (historique et retour arrière conservés) et recharge l'aperçu. Ne pas utiliser pour une simple question sur les données.",
      obj({ request: { type: 'string', description: "La demande d'évolution reformulée clairement, à la 1re personne" } }, ['request'])),
    mk('foreman', 'app_cli', "CLI confinée au workspace de l'app (lecture seule + build) : « ls [dossier] », « cat <fichier> », « grep <motif> [fichier] », « npm run build ». Toute modification passe par evolve_app.",
      obj({ command: { type: 'string' } }, ['command'])),
    mk('foreman', 'update_task', "Met à jour le statut d'une tâche du plan (doing, done, failed, skipped) avec une note courte (résultat, contrôle qualité).",
      obj({ index: { type: 'integer', description: 'Numéro de la tâche (1 = première)' }, status: { type: 'string', enum: ['doing', 'done', 'failed', 'skipped'] }, note: { type: 'string' } }, ['index', 'status'])),
  ];
}

export function retrievalTools(): HubTool[] {
  return [
    mk('retrieval', 'mcp_list_tools', 'Découvre les outils MCP disponibles (backend de l’app + serveurs connectés autorisés) avec leur schéma et lecture/écriture.', obj({})),
    mk('retrieval', 'mcp_list_resources', 'Découvre les ressources MCP lisibles (documents, catalogues, objectifs…) des serveurs autorisés.', obj({})),
    mk('retrieval', 'mcp_read_resource', 'Lit une ressource MCP (server + uri issus de mcp_list_resources).', obj({ server: { type: 'string' }, uri: { type: 'string' } }, ['server', 'uri'])),
    mk('retrieval', 'mcp_call', 'Appelle un outil du moteur branché (id « serveur__outil »). Le moteur est interchangeable : tu utilises celui de la liste, pas une marque par défaut. Args minimaux, pagination courte, list/get plutôt qu’une recherche plein texte. Lecture libre ; écriture = confirmation.', obj({ tool: { type: 'string' }, args: { type: 'object' } }, ['tool'])),
  ];
}

/** Serveurs MCP accessibles à l'app : ceux de sa liste blanche (contrat.externalTools). */
export const allowedServers = (externalTools: string[] = []) => [...new Set(externalTools.map((t) => t.split('__')[0]).filter(Boolean))];

export async function hubJson(path: string, init?: RequestInit) {
  const r = await fetch(`${HUB}${path}`, { ...init, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error((body as { error?: string }).error ?? `mcp-hub ${r.status}`), { status: r.status });
  return body;
}

/** Catalogue de retrieval : outils de l'app + outils autorisés des serveurs de la liste blanche. */
export async function discover(own: HubTool[], externalTools: string[]) {
  const servers = allowedServers(externalTools);
  const hub = servers.length ? ((await hubJson('/tools?allowedOnly=1')) as HubTool[]).filter((t) => servers.includes(t.server)) : [];
  const ext = hub.map((t) => ({ ...t, write: t.write, writable: t.write && externalTools.includes(t.id) }));
  return { own, ext, servers };
}

export const sourceLabel = (t: { id?: string; server: string; name: string }) => `${t.server.startsWith('app-') ? 'backend de l’app' : t.server} › ${t.name}`;

// ---- CLI confinée (lecture seule + build) sur les fichiers de la dernière version de l'app ----
const STORAGE = process.env.STORAGE_URL ?? 'http://127.0.0.1:4003';
export async function appFiles(appId: string): Promise<Record<string, string>> {
  const r = await fetch(`${STORAGE}/projects/${encodeURIComponent(appId)}/latest`, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`version introuvable (${r.status})`);
  const v = await r.json() as { files?: Record<string, string> | null; code?: string };
  return v.files ?? { 'index.html': v.code ?? '' };
}
export const CLI_ALLOWED = /^(ls|cat|grep|npm run build)\b/;
export async function runAppCli(appId: string, command: string, files?: Record<string, string>) {
  const cmd = command.trim().replace(/\s+/g, ' ');
  if (!CLI_ALLOWED.test(cmd) || /[;&|`$<>]|\.\.(\/|$)/.test(cmd)) {
    return { ok: false, command: cmd, output: "Commande refusée : seules « ls », « cat », « grep » et « npm run build » sont autorisées, sans enchaînement ni chemin hors de l'app. Pour modifier l'app : evolve_app." };
  }
  const f = files ?? await appFiles(appId);
  const names = Object.keys(f).sort();
  const [verb, ...rest] = cmd.split(' ');
  if (verb === 'ls') { const dir = (rest[0] ?? '').replace(/^\.\/?/, '').replace(/\/$/, ''); return { ok: true, command: cmd, output: names.filter((n) => !dir || n.startsWith(dir + '/')).join('\n') || '(vide)' }; }
  if (verb === 'cat') { const n = (rest[0] ?? '').replace(/^\.\//, ''); return f[n] !== undefined ? { ok: true, command: cmd, output: f[n].slice(0, 6000) } : { ok: false, command: cmd, output: `fichier introuvable : ${n}` }; }
  if (verb === 'grep') {
    const [pat, file] = rest; if (!pat) return { ok: false, command: cmd, output: 'motif manquant' };
    const hits: string[] = [];
    for (const n of file ? [file] : names) (f[n] ?? '').split('\n').forEach((l, i) => { if (l.includes(pat) && hits.length < 60) hits.push(`${n}:${i + 1}: ${l.trim().slice(0, 160)}`); });
    return { ok: true, command: cmd, output: hits.join('\n') || '(aucune occurrence)' };
  }
  // npm run build : workspace jetable (template + fichiers de l'app), vite build confiné, délai 120 s
  const ws = await Workspace.create({ files: f });
  const r = await ws.build();
  return { ok: r.ok, command: 'npm run build (vite build)', output: `${r.ok ? 'build vert' : 'build en échec'} · ${r.ms} ms${r.bytes ? ` · ${Math.round(r.bytes / 1024)} Ko` : ''}\n${r.ok ? '' : r.output.slice(-1500)}` };
}

// ---- VOIX (Google, via voice-gateway) : un OUTIL du contremaître, comme MCP et la CLI. Mercury décide quoi dire et quand. ----
const VOICE = process.env.VOICE_GATEWAY_URL ?? 'http://127.0.0.1:4006';
export function voiceTools(): HubTool[] {
  return [
    mk('voice', 'speak', "voice.speak — Parle à l'utilisateur (TTS Google fr-FR, style Jarvis : posé, 1 à 2 phrases courtes, sans markdown ni chiffres illisibles). Le détail reste écrit dans le chat / le dashboard. Interruptible par l'utilisateur.",
      obj({ text: { type: 'string', description: 'Ce qui doit être dit (court)' }, style: { type: 'string', enum: ['jarvis', 'alerte', 'neutre'] } }, ['text'])),
    mk('voice', 'listen', "voice.listen — Écoute la réponse orale de l'utilisateur (STT Google en streaming) et renvoie la transcription. Pour une question de suivi.",
      obj({ timeout_s: { type: 'integer', minimum: 2, maximum: 30 } })),
    mk('voice', 'confirm', "voice.confirm — Pose une question fermée à l'oral et renvoie oui / non / incertain. N'autorise JAMAIS seule une action à effet réel : celles-ci passent toujours par la carte de confirmation (visible), à laquelle l'utilisateur peut aussi répondre à la voix.",
      obj({ question: { type: 'string' } }, ['question'])),
    mk('voice', 'stop', 'voice.stop — Arrête immédiatement de parler / écouter.', obj({})),
  ];
}
const STYLE_VOICE: Record<string, string> = { jarvis: process.env.GEMINI_TTS_VOICE || 'Charon', alerte: 'Fenrir', neutre: 'Kore' };
export async function voiceSession(appId: string) {
  try {
    const r = await fetch(`${VOICE}/sessions/${encodeURIComponent(appId)}`, { signal: AbortSignal.timeout(800) });
    return r.ok ? await r.json() as { enabled: boolean; connected: boolean } : null;
  } catch { return null; }
}
export async function callVoice(appId: string, name: string, args: Record<string, unknown>) {
  const body = name === 'speak' ? { text: String(args.text ?? '').slice(0, 600), voice: STYLE_VOICE[String(args.style ?? 'jarvis')] }
    : name === 'listen' ? { timeoutMs: Math.min(30, Math.max(2, Number(args.timeout_s ?? 8))) * 1000 }
    : name === 'confirm' ? { question: String(args.question ?? '').slice(0, 300) } : {};
  const r = await fetch(`${VOICE}/sessions/${encodeURIComponent(appId)}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(name === 'speak' ? 45_000 : 40_000) });
  const j = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok) throw new Error(String(j.error ?? `voice-gateway ${r.status}`));
  return j;
}

// ---- Interface pilotée par le contremaître : composants d'action (shadcn) et scènes vivantes (PixiJS / three.js) ----
export const ACTION_COMPONENTS = ['Alert', 'Avatar', 'AvatarGroup', 'Badge', 'Button', 'ButtonLink', 'Checkbox', 'CodeBlock', 'DatePicker', 'DateRangePicker', 'EmptyMessage', 'Indicators', 'Input', 'Markdown', 'Menu', 'Popover', 'RadioGroup', 'SegmentedControl', 'Select', 'SelectControl', 'Slider', 'Switch', 'TagInput', 'TextLink', 'Textarea', 'CopyTooltip', 'Tooltip'] as const;
export const SCENE_CATALOG = { pixi: ['particle-flow', 'agent-sim', 'live-heatmap', 'network-graph'], three: ['3d-bars', '3d-surface', '3d-concept-model'] } as const;
