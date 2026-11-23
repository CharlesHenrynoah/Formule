/**
 * Fil du chat du contremaître, hébergé dans l'onglet « Chat app » du studio.
 * La LOGIQUE du contremaître reste dans l'AppShell de la mini-app (ask → outils MCP, ui.render_action / ui.render_scene,
 * panneaux temporaires, contexte du dashboard) : l'app publie son fil via window.agent.saveTranscript (postMessage
 * « chat:save ») et le studio lui envoie les ordres (« chat:order », même chemin que les ordres dictés).
 * Ce module ne contient que des fonctions pures (testées dans frontend/test/app-chat.test.ts).
 */
export type ChatStep = { id: string; tool: string; args?: unknown; ok?: boolean; result?: unknown; error?: string; ms?: number; kind: 'tool' | 'cli' | 'voice'; output?: string };
export type ChatTask = { id: string; title: string; status: string; note?: string };
export type ChatMsg =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'agent'; text: string; steps: ChatStep[]; plan?: ChatTask[]; busy?: boolean; ms?: number }
  | { id: string; role: 'confirm'; tool: string }
  | { id: string; role: 'alert'; text: string }
  | { id: string; role: 'action'; actionId: string }
  | { id: string; role: 'pipeline'; title: string; status: string; steps: Array<{ label: string; ok?: boolean; detail?: string }> };

const ROLES = new Set(['user', 'agent', 'confirm', 'alert', 'action', 'pipeline']);

/** Valide/normalise un fil venu de l'iframe (non fiable) : rôles connus, champs attendus, 80 messages max. */
export function normalizeChat(raw: unknown): ChatMsg[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMsg[] = [];
  for (const m of raw.slice(-80)) {
    if (!m || typeof m !== 'object') continue;
    const x = m as Record<string, unknown>;
    const id = typeof x.id === 'string' ? x.id : '';
    if (!id || !ROLES.has(String(x.role))) continue;
    switch (x.role) {
      case 'user': case 'alert': out.push({ id, role: x.role, text: String(x.text ?? '') }); break;
      case 'agent': out.push({ id, role: 'agent', text: String(x.text ?? ''), steps: Array.isArray(x.steps) ? (x.steps as ChatStep[]).filter((s) => s && typeof s === 'object') : [], plan: Array.isArray(x.plan) ? (x.plan as ChatTask[]) : undefined, ms: typeof x.ms === 'number' ? x.ms : undefined }); break;
      case 'confirm': out.push({ id, role: 'confirm', tool: String(x.tool ?? '') }); break;
      case 'action': out.push({ id, role: 'action', actionId: String(x.actionId ?? '') }); break;
      case 'pipeline': out.push({ id, role: 'pipeline', title: String(x.title ?? 'Évolution'), status: String(x.status ?? 'running'), steps: Array.isArray(x.steps) ? (x.steps as Array<{ label: string; ok?: boolean; detail?: string }>) : [] }); break;
    }
  }
  return out;
}

/** Insère ou met à jour le suivi d'une évolution (pipeline Data Engineer → PO → Dev) dans le fil. */
export function upsertPipeline(msgs: ChatMsg[], p: Extract<ChatMsg, { role: 'pipeline' }>): ChatMsg[] {
  const i = msgs.findIndex((m) => m.id === p.id);
  if (i < 0) return [...msgs, p];
  const c = [...msgs]; c[i] = p; return c;
}

/** Signature des messages « qui méritent l'attention » (réponses, alertes, évolutions) pour l'indicateur de l'onglet. */
function signature(m: ChatMsg) {
  if (m.role === 'agent') return m.text ? `${m.id}:done` : '';
  if (m.role === 'alert') return m.id;
  if (m.role === 'pipeline') return m.status === 'running' ? '' : `${m.id}:${m.status}`;
  return '';
}

/** Vrai si `next` apporte du neuf par rapport à `prev` (nouvelle réponse terminée, alerte, évolution terminée). */
export function hasNewActivity(prev: ChatMsg[], next: ChatMsg[]): boolean {
  const seen = new Set(prev.map(signature).filter(Boolean));
  return next.some((m) => { const s = signature(m); return !!s && !seen.has(s); });
}

/** Message vide de l'onglet selon l'état du studio (aucune app, génération en cours, app sans contremaître…). */
export function chatEmptyReason(s: { hasProject: boolean; running: boolean; appError: string | null; capable: boolean | null }): string | null {
  if (!s.hasProject) return s.running ? "Formule Agent construit l'interface… La conversation continue ici dès qu'elle est prête." : "Aucune app ouverte. Décris l'interface que tu veux ci-dessous (ou ouvre-en une dans la liste).";
  if (s.appError) return s.appError;
  if (s.capable === false) return "Cette app n'a pas de chat intégré (générée en mode direct ou avant l'AppShell) : tes demandes la font évoluer directement.";
  return null;
}
