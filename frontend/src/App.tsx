import { useCallback, useEffect, useRef, useState } from 'react';
import { api, streamAsk, streamGenerate } from './api';
import { readDataset } from './lib/datasets';
import { withBridge, SANDBOX } from './bridge';
import { GoogleVoiceClient, afterWakeWord, type VoiceState } from './voice/provider';
import { Sidebar } from './components/Sidebar';
import { McpPanel } from './components/McpPanel';
import { ConfirmDialog } from './components/ConfirmDialog';
import { FormuleAgentPanel, type HostedConfirm } from './components/FormuleAgentPanel';
import { PanelGrip } from './components/PanelGrip';
import { PANEL_KEY, clampWidth, dragResult, isToggleShortcut, parsePanel, type PanelState } from './lib/panelLayout';
import { AGENT_NAME, crewSteps, isFullAppRequest, neutral } from './lib/neutral';
import { isDashboardTurn, keepsOpenDashboard, type BoardView, type SavedDashboard } from './lib/dashboard';
import { LiveDashboard } from './components/LiveDashboard';
import logoUrl from './assets/logo.svg';
import { fixOrder, toRuntimeError, type RuntimeError } from './lib/runtimeError';
import { chatEmptyReason, hasNewActivity, normalizeChat, upsertPipeline, type ChatMsg } from './lib/appChat';
import { ASK_BLOCKED, type ChatMode } from './lib/chatMode';
import { Sparkles, Square, Brain, Plug, Loader2, Upload, FileSpreadsheet, X, ShieldCheck, Maximize2, Minimize2, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Card } from '@/components/ui/card';
import type { AppInfo, Dataset } from './types';
import { isSourceRefresh } from './lib/source';
import type { AgentEvent, EngineConfig, McpTool, PhaseKey, PhaseState, Project, ProjectSummary, ToolEvent, Validation } from './types';

/** Suggestions business : libellé court → prompt complet injecté dans le champ. */
export const EXAMPLES: Array<{ label: string; prompt: string }> = [
  { label: 'Revenu du mois', prompt: 'Crée une console du revenu du mois : paiements, abonnements et base.' },
  { label: 'Pipeline commercial', prompt: 'Crée une console du pipeline commercial, par étape et par personne.' },
  { label: 'Publicités rentables', prompt: 'Crée une console des publicités : coût d’un client, par canal.' },
  { label: 'Inscriptions devenues clients', prompt: 'Crée une console du chemin des inscriptions jusqu’au paiement.' },
];

type SideTab = 'chat';
type Pending = { tool: string; args: unknown; resolve: (ok: boolean) => void; origin?: string };

export default function App() {
  const [config, setConfig] = useState<EngineConfig | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [versionNo, setVersionNo] = useState<number | null>(null);
  const [mcpTools, setMcpTools] = useState<McpTool[]>([]);

  const [prompt, setPrompt] = useState('');
  const [diffusing, setDiffusing] = useState(false);
  // Équipe d'agents toujours activée (plus de toggle dans l'UI) ; mode diffusion : valeur par défaut conservée, sans toggle.
  // Les outils MCP suivent le mode Agent (Ask = lecture seule, plus de switch « Outils »).
  const [agentMode, setAgentMode] = useState(true);
  /** Ask = lecture interface/données ; Agent = écriture / actions / évolutions. */
  const [chatMode, setChatMode] = useState<ChatMode>('agent');
  const chatModeRef = useRef<ChatMode>('agent'); chatModeRef.current = chatMode;
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  const sideTab: SideTab = 'chat'; // panneau unique « Formule Agent » (toujours visible)
  // Onglet « Chat app » : fil du contremaître de l'app ouverte (la logique reste dans l'AppShell de l'app)
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
    const [chatCapable, setChatCapable] = useState<boolean | null>(null);
  const [chatShell, setChatShell] = useState<{ agentName: string; commands: string[] }>({ agentName: AGENT_NAME, commands: [] });
  const [voiceState, setVoiceState] = useState<VoiceState | null>(null);
  const [hostedConfirm, setHostedConfirm] = useState<HostedConfirm | null>(null);
  const sideTabRef = useRef(sideTab); sideTabRef.current = sideTab;
  const chatMsgsRef = useRef(chatMsgs); chatMsgsRef.current = chatMsgs;
  const frameReady = useRef(false);
  const orderQueue = useRef<string[]>([]);
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [codeFile, setCodeFile] = useState<string>('__html');

  const [running, setRunning] = useState(false);
  const [offer, setOffer] = useState<{ text: string; canBuild: boolean; prompt: string } | null>(null);
  const briefRef = useRef('');
  const [phases, setPhases] = useState<PhaseState[]>([]);
  const [plan, setPlan] = useState('');
  const [planStreaming, setPlanStreaming] = useState(false);
  const [streamCode, setStreamCode] = useState('');
  const [diffStep, setDiffStep] = useState(0);
  const [toolEvents, setToolEvents] = useState<ToolEvent[]>([]);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | undefined>();

    const [previewCode, setPreviewCode] = useState('');
  const [boards, setBoards] = useState<SavedDashboard[]>([]);
  const [board, setBoard] = useState<BoardView | null>(null);
  const boardRef = useRef<BoardView | null>(null); boardRef.current = board;
  const [draft, setDraft] = useState('');
  const [showMcp, setShowMcp] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [appError, setAppError] = useState<RuntimeError | null>(null);
  // Mini-SaaS : backend MCP propre + sous-agent de l'app affichée
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [appInfoError, setAppInfoError] = useState<string | null>(null);
  const [appRefresh, setAppRefresh] = useState(0);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const appRef = useRef<{ id: string; version: number; info: AppInfo } | null>(null);
  const appSettled = useRef(false); // true quand ensure a fini (réussi ou non) : tant que c'est false, les appels attendent
  const appBoot = useRef(''); // id@version déjà accroché : un changement remet l'attente avant le prochain rendu de l'iframe
  const bootingRef = useRef(false); // vrai entre la fin de génération et l'ensure du projet tout juste enregistré
  const runningRef = useRef(false);
  // Voix (Google, via voice-gateway) : un client par app ouverte ; la voix est un OUTIL du contremaître Mercury.
  const voiceRef = useRef<GoogleVoiceClient | null>(null);
  const projRef = useRef<string | null>(null);
  const voiceAt = useRef(0);          // dernier ordre dicté (le contremaître répond alors à l'oral)
  const wakeArmed = useRef(0);        // « Jarvis » seul → la phrase suivante est un ordre
  // Évolution demandée au contremaître (evolve_app) → pipeline Data Engineer → PO → Dev, suivi dans le chat
  const pipeRef = useRef<((e: { status: string; steps: Array<{ label: string; ok?: boolean; detail?: string }> }) => void) | null>(null);
  const runRef = useRef<(text: string, iterate: boolean, phase?: 'source' | 'build') => Promise<void>>(async () => {});

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const codeBuf = useRef('');
  const planBuf = useRef('');
  const flushRef = useRef<number | null>(null);
  const lastPreview = useRef(0);
  const toolsRef = useRef<McpTool[]>([]);
  const codeEndRef = useRef<HTMLPreElement>(null);
  toolsRef.current = mcpTools;

  const refreshProjects = useCallback(() => api.projects().then(setProjects).catch(() => {}), []);
  // Compteur d'outils MCP : un échec (services en cours de (re)démarrage) ne fige plus « 0 outil » — on garde la
  // dernière liste connue et on réessaie (2 s, 4 s, … 30 s), puis à chaque retour sur l'onglet.
  const toolsRetry = useRef<number | undefined>(undefined);
  const refreshTools = useCallback(function load(attempt = 0): Promise<void> {
    window.clearTimeout(toolsRetry.current);
    return api.mcpTools().then((t) => {
      const list = Array.isArray(t) ? t : [];
      setMcpTools(list);
      if (!list.length && attempt < 6) toolsRetry.current = window.setTimeout(() => void load(attempt + 1), Math.min(30_000, 2000 * 2 ** attempt));
    }).catch(() => { if (attempt < 8) toolsRetry.current = window.setTimeout(() => void load(attempt + 1), Math.min(30_000, 2000 * 2 ** attempt)); });
  }, []);
  useEffect(() => {
    const onFocus = () => { if (document.visibilityState === 'visible') void refreshTools(); };
    document.addEventListener('visibilitychange', onFocus); window.addEventListener('focus', onFocus);
    return () => { document.removeEventListener('visibilitychange', onFocus); window.removeEventListener('focus', onFocus); window.clearTimeout(toolsRetry.current); };
  }, [refreshTools]);
  useEffect(() => {
    api.config().then((c) => { setConfig(c); const ok = !!c?.agent?.available; setAgentMode(ok && c.agent.defaultMode !== 'direct'); }).catch(() => {});
    refreshProjects();
    refreshTools();
  }, [refreshProjects, refreshTools]);

  projRef.current = project?.id ?? null;
  const current = project?.versions.find((v) => v.number === versionNo) ?? project?.versions.at(-1) ?? null;
  // Même rendu que le projet : sinon l'iframe appelle pendant que l'effet n'a pas encore démarré,
  // appSettled est encore vrai (écran vide) et l'alerte « backend indisponible » part à tort.
  const bootKey = project?.id && current?.app ? `${project.id}@${current.number}` : '';
  if (appBoot.current !== bootKey) {
    appBoot.current = bootKey;
    if (bootKey) { appRef.current = null; appSettled.current = false; }
  }

  /** Confirmation humaine (ConfirmDialog shadcn) pour les écritures non sûres. */
  const requestConfirm = useCallback((tool: string, args: unknown, origin?: string) => new Promise<boolean>((resolve) => {
    setPending({ tool, args, origin, resolve: (ok) => { setPending(null); resolve(ok); } });
  }), []);

  // Backend MCP + agent de la version affichée : démarrés à la demande via app-agents.
  // L'iframe appelle window.app dès son montage, souvent avant la fin d'ensure : on n'annonce
  // « indisponible » qu'une fois ensure terminé sans backend.
  useEffect(() => {
    appRef.current = null; appSettled.current = false; setAppInfo(null); setAppInfoError(null);
    if (!project || !current) { appSettled.current = true; bootingRef.current = false; return; }
    if (!current.app) { appSettled.current = true; bootingRef.current = false; setAppInfoError("Cette version n'a pas de backend MCP ni d'agent (app générée en mode direct ou avant cette fonctionnalité). Régénérez-la avec l'équipe d'agents."); return; }
    let alive = true;
    api.appEnsure(project.id, current.number)
      .then((info: AppInfo) => {
        if (!alive) return;
        setAppInfo(info); appRef.current = { id: project.id, version: info.version, info }; appSettled.current = true; bootingRef.current = false;
        iframeRef.current?.contentWindow?.postMessage({ __es: 'app:changed' }, '*');
      })
      .catch((e) => { if (!alive) return; appSettled.current = true; bootingRef.current = false; setAppInfoError(`Backend MCP indisponible : ${(e as Error).message}`); });
    return () => { alive = false; };
  }, [project?.id, current?.number, current?.app]); // eslint-disable-line react-hooks/exhaustive-deps

  runningRef.current = running;
  /** Attend le backend de l'interface (ensure), y compris pendant la construction où le projet arrive à la fin. */
  const waitApp = useCallback(() => new Promise<{ id: string; version: number; info: AppInfo } | null>((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const id = projRef.current;
      const a = appRef.current;
      if (a && a.id === id) return resolve(a);
      const pending = runningRef.current || bootingRef.current || (!!id && !appSettled.current);
      if (!pending || Date.now() - t0 > 35_000) return resolve(null);
      window.setTimeout(tick, 40);
    };
    tick();
  }), []);
  const callLane = useRef(Promise.resolve());
  const enqueueCall = useCallback((fn: () => Promise<void>) => {
    const run = callLane.current.then(fn, fn);
    callLane.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);
  const backendToastAt = useRef(0);
  const tellBackendDown = useCallback(() => {
    const now = Date.now();
    if (now - backendToastAt.current < 4_000) return;
    backendToastAt.current = now;
    toast.error("Backend de l'interface indisponible");
  }, []);

  // ---- Fil du chat de chaque app (conservé à travers les nouvelles versions / rechargements à chaud) ----
  const chatKey = (id: string) => `es-chat-${id}`;
  const loadChat = (id: string) => { try { return JSON.parse(localStorage.getItem(chatKey(id)) ?? '[]') as Array<Record<string, unknown>>; } catch { return []; } };
  const saveChat = (id: string, m: unknown[]) => { try { localStorage.setItem(chatKey(id), JSON.stringify(m.slice(-80))); } catch { /* quota */ } };
  /** Met à jour le fil (stockage + onglet Chat app) ; pastille sur l'onglet s'il y a du neuf et qu'il n'est pas ouvert. */
  const setChat = useCallback((id: string, next: ChatMsg[]) => {
    saveChat(id, next);
    if (id !== projRef.current) return;
    chatMsgsRef.current = next; setChatMsgs(next);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Changement d'app : on recharge son fil ; le contremaître est « prêt » quand l'AppShell de l'iframe demande son fil.
  useEffect(() => {
    setChatMsgs(project?.id ? normalizeChat(loadChat(project.id)) : []);
    setChatCapable(null); setChatBusy(false); setChatShell({ agentName: AGENT_NAME, commands: [] }); orderQueue.current = [];
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Nouvelle source de l'aperçu : l'iframe se recharge ; sans AppShell au bout de 8 s → app sans contremaître.
  useEffect(() => { frameReady.current = false; }, [previewCode]);
  useEffect(() => {
    if (!previewCode || running) return;
    const t = setTimeout(() => { if (!frameReady.current) setChatCapable(false); }, 8000);
    return () => clearTimeout(t);
  }, [previewCode, running]);

  useEffect(() => {
    voiceRef.current?.close(); voiceRef.current = null;
    if (!project?.id) return;
    const frame = () => iframeRef.current?.contentWindow;
    const v = new GoogleVoiceClient(project.id, {
      onState: (st: VoiceState) => { setVoiceState({ ...st }); frame()?.postMessage({ __es: 'voice:state', state: st }, '*'); },
      onFinal: (text, consumed) => {
        if (consumed || !text) return; // consommée par voice.listen / voice.confirm
        let order: string | null = text;
        if (v.state.mode === 'handsfree') { // mains libres : mot d'activation « Jarvis »
          const w = afterWakeWord(text);
          if (w === '') { wakeArmed.current = Date.now(); return; }
          order = w ?? (Date.now() - wakeArmed.current < 10_000 ? text : null);
          if (!order) return;
          wakeArmed.current = 0;
        }
        voiceAt.current = Date.now();
        frame()?.postMessage({ __es: 'voice:command', text: order }, '*');
      },
    });
    voiceRef.current = v;
    return () => { v.close(); setVoiceState(null); };
  }, [project?.id]);

  const notifyChanged = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({ __es: 'app:changed' }, '*');
    setAppRefresh((n) => n + 1);
  }, []);

  // ---- Confirmation dans l'onglet Chat app (carte du studio, hors iframe) ; voix en parallèle ; 120 s max.
  //      Si l'onglet n'est pas ouvert : boîte de dialogue du studio (on ne bascule jamais d'onglet de force).
  const hostedConfirmAsk = useCallback((ev: { callId: string; tool: string; args: unknown }) => {
    if (sideTabRef.current !== 'chat') return requestConfirm(ev.tool, ev.args, AGENT_NAME);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); setHostedConfirm(null); resolve(ok); };
      const timer = setTimeout(() => done(false), 120_000);
      setHostedConfirm({ callId: ev.callId, tool: ev.tool, args: ev.args, answer: done });
      const v = voiceRef.current; const a = appRef.current;
      if (v && a && v.state.enabled && v.state.connected && (v.state.mode !== 'off' || Date.now() - voiceAt.current < 120_000)) {
        fetch(`/voice/sessions/${encodeURIComponent(a.id)}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: `Action à confirmer : ${ev.tool.replace(/_/g, ' ')}. Je lance ?`, timeoutMs: 12_000 }) })
          .then((r) => r.json()).then((r: { answer?: string }) => { if (r.answer === 'oui' || r.answer === 'non') done(r.answer === 'oui'); }).catch(() => {});
      }
    });
  }, [requestConfirm]);

  /** Ordre tapé dans l'onglet Chat app → AppShell de l'app (même chemin que les ordres dictés). */
  const sendOrder = useCallback((text: string) => {
    const f = iframeRef.current?.contentWindow;
    const mode = chatModeRef.current;
    if (f && frameReady.current) f.postMessage({ __es: 'chat:order', text, mode }, '*');
    else orderQueue.current.push(text); // iframe en (re)chargement : envoyé dès que l'AppShell est prêt
  }, []);

  const setChatModeAndSync = useCallback((m: ChatMode) => {
    setChatMode(m);
    chatModeRef.current = m;
    const f = iframeRef.current?.contentWindow;
    if (f && frameReady.current) f.postMessage({ __es: 'chat:mode', mode: m }, '*');
  }, []);

  // ---- Pont MCP : messages venant de l'iframe ----
  useEffect(() => {
    const onMsg = async (e: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow;
      if (!frame || e.source !== frame) return; // seule l'iframe de la mini-app est écoutée
      const d = e.data as { __es?: string; id?: number; tool?: string; args?: unknown; message?: string };
      if (d?.__es === 'app:error') { setAppError(toRuntimeError(d as never)); return; }
      const reply = (ok: boolean, data?: unknown, err?: string) => frame.postMessage({ __es: 'mcp:result', id: d.id, ok, data, error: err }, '*');
      const dd = d as typeof d & { message?: string; history?: unknown[]; context?: unknown; inline?: boolean; messages?: unknown[] };
      if (d?.__es === 'chat:load') { // l'AppShell est monté : contremaître disponible, on vide la file d'ordres
        reply(true, projRef.current ? loadChat(projRef.current) : []);
        frameReady.current = true; setChatCapable(true);
        frame.postMessage({ __es: 'chat:mode', mode: chatModeRef.current }, '*');
        setTimeout(() => { const q = orderQueue.current.splice(0); q.forEach((t) => frame.postMessage({ __es: 'chat:order', text: t, mode: chatModeRef.current }, '*')); }, 50);
        return;
      }
      if (d?.__es === 'chat:shell') { const x = d as { agentName?: unknown; commands?: unknown }; setChatShell({ agentName: AGENT_NAME, commands: Array.isArray(x.commands) ? x.commands.map(String).slice(0, 6) : [] }); return; }
      if (d?.__es === 'chat:save') { if (projRef.current && Array.isArray(dd.messages)) setChat(projRef.current, normalizeChat(dd.messages)); return; }
      if (d?.__es === 'voice:control') {
        const v = voiceRef.current; const cmd = String((d as { cmd?: string }).cmd ?? '');
        if (!v) return;
        if (cmd === 'ptt-down') v.pttDown(); else if (cmd === 'ptt-up') v.pttUp(); else if (cmd === 'stop') v.stop();
        else if (cmd === 'handsfree') void v.setMode('handsfree'); else if (cmd === 'off') void v.setMode('off');
        else if (cmd === 'toggle') void v.setMode(v.state.mode === 'handsfree' ? 'off' : 'handsfree');
        else if (cmd === 'state') frame.postMessage({ __es: 'voice:state', state: v.state }, '*');
        return;
      }
      if (d?.__es === 'app:tools') { const a = await waitApp(); reply(true, a?.info.tools.map(({ name, description, write, safe }) => ({ name, description, write, safe })) ?? []); return; }
      if (d?.__es === 'app:call' && d.tool) {
        const a = await waitApp();
        if (!a) { tellBackendDown(); reply(false, null, "Backend MCP de l'app indisponible"); return; }
        const t = a.info.tools.find((x) => x.name === d.tool);
        const evId = `app-${Date.now()}-${d.id}`;
        if (!t) { setToolEvents((l) => [...l, { id: evId, name: `app.${d.tool}`, args: d.args, source: 'exécution', status: 'refusé', error: 'outil hors contrat' }]); toast.error(`Action indisponible : outil « ${d.tool} » non déclaré`); reply(false, null, `Outil inconnu pour cette app : ${d.tool}`); return; }
        if (chatModeRef.current === 'ask' && t.write) {
          setToolEvents((l) => [...l, { id: evId, name: `app.${t.name}`, args: d.args, source: 'exécution', status: 'refusé', error: 'mode Ask' }]);
          toast.message(ASK_BLOCKED); reply(false, null, ASK_BLOCKED); return;
        }
        let confirmed = false;
        if (t.write && !t.safe) {
          confirmed = await requestConfirm(t.name, d.args, "l'app (son backend MCP)");
          if (!confirmed) { toast('Action refusée'); reply(false, null, "Action refusée par l'utilisateur"); return; }
        }
        try {
          await enqueueCall(async () => {
            const r = await api.appCall(a.id, { tool: t.name, args: d.args, version: a.version, source: 'ui', confirmed });
            setToolEvents((l) => [...l.slice(-60), { id: evId, name: `app.${t.name}`, args: d.args, result: r.data, ms: r.ms, source: 'exécution', status: 'ok' }]);
            if (t.write) setAppRefresh((n) => n + 1);
            reply(true, r.data);
          });
        } catch (err) { toast.error(`Erreur (${t.name}) : ${(err as Error).message}`); reply(false, null, (err as Error).message); }
        return;
      }
      if (d?.__es === 'agent:ask') {
        const a = await waitApp();
        if (!a) { reply(false, null, "Agent de l'app indisponible"); return; }
        let text = ''; let changed = false; let errMsg: string | null = null; let evolve = null as string | null;
        const vs = voiceRef.current?.state;
        const voice = !!vs && vs.enabled && vs.connected && (vs.mode !== 'off' || Date.now() - voiceAt.current < 60_000);
        const mode: ChatMode = (dd as { mode?: string }).mode === 'ask' || chatModeRef.current === 'ask' ? 'ask' : 'agent';
        setChatBusy(true);
        try {
          await streamAsk(a.id, { message: String(dd.message ?? ''), history: dd.history, version: a.version, context: typeof dd.context === 'string' ? dd.context : undefined, voice, mode }, async (ev) => {
            if (ev.type === 'iterate') {
              if (mode === 'ask') { errMsg = ASK_BLOCKED; return; }
              evolve = String(ev.request ?? '');
            }
            if (ev.type === 'confirm') {
              if (mode === 'ask') { await api.appConfirm(a.id, ev.callId, false).catch(() => {}); return; }
              // Carte de confirmation dans l'onglet Chat app du studio (ou boîte de dialogue s'il est fermé).
              const ok = await hostedConfirmAsk(ev);
              setToolEvents((l) => [...l.slice(-60), { id: `cf-${ev.callId}`, name: `confirmation ${ev.tool}`, args: ev.args, source: 'exécution', status: ok ? 'ok' : 'refusé', error: ok ? undefined : "refusé par l'utilisateur" }]);
              await api.appConfirm(a.id, ev.callId, ok).catch(() => {}); return;
            }
            if (ev.type === 'error') errMsg = String(ev.message);
            if (ev.type === 'delta') text += ev.text;
            if (ev.type === 'done') { text = ev.text || text; changed = ev.changed; }
            if (ev.type === 'tool_result' && ev.ok) changed = changed || /^(add|create|update|complete|delete|remove|set|toggle|log|record)_/.test(ev.tool);
            if (ev.type === 'tool_result' && ev.tool === 'set_dashboard') return; // l'événement « ui » suffit
            frame.postMessage({ __es: 'agent:event', id: d.id, event: ev }, '*');
          });
          if (errMsg && !text) reply(false, null, errMsg); else reply(true, text);
        } catch (err) { reply(false, null, (err as Error).message); }
        setChatBusy(false);
        if (changed && mode !== 'ask') notifyChanged(); else setAppRefresh((n) => n + 1);
        if (mode !== 'ask' && evolve !== null && (evolve as string)) { // le contremaître a délégué une évolution : l'équipe itère, le suivi s'affiche dans le chat de l'app
          startEvolution(evolve as string, a.id);
        }
        return;
      }
      if (d?.__es === 'mcp:tools') { reply(true, toolsRef.current.map(({ id, description, write }) => ({ id, description, write }))); return; }
      if (d?.__es !== 'mcp:call' || !d.tool) return;
      const tool = toolsRef.current.find((t) => t.id === d.tool);
      const evId = `rt-${Date.now()}-${d.id}`;
      const push = (patch: Partial<ToolEvent>) => setToolEvents((list) => {
        const i = list.findIndex((x) => x.id === evId);
        if (i < 0) return [...list, { id: evId, name: d.tool!, args: d.args, source: 'exécution', status: 'en cours', ...patch }];
        const copy = [...list]; copy[i] = { ...copy[i], ...patch }; return copy;
      });
      if (!tool) { push({ status: 'refusé', error: 'outil hors liste blanche' }); toast.error(`Outil MCP indisponible : ${d.tool}`); reply(false, null, `Outil non autorisé : ${d.tool}`); return; }
      if (chatModeRef.current === 'ask' && tool.write) {
        push({ status: 'refusé', error: 'mode Ask' }); toast.message(ASK_BLOCKED); reply(false, null, ASK_BLOCKED); return;
      }
      push({});
      let confirmed = false;
      if (tool.write) {
        confirmed = await requestConfirm(tool.id, d.args);
        if (!confirmed) { push({ status: 'refusé', error: "refusé par l'utilisateur" }); toast('Action MCP refusée'); reply(false, null, "Action refusée par l'utilisateur"); return; }
      }
      // Source n8n d'une app : « exécuter » = exécution manuelle → attente de la fin → ingestion dans l'app
      // (execute_workflow seul rend la main avant la fin, et rien n'alimentait get_kpis).
      const a = appRef.current;
      if (a && confirmed && isSourceRefresh(tool.id, a.info.agent?.externalTools)) {
        try {
          const x = (d.args ?? {}) as { workflowId?: string; triggerNodeName?: string; inputs?: { webhookData?: unknown } };
          const r = await api.appRefresh(a.id, { confirmed: true, version: a.version, workflowId: x.workflowId, triggerNodeName: x.triggerNodeName, webhookData: x.inputs?.webhookData });
          push({ status: r.statut === 'success' ? 'ok' : 'erreur', result: r, ms: r.attente_ms });
          reply(true, r);
          notifyChanged();
        } catch (err) { push({ status: 'erreur', error: (err as Error).message }); toast.error(`Erreur source : ${(err as Error).message}`); reply(false, null, (err as Error).message); }
        return;
      }
      try {
        await enqueueCall(async () => {
          const r = await api.mcpCall(tool.id, d.args, confirmed);
          push({ status: r.isError ? 'erreur' : 'ok', result: r.data, ms: r.ms });
          if (r.isError) {
            const msg = typeof r.data === 'string' ? r.data : 'Erreur outil MCP';
            toast.error(`${tool.id} : ${msg}`);
            reply(false, null, msg);
          } else reply(true, r.data);
        });
      } catch (err) {
        push({ status: 'erreur', error: (err as Error).message });
        toast.error(`${tool.id} : ${(err as Error).message}`);
        reply(false, null, (err as Error).message);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [requestConfirm, notifyChanged, hostedConfirmAsk, setChat]);

  const openProject = useCallback(async (id: string, version?: number) => {
    if (running) return;
    const p = (await api.project(id)) as Project;
    setProject(p);
    const versions = p.versions ?? [];
    const v = versions.find((x) => x.number === version) ?? versions.at(-1);
    if (v) {
      setVersionNo(v.number);
      setPreviewCode(v.code); setDraft(v.code); setPlan(v.plan ?? ''); setValidation(v.validation);
      setAgentEvents((v.agent?.trace as AgentEvent[]) ?? []); setFiles(v.files ?? null); setCodeFile(v.files?.['src/App.tsx'] ? 'src/App.tsx' : '__html');
    } else {
      setVersionNo(null); setPreviewCode(''); setDraft(''); setPlan(''); setValidation(null);
      setAgentEvents([]); setFiles(null); setCodeFile('__html');
    }
    setPhases([]); setToolEvents([]); setError(null); setStreamCode(''); setAppError(null); setElapsed(undefined);
    const list = await api.dashboards(id).catch(() => [] as SavedDashboard[]);
    setBoards(list);
    const shown = version ? undefined : list.at(-1);
    setBoard(shown ? { id: shown.id, spec: shown.spec, sketch: false, pendingChartId: null } : null);
  }, [running]);

  const newApp = () => {
    if (running) return;
    setProject(null); setVersionNo(null); setPreviewCode(''); setDraft(''); setPlan(''); setValidation(null);
    setPhases([]); setToolEvents([]); setError(null); setStreamCode(''); setPrompt(''); setAppError(null);
    setAgentEvents([]); setFiles(null); setCodeFile('__html'); setBoards([]); setBoard(null);
  };

  const scheduleFlush = () => {
    if (flushRef.current !== null) return;
    flushRef.current = requestAnimationFrame(() => {
      flushRef.current = null;
      setStreamCode(codeBuf.current);
      setPlan(planBuf.current);
      codeEndRef.current?.scrollIntoView({ block: 'end' });
    });
  };

  const setPhase = (phase: PhaseKey, label: string) => setPhases((list) => [
    ...list.map((p) => (p.status === 'running' ? { ...p, status: 'done' as const } : p)),
    { phase, label, status: 'running' },
  ]);

  /** Évolution (déléguée par l'agent de l'app, ou demandée directement) : suivi neutre dans le fil de l'interface. */
  const startEvolution = (req: string, projId: string) => {
    const pid = `pipe-${Date.now()}`; const title = `Évolution : ${req.slice(0, 80)}`;
    pipeRef.current = (e) => {
      const msg = { id: pid, role: 'pipeline' as const, title, ...e };
      iframeRef.current?.contentWindow?.postMessage({ __es: 'pipeline:event', event: msg }, '*');
      setChat(projId, upsertPipeline(normalizeChat(loadChat(projId)), msg));
    };
    void runRef.current(req, true, 'source');
  };
  /** Création : la demande et les étapes neutres ouvrent le fil de la nouvelle interface (historique conservé). */
  const agentEventsRef = useRef<AgentEvent[]>([]); agentEventsRef.current = agentEvents;
  const recordCreation = (projId: string, req: string) => {
    const { steps } = crewSteps(agentEventsRef.current, false);
    const t = Date.now();
    saveChat(projId, [...loadChat(projId),
      { id: `u-${t}`, role: 'user', text: req },
      { id: `pipe-${t}`, role: 'pipeline', title: 'Création de l’interface', status: 'done', steps: steps.map((x) => ({ label: x.name, ok: x.status !== 'failed' })) }]);
  };
  /** Sans interface : les agents la construisent et l'enregistrent. Avec interface : la commande ajoute ou retire un composant du tableau. */
  const submit = (raw: string) => {
    const text = raw.trim();
    if (!text || running || chatBusy) return;
    if (chatMode === 'ask') { toast.message('Mode Ask : lecture seule. Passe en mode Agent pour créer ou modifier une interface.'); return; }
    setPrompt('');
    if (!previewCode || !project) { void run(text, false, 'source'); return; }
    startEvolution(text, project.id);
  };

  const run = async (text: string, iterate: boolean, phase: 'source' | 'build' = 'build') => {
    if (!text.trim() || running) return;
    const pipe = iterate ? pipeRef.current : null; pipeRef.current = null;
    const steps: Array<{ label: string; ok?: boolean; detail?: string }> = [];
    const emitPipe = (status: string) => pipe?.({ status, steps: [...steps] });
    emitPipe('running');
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true); setError(null); setValidation(null); setPhases([]); setAppError(null);
    setToolEvents((list) => list.filter((t) => t.source === 'exécution' && iterate));
    codeBuf.current = ''; planBuf.current = ''; setStreamCode(''); setPlan(''); setDiffStep(0); setElapsed(undefined);
    setPlanStreaming(true); setAgentEvents([]);
    if (!iterate) { setPreviewCode(''); setBoard(null); setBoards([]); lastPreview.current = 0; }
    else setBoard(null);
    let savedProject: string | null = iterate ? project?.id ?? null : null;
    let savedNumber: number | null = null;
    let hold = false;
    const sourcing = agentMode && phase === 'source';
    try {
      await streamGenerate({ prompt: text, projectId: iterate ? project?.id : undefined, diffusing: agentMode ? false : diffusing, useTools: true, mode: agentMode ? 'agent' : 'direct', phase: sourcing ? 'source' : 'build', sourceBrief: phase === 'build' ? briefRef.current : undefined, datasets: !iterate && datasets.length ? datasets.map(({ name, rows }) => ({ name, rows })) : undefined }, (e) => {
        switch (e.type) {
          case 'phase': { const l = neutral(e.label); if (steps.at(-1)?.label !== l) { steps.forEach((x) => { if (x.ok === undefined) x.ok = true; }); steps.push({ label: l }); emitPipe('running'); } } setPhase(e.phase, e.label); if (e.phase === 'code' || e.phase === 'fix') { codeBuf.current = ''; setPlanStreaming(false); } break;
          case 'agent': setAgentEvents((l) => [...l, e]); break;
          case 'source': hold = true; briefRef.current = String(e.brief ?? ''); setOffer({ text: String(e.text ?? ''), canBuild: e.canBuild !== false, prompt: text }); steps.push({ label: 'sourcing', ok: true, detail: String(e.text ?? '').slice(0, 180) }); emitPipe('source'); break;
          case 'plan_delta': planBuf.current += e.text; scheduleFlush(); break;
          case 'plan_done': planBuf.current = e.plan; setPlan(e.plan); setPlanStreaming(false); break;
          case 'tool_call': setToolEvents((l) => [...l, { id: e.id, name: e.name, args: e.args, source: 'génération', status: 'en cours' }]); break;
          case 'tool_result': setToolEvents((l) => l.map((t) => (t.id === e.id ? { ...t, result: e.result, error: e.error, ms: e.ms, status: e.error ? 'erreur' : 'ok' } : t))); break;
          case 'code_delta': {
            codeBuf.current += e.text; scheduleFlush();
            const now = Date.now();
            if (now - lastPreview.current > 700) { lastPreview.current = now; setPreviewCode(codeBuf.current); }
            break;
          }
          case 'code_snapshot': codeBuf.current = e.text; setDiffStep(e.step); scheduleFlush(); break;
          case 'code_done': codeBuf.current = e.code; setStreamCode(e.code); setPreviewCode(e.code); setDraft(e.code); break;
          case 'validation': setValidation({ ok: e.ok, errors: e.errors, warnings: e.warnings, fixed: e.attempt > 1 }); break;
          case 'app_ready': toast.success(`Interface prête · ${e.tools?.length ?? 0} outils`); break;
          case 'app_warning': toast.warning(e.message); break;
          case 'saved': steps.forEach((x) => { if (x.ok === undefined) x.ok = true; }); steps.push({ label: `version v${e.number} enregistrée`, ok: true }); savedProject = e.projectId; savedNumber = e.number; if (!iterate) recordCreation(e.projectId, text); toast.success(`Version v${e.number} enregistrée`); break;
          case 'done': setPhases((l) => l.map((p) => ({ ...p, status: 'done' }))); setElapsed(e.ms); setPreviewCode(e.code); setDraft(e.code); setFiles(e.files ?? null); setCodeFile(e.files?.['src/App.tsx'] ? 'src/App.tsx' : '__html'); break;
          case 'error': steps.push({ label: 'échec', ok: false, detail: String(e.message).slice(0, 160) }); setError(e.message); toast.error(e.message); setPhases((l) => l.map((p) => (p.status === 'running' ? { ...p, status: 'error' } : p))); break;
        }
      }, ac.signal);
    } catch (err) {
      if (!ac.signal.aborted) { const message = (err as Error).message; setError(message); toast.error(message); setPhases((l) => l.map((p) => (p.status === 'running' ? { ...p, status: 'error' } : p))); }
      else setPhases((l) => l.map((p) => (p.status === 'running' ? { ...p, status: 'error', label: `${p.label} (annulé)` } : p)));
    } finally {
      steps.forEach((x) => { if (x.ok === undefined) x.ok = true; });
      emitPipe(hold ? 'source' : savedNumber ? 'done' : 'failed');
      setPlanStreaming(false);
      if (savedProject) {
        // L'aperçu est déjà affiché. On garde l'attente jusqu'à ce que le projet soit posé,
        // sinon le premier appel des cartes croit que le backend n'existe pas.
        bootingRef.current = true;
        try {
          const p = (await api.project(savedProject)) as Project;
          setProject(p); setVersionNo(savedNumber ?? p.versions.at(-1)?.number ?? null);
        } catch { bootingRef.current = false; }
      }
      setRunning(false);
      refreshProjects();
      if (!iterate) { setPrompt(''); setDatasets([]); }
    }
  };

  runRef.current = run;

  const saveDraft = async () => {
    if (!project) return;
    const r = await api.saveVersion(project.id, draft);
    setValidation(r.validation);
    toast.success(`Version v${r.number} enregistrée${r.validation?.ok ? '' : ' (avec erreurs de validation)'}`);
    await openProject(project.id, r.number);
    refreshProjects();
  };

  // Plein écran de l'aperçu : Fullscreen API sur le conteneur, repli en overlay fixe ; sortie par Échap ou le bouton.
  const previewBoxRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState<'off' | 'native' | 'overlay'>('off');
  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) setFullscreen((f) => (f === 'native' ? 'off' : f)); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen((f) => (f === 'overlay' ? 'off' : f)); };
    document.addEventListener('fullscreenchange', onChange); window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('fullscreenchange', onChange); window.removeEventListener('keydown', onKey); };
  }, []);
  const toggleFullscreen = async () => {
    if (fullscreen !== 'off') {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
      setFullscreen('off'); return;
    }
    const el = previewBoxRef.current;
    try {
      if (el?.requestFullscreen) { await el.requestFullscreen(); setFullscreen('native'); return; }
    } catch { /* refusé (iframe, navigateur) : repli overlay */ }
    setFullscreen('overlay');
  };
  // Panneau « Formule Agent » rétractable (droite) : état + largeur mémorisés, poignée grip, Ctrl/⌘ + « . »
  const [fa, setFa] = useState<PanelState>(() => parsePanel(typeof localStorage === 'undefined' ? null : localStorage.getItem(PANEL_KEY), window.innerWidth));
  const [faDrag, setFaDrag] = useState(false);
  const [faUnread, setFaUnread] = useState(false);
  const faDragStart = useRef(fa.width);
  const faFromClosed = useRef(false);
  const setFaOpen = useCallback((open: boolean) => setFa((s) => ({ ...s, open })), []);
  useEffect(() => { try { localStorage.setItem(PANEL_KEY, JSON.stringify(fa)); } catch { /* quota */ } if (fa.open) setFaUnread(false); }, [fa]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (isToggleShortcut(e)) { e.preventDefault(); setFa((s) => ({ ...s, open: !s.open })); } };
    const onResize = () => setFa((s) => ({ ...s, width: clampWidth(s.width, window.innerWidth) }));
    window.addEventListener('keydown', onKey); window.addEventListener('resize', onResize);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); };
  }, []);
  const faOpenRef = useRef(fa.open); faOpenRef.current = fa.open;
  // Pastille : message de l'agent ou étape (en cours / terminée) arrivé pendant que le panneau est replié
  const faSig = `${chatMsgs.length}:${chatMsgs.at(-1)?.role === 'pipeline' ? (chatMsgs.at(-1) as { status?: string }).status : ''}:${(chatMsgs.at(-1) as { text?: string } | undefined)?.text?.length ?? 0}:${crewSteps(agentEvents, running).steps.map((x) => x.status).join(',')}:${running}`;
  const faSigPrev = useRef(faSig);
  useEffect(() => { if (faSigPrev.current !== faSig) { faSigPrev.current = faSig; if (!faOpenRef.current) setFaUnread(true); } }, [faSig]);
  useEffect(() => { setFaUnread(false); faSigPrev.current = faSig; }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Le modèle / fournisseur n'est plus affiché dans le studio ; seul le mode démo (sans clé) est signalé.
  const isMock = config?.provider === 'mock';
  const codeShown = running ? streamCode : draft;
  const hasApp = !!previewCode;

  return (
    <TooltipProvider>
    <div className="flex h-full">
      <Sidebar projects={projects} currentId={project?.id ?? null} onOpen={(id) => openProject(id)} onNew={newApp}
        onDelete={async (id) => { await api.deleteProject(id); if (project?.id === id) newApp(); refreshProjects(); toast('App supprimée'); }} />

      <main className={`flex min-w-0 flex-1 gap-2 py-4 pl-4 ${fa.open ? 'pr-4' : 'pr-1'}`}>
        {/* Zone principale : uniquement l'écran de l'interface */}
        <Card className="relative flex min-w-0 flex-1 flex-col gap-0 overflow-hidden py-0">
          {(boards.length > 0 || board) && (
            <div className="flex gap-1 overflow-x-auto border-b px-2 py-1.5" data-testid="dashboard-tabs">
              {hasApp && <button type="button" className={`shrink-0 rounded-md px-2 py-1 text-xs ${board ? 'text-muted-foreground' : 'bg-accent text-foreground'}`} onClick={() => setBoard(null)}>Interface</button>}
              {boards.map((b) => (
                <button key={b.id} type="button" data-testid="dashboard-tab" onClick={() => setBoard({ id: b.id, spec: b.spec, sketch: false, pendingChartId: null })}
                  className={`max-w-48 shrink-0 truncate rounded-md px-2 py-1 text-xs ${board?.id === b.id ? 'bg-accent text-foreground' : 'text-muted-foreground'}`}>{b.title}</button>
              ))}
              {board && !boards.some((b) => b.id === board.id) && <span className="shrink-0 px-2 py-1 text-xs">{board.spec.title}</span>}
            </div>
          )}
          <div ref={previewBoxRef} data-testid="preview-box" data-fullscreen={fullscreen}
            className={fullscreen === 'overlay' ? 'fixed inset-0 z-50 bg-background' : 'relative min-h-0 flex-1 bg-background'}>
            {fullscreen !== 'off' && (
              <Button variant="secondary" size="sm" onClick={toggleFullscreen} aria-label="Quitter le plein écran" title="Quitter le plein écran (Échap)"
                className="absolute right-4 bottom-4 z-10 opacity-80 hover:opacity-100" data-testid="fullscreen-exit"><Minimize2 /><span>Quitter · Échap</span></Button>
            )}
            {board && <div className="absolute inset-0 overflow-hidden bg-background"><LiveDashboard spec={board.spec} building={running} pendingChartId={board.pendingChartId} /></div>}
            {hasApp && !board && <iframe ref={iframeRef} title="Aperçu de l'interface" sandbox={SANDBOX} srcDoc={withBridge(previewCode)}
              className={`absolute inset-0 h-full w-full bg-background ${faDrag ? 'pointer-events-none' : ''}`} data-testid="preview" />}
            {hasApp && fullscreen === 'off' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="secondary" size="icon-sm" onClick={toggleFullscreen} aria-label="Plein écran" data-testid="fullscreen"
                    className="absolute right-3 bottom-3 z-10 opacity-40 transition hover:opacity-100 focus-visible:opacity-100"><Maximize2 /></Button>
                </TooltipTrigger>
                <TooltipContent side="left">Plein écran</TooltipContent>
              </Tooltip>
            )}
            {!hasApp && !board && !running && (
              <div className="absolute inset-0 grid place-items-center p-8 text-center" data-testid="empty-state">
                <div>
                  <img src={logoUrl} alt="FORMULE" className="mx-auto mb-4 h-6 w-auto opacity-90" data-testid="empty-logo" />
                  <div className="text-sm text-muted-foreground">Décris l’interface. Les agents la construisent et l’enregistrent.</div>
                </div>
              </div>
            )}
            {running && !board && !/<body/i.test(previewCode) && (
              <div className="absolute inset-0 grid place-items-center bg-background text-sm text-muted-foreground">
                <div className="text-center"><Loader2 className="mx-auto mb-3 size-6 animate-spin" />L'interface se construit…</div>
              </div>
            )}
          </div>
          {appError && (
            <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-xs text-destructive" data-testid="app-error">
              <span className="min-w-0 flex-1">Erreur d'exécution dans l'interface{appError.panel ? ` (panneau « ${appError.panel} »)` : ''} : {appError.explained}</span>
              {hasApp && <Button size="xs" variant="outline" data-testid="ask-fix-studio" onClick={() => { sendOrder(fixOrder(appError)); setAppError(null); }}>Demander à Formule Agent de corriger</Button>}
            </div>
          )}
        </Card>

        <PanelGrip open={fa.open} unread={faUnread} busy={running || chatBusy}
          onDragStart={() => { faDragStart.current = fa.width; faFromClosed.current = !fa.open; setFaDrag(true); }}
          onDrag={(dx) => setFa((s) => dragResult(s, faDragStart.current, dx, window.innerWidth, faFromClosed.current))}
          onDragEnd={(moved) => { setFaDrag(false); if (!moved) setFa((s) => ({ ...s, open: !s.open })); }} />

        {/* Panneau unique « Formule Agent » : fil de l'interface, étapes neutres, composer en bas */}
        <div className={`flex min-h-0 shrink-0 flex-col overflow-hidden ${faDrag ? '' : 'transition-[width,opacity] duration-200 ease-out'} ${fa.open ? 'opacity-100' : '-ml-2 pointer-events-none opacity-0'}`}
          style={{ width: fa.open ? fa.width : 0 }} aria-hidden={!fa.open} data-testid="fa-wrap">
          <FormuleAgentPanel
            msgs={chatMsgs} busy={chatBusy} running={running} appTitle={project?.title}
            versionPicker={project && project.versions.length > 1 ? (
              <Select value={String(current?.number)} onValueChange={(v) => openProject(project.id, Number(v))}>
                <SelectTrigger size="sm" className="h-7 max-w-24 text-xs" data-testid="versions"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {project.versions.map((v) => (
                    <SelectItem key={v.number} value={String(v.number)}>v{v.number} · {v.prompt.slice(0, 40)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : current ? <Badge variant="outline" className="font-mono">v{current.number}</Badge> : null}
            events={agentEvents} showBuild={running} offer={offer} onOffer={(ok) => { const next = offer; setOffer(null); if (!next) return; if (!ok) { if (project) setChat(project.id, normalizeChat(loadChat(project.id)).map((m) => m.role === 'pipeline' && m.status === 'source' ? { ...m, status: 'rejected' } : m)); return; } void run(next.prompt, !!project, 'build'); }} buildTitle={running && board ? 'Construction du tableau' : project ? 'Mise à jour de l’interface' : 'Création de l’interface'}
            hint={chatEmptyReason({ hasProject: !!project, running, appError: null, capable: hasApp ? chatCapable : null })}
            commands={hasApp && !running ? chatShell.commands : []} voice={voiceState} confirm={hostedConfirm}
            mode={chatMode} onModeChange={setChatModeAndSync}
            onSend={submit}
            onVoice={(c) => { const v = voiceRef.current; if (!v) return; if (c === 'ptt-down') v.pttDown(); else if (c === 'ptt-up') v.pttUp(); else if (c === 'stop') v.stop(); else void v.setMode(v.state.mode === 'handsfree' ? 'off' : 'handsfree'); }}
            composer={
              <div className="@container/composer min-w-0 space-y-1.5" data-testid="composer">
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(prompt); } }}
                  placeholder={chatMode === 'ask' ? (hasApp ? 'Question sur l’interface ou les données…' : 'Ouvre une interface, ou passe en Agent pour en créer une…') : hasApp ? 'Ajoute ou retire un composant du tableau…' : 'Décris l’interface à construire…'}
                  rows={2}
                  className="max-h-40 min-h-12 resize-none border-0 bg-transparent px-1 py-1 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
                  data-testid="prompt"
                />
                {datasets.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5 px-1" data-testid="datasets">
                    <ShieldCheck className="size-3.5 text-emerald-400" /><span className="text-xs text-muted-foreground">Vos données (restent en local) :</span>
                    {datasets.map((d) => <Badge key={d.name} variant="secondary" className="gap-1"><FileSpreadsheet />{d.file} · {d.rows.length} lignes<button aria-label="Retirer" onClick={() => setDatasets((l) => l.filter((x) => x.name !== d.name))}><X className="size-3" /></button></Badge>)}
                  </div>
                )}
                {!hasApp && (
                  <div className="f1-fade-x flex min-w-0 flex-nowrap gap-2 overflow-x-auto px-1.5 pr-8 [scrollbar-width:none]" data-testid="suggestions">
                    {EXAMPLES.map((ex) => (
                      <Button key={ex.label} variant="outline" size="xs" className="shrink-0 text-muted-foreground" onClick={() => setPrompt(ex.prompt)} title={ex.prompt} data-testid="suggestion"><span>{ex.label}</span></Button>
                    ))}
                  </div>
                )}
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-1" data-testid="composer-toolbar">
                  <input ref={fileRef} type="file" accept=".csv,.json,.tsv,text/csv,application/json" multiple hidden data-testid="dataset-input" onChange={async (e) => {
                    for (const f of Array.from(e.target.files ?? [])) {
                      try { const d = await readDataset(f); setDatasets((l) => [...l.filter((x) => x.name !== d.name), d].slice(-3)); toast.success(`${d.file} : ${d.rows.length} lignes importées`); }
                      catch (err) { toast.error(`${f.name} : ${(err as Error).message}`); }
                    }
                    e.target.value = '';
                  }} />
                  <Tooltip>
                    <TooltipTrigger asChild><Button variant="outline" size="icon-xs" className="shrink-0" onClick={() => fileRef.current?.click()} aria-label="Mes données (CSV/JSON)" data-testid="import-data"><Upload /></Button></TooltipTrigger>
                    <TooltipContent>Mes données (CSV/JSON) : Formule Agent les analyse pour amorcer l'interface, tout reste sur cette machine</TooltipContent>
                  </Tooltip>
                  {isMock && <Badge variant="outline" className="shrink-0 border-zinc-700 text-zinc-300" data-testid="provider"><Brain /> Démo</Badge>}
                  <Button variant="outline" size="xs" onClick={() => setShowMcp(true)} data-testid="mcp-button" className="shrink-0 text-zinc-300" title={`Serveurs et outils MCP · ${mcpTools.length} outil${mcpTools.length > 1 ? 's' : ''}`} aria-label={`MCP · ${mcpTools.length} outils`}>
                    <Plug /><span>MCP · <span className="f1-num">{mcpTools.length}</span><span className="@max-[399px]/composer:hidden"> outil{mcpTools.length > 1 ? 's' : ''}</span></span>
                  </Button>
                  {running
                    ? <Button size="sm" variant="outline" className="f1-para f1-metal f1-keep-shadow ml-auto h-8 shrink-0 gap-1.5 px-3 text-[13px] font-medium" onClick={() => abortRef.current?.abort()} data-testid="stop"><Square /><span>Arrêter</span></Button>
                    : <Button size="sm" className="f1-para f1-metal f1-keep-shadow ml-auto h-8 shrink-0 gap-1.5 px-3 text-[13px] font-medium" onClick={() => submit(prompt)} disabled={!prompt.trim() || chatBusy} data-testid="generate">{hasApp ? <><Send /><span>Envoyer</span></> : <><Sparkles /><span>Générer</span></>}</Button>}
                </div>
              </div>
            }
          />
        </div>
      </main>

      <McpPanel open={showMcp} onOpenChange={setShowMcp} onChanged={refreshTools} />
      {pending && <ConfirmDialog tool={pending.tool} args={pending.args} origin={pending.origin} onAnswer={pending.resolve} />}
      <Toaster position="bottom-right" richColors />
    </div>
    </TooltipProvider>
  );
}
