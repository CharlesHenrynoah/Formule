/** Mode du panneau Formule Agent : Ask = lecture interface/données ; Agent = écriture / actions / évolutions. */
export type ChatMode = 'ask' | 'agent';

export const CHAT_MODES: Array<{ id: ChatMode; label: string; hint: string }> = [
  { id: 'ask', label: 'Ask', hint: 'Lecture seule : questions sur l’interface et les données' },
  { id: 'agent', label: 'Agent', hint: 'Écriture : actions, évolutions, outils MCP en écriture' },
];

export const ASK_BLOCKED = 'Mode Ask : lecture seule. Passe en mode Agent pour écrire ou faire évoluer l’interface.';

export function isWriteBlocked(mode: ChatMode | undefined, write?: boolean) {
  return mode === 'ask' && !!write;
}
