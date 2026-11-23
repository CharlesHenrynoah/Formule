// Ponts injectés par le studio Everything Software dans l'iframe de l'app (postMessage → gateway).
export {};
export type AgentEvent = { type: string; [k: string]: any };
export type VoiceState = { enabled: boolean; connected: boolean; mode: 'off' | 'ptt' | 'handsfree'; listening: boolean; speaking: boolean; interim: string; level: number; out: number; error?: string; provider?: string };
declare global {
  interface Window {
    /** Backend MCP propre à l'app (outils du contrat). */
    app?: { call: (tool: string, args?: Record<string, unknown>) => Promise<any>; tools: () => Promise<Array<{ name: string; description?: string; write: boolean; safe: boolean }>>; onChange: (cb: () => void) => () => void };
    /** Contremaître de l'app (OpenAI Agents SDK) : chat unique, streaming, plan de chantier, confirmations inline. */
    agent?: {
      ask: (message: string, opts?: {
        onDelta?: (d: string) => void;
        onTool?: (e: { type: 'tool_call' | 'tool_result'; tool: string; ok?: boolean; args?: unknown; result?: unknown; error?: string }) => void;
        onUi?: (patch: Record<string, any>) => void;
        onConfirm?: (card: HTMLElement, info: { tool: string; args: unknown }) => void;
        onEvent?: (e: AgentEvent) => void;
        context?: unknown;
      }) => Promise<string>;
      reset: () => void;
      /** Vrai dans le studio : le chat du contremaître est affiché dans l'onglet « Chat app » du studio. */
      hosted?: boolean;
      /** Publie le nom du contremaître et ses commandes rapides vers le studio. */
      shell?: (info: { agentName?: string; commands?: string[] }) => void;
      transcript: () => Promise<any[]>;
      saveTranscript: (messages: any[]) => void;
      onPipeline: (cb: (e: AgentEvent) => void) => () => void;
      /** Voix (Google, outil du contremaître) : ordres dictés, état micro/parole, pilotage du micro. */
      onVoice?: (cb: (text: string) => void) => () => void;
      onVoiceState?: (cb: (s: VoiceState) => void) => () => void;
      voice?: (cmd: 'toggle' | 'handsfree' | 'off' | 'ptt-down' | 'ptt-up' | 'stop' | 'state') => void;
    };
    /** Outils MCP externes autorisés (ex. demo__get_metrics). */
    mcp?: { call: (tool: string, args?: Record<string, unknown>) => Promise<any>; tools: () => Promise<unknown[]> };
  }
}
