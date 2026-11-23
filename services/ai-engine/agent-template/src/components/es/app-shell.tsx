/**
 * AppShell — layout imposé de chaque mini-app Everything Software :
 *   ┌──────────────────────────── DASHBOARD (≈ 72 %) ───────────────────────────┐┌── CHAT CONTREMAÎTRE (≈ 28 %) ──┐
 *   │ salle de contrôle sombre : jauges, tuiles KPI, barres, combos, courbes,   ││ ordres en langage naturel,     │
 *   │ tableau, heatmap… (shadcn Charts), rafraîchi en live + panneaux           ││ plan de chantier, étapes       │
 *   │ temporaires injectés par le contremaître                                  ││ repliables, confirmations      │
 *   └───────────────────────────────────────────────────────────────────────────┘└────────────────────────────────┘
 * Le chat est l'UNIQUE point d'entrée : opérations sur les données ET évolutions de l'app (déléguées à l'équipe).
 * Dans le studio (window.agent.hosted), le chat est affiché dans l'onglet « Chat app » du studio : le panneau est
 * masqué, le dashboard passe en pleine largeur et la logique (ask, actions, scènes, panneaux) reste ici.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';
import { Button } from '@/components/ui/button';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { cn } from '@/lib/utils';
import { Scene, customScenes, sceneExists, type SceneSpec } from './scenes';
import { ACTION_COMPONENTS, ActionView, ActionZone, type ActionEvent, type ActionSpec } from './actions';
import { ErrorBoundary } from './boundary';
export { ErrorBoundary } from './boundary';

type Task = { id: string; title: string; status: string; note?: string };
type Step = { id: string; tool: string; args?: unknown; ok?: boolean; result?: unknown; error?: string; ms?: number; kind: 'tool' | 'cli' | 'voice'; output?: string };
type Msg =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'agent'; text: string; steps: Step[]; plan?: Task[]; busy?: boolean; ms?: number }
  | { id: string; role: 'confirm'; tool: string; el?: HTMLElement }
  | { id: string; role: 'alert'; text: string }
  | { id: string; role: 'action'; actionId: string }
  | { id: string; role: 'pipeline'; title: string; status: string; steps: Array<{ label: string; ok?: boolean; detail?: string }> };
export type TempPanel = { id: string; type: 'bar' | 'hbar' | 'line' | 'table'; title: string; data: Array<Record<string, any>> };

const uid = () => Math.random().toString(36).slice(2, 10);
const ShellCtx = createContext<{ ask: (q: string) => void; busy: boolean }>({
  ask: (q: string) => {
    const fn = typeof window !== 'undefined' ? (window as any).__ES_ASK : null;
    if (typeof fn === 'function') fn(q);
  },
  busy: false,
});
/** Depuis le dashboard (même hors <AppShell>) : envoyer un ordre au contremaître. */
export const useShell = () => useContext(ShellCtx);

/** Rafraîchissement live (polling réglable) : const live = useLive(load, 15) */
export function useLive(load: () => unknown | Promise<unknown>, defaultEvery = 15) {
  const [every, setEvery] = useState(defaultEvery);
  const [syncAt, setSyncAt] = useState('');
  const [tick, setTick] = useState(0);
  const ref = useRef(load); ref.current = load;
  const run = useCallback(async () => { try { await ref.current(); setSyncAt(new Date().toLocaleTimeString('fr-FR')); setTick((t) => t + 1); } catch { /* affiché par l'app */ } }, []);
  useEffect(() => { run(); }, [run]);
  useEffect(() => { if (!every) return; const t = setInterval(run, every * 1000); return () => clearInterval(t); }, [run, every]);
  useEffect(() => (window.app ? window.app.onChange(() => run()) : undefined), [run]);
  return { every, setEvery, syncAt, tick, refresh: run };
}

/** Panneau « salle de contrôle ». `focus` = mis en avant par le contremaître. */
export function Panel({ title, subtitle, right, focus, className, children, id }: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode; focus?: boolean; className?: string; children: ReactNode; id?: string }) {
  return (
    <section id={id ? `panel-${id}` : undefined} data-panel={id} className={cn('relative flex min-w-0 flex-col rounded-lg es-panel p-3 transition-all', focus && 'es-panel-focus', className)}>
      <header className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0"><h3 className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] es-title">{title}</h3>{subtitle && <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>}</div>
        {right}
      </header>
      <div className="min-h-0 flex-1"><ErrorBoundary name={typeof title === 'string' ? title : id ?? 'panneau'}>{children}</ErrorBoundary></div>
    </section>
  );
}

/** Tuile KPI compacte avec variation et seuil. */
export function KpiTile({ label, value, delta, hint, alert }: { label: string; value: ReactNode; delta?: number; hint?: ReactNode; alert?: boolean }) {
  return (
    <div className={cn('es-panel rounded-lg px-3 py-2', alert && 'border-[var(--status-alert)]/70')}>
      <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="font-mono text-2xl font-semibold tabular-nums es-kpi">{value}</div>
      <div className="flex justify-between text-[11px]">
        {delta !== undefined ? <span className={delta < 0 ? 'text-red-700' : 'text-emerald-700'}>{delta > 0 ? '▲' : delta < 0 ? '▼' : '■'} {Math.abs(delta)} %</span> : <span />}
        {hint && <span className="text-muted-foreground">{hint}</span>}
      </div>
    </div>
  );
}

const tempCfg = { value: { label: 'Valeur', color: 'var(--chart-1)' } } satisfies ChartConfig;
function TempPanelView({ p, onClose }: { p: TempPanel; onClose: () => void }) {
  const data = p.data.slice(0, 40);
  return (
    <Panel id={p.id} focus title={`⚡ ${p.title}`} subtitle="panneau temporaire du contremaître" right={<button className="text-xs text-muted-foreground hover:text-foreground/80" onClick={onClose} aria-label="Fermer">✕</button>}>
      {p.type === 'table' ? (
        <table className="w-full text-xs"><tbody>{data.map((r, i) => <tr key={i} className="border-b border-border/60">{Object.values(r).map((v, j) => <td key={j} className="py-1 pr-2 font-mono">{String(v)}</td>)}</tr>)}</tbody></table>
      ) : p.type === 'line' ? (
        <ChartContainer config={tempCfg} className="h-[180px] w-full"><LineChart data={data}><CartesianGrid vertical={false} strokeOpacity={0.15} /><XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={16} /><YAxis width={40} tickLine={false} axisLine={false} /><ChartTooltip content={<ChartTooltipContent />} /><Line dataKey="value" stroke="var(--color-value)" strokeWidth={2} dot={false} /></LineChart></ChartContainer>
      ) : p.type === 'hbar' ? (
        <ChartContainer config={tempCfg} className="w-full" style={{ height: Math.max(120, data.length * 28) }}><BarChart data={data} layout="vertical" margin={{ left: 8 }}><XAxis type="number" hide /><YAxis type="category" dataKey="label" width={120} tickLine={false} axisLine={false} /><ChartTooltip content={<ChartTooltipContent />} /><Bar dataKey="value" fill="var(--color-value)" radius={4} /></BarChart></ChartContainer>
      ) : (
        <ChartContainer config={tempCfg} className="h-[180px] w-full"><BarChart data={data}><CartesianGrid vertical={false} strokeOpacity={0.15} /><XAxis dataKey="label" tickLine={false} axisLine={false} /><ChartTooltip content={<ChartTooltipContent />} /><Bar dataKey="value" fill="var(--color-value)" radius={4} /></BarChart></ChartContainer>
      )}
    </Panel>
  );
}

type VState = { enabled: boolean; connected: boolean; mode: 'off' | 'ptt' | 'handsfree'; listening: boolean; speaking: boolean; interim: string; level: number; out: number; error?: string };
const V0: VState = { enabled: false, connected: false, mode: 'off', listening: false, speaking: false, interim: '', level: 0, out: 0 };

/** Orbe vocal néon : pulse avec le niveau du micro (cyan) ou de la voix du contremaître (violet). */
function VoiceOrb({ v }: { v: VState }) {
  const lvl = v.speaking ? v.out : v.listening ? v.level : 0;
  const color = v.speaking ? '23,23,23' : v.listening ? '90,90,90' : '160,160,160';
  return (
    <span className="relative grid size-7 place-items-center" data-testid="voice-orb" data-state={v.speaking ? 'speaking' : v.listening ? 'listening' : 'idle'}>
      <span className="absolute inset-0 rounded-full transition-transform duration-75" style={{ transform: `scale(${1 + lvl * 0.9})`, background: `radial-gradient(circle, rgba(${color},0.55), rgba(${color},0) 70%)` }} />
      <span className={cn('relative size-3.5 rounded-full', (v.speaking || v.listening) && 'animate-pulse')} style={{ background: `rgb(${color})`, boxShadow: `0 0 ${6 + lvl * 18}px rgba(${color},0.9)` }} />
    </span>
  );
}
/** Mini visualiseur (barres) pendant l'écoute / la parole. */
function VoiceBars({ v }: { v: VState }) {
  const lvl = v.speaking ? v.out : v.level;
  return <div className="flex h-4 items-end gap-0.5" aria-hidden>{Array.from({ length: 16 }, (_, i) => <span key={i} className={cn('w-1 rounded-sm', v.speaking ? 'bg-neutral-900/80' : 'bg-neutral-400/80')} style={{ height: `${Math.max(12, Math.min(100, lvl * 100 * (0.5 + Math.abs(Math.sin(i * 1.7 + lvl * 9)))))}%` }} />)}</div>;
}

const STATUS: Record<string, string> = { todo: '○', doing: '◐', done: '●', failed: '✕', skipped: '–' };
const short = (v: unknown) => { try { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 900 ? s.slice(0, 900) + '…' : s; } catch { return String(v); } };

function Mount({ el }: { el?: HTMLElement }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (el && ref.current && !ref.current.contains(el)) ref.current.appendChild(el); }, [el]);
  return <div ref={ref}>{!el && <div className="rounded-md border border-amber-500/30 p-2 text-xs text-amber-700">Carte de confirmation (traitée)</div>}</div>;
}

export function AppShell({ title, subtitle, status, commands = [], onUi, context, alerts = [], agentName = 'Contremaître', children }: {
  title: string; subtitle?: ReactNode; status?: ReactNode; commands?: string[];
  /** Patch d'état envoyé par le contremaître (scénario, filtres, focus…) ; les « panel » sont gérés par l'AppShell. */
  onUi?: (patch: Record<string, any>) => void;
  /** État courant du dashboard, transmis à l'agent à chaque ordre. */
  context?: unknown;
  /** Alertes de surveillance courantes : chaque nouvelle alerte est signalée proactivement dans le chat. */
  alerts?: string[];
  agentName?: string; children: ReactNode;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const [temp, setTemp] = useState<TempPanel[]>([]);
  // Composants d'action (registre shadcn) affichés/masqués/préremplis par le contremaître
  const [actions, setActions] = useState<ActionSpec[]>([]);
  const actionsRef = useRef(actions); actionsRef.current = actions;
  // Scènes vivantes (PixiJS / three.js) rendues à la demande du contremaître
  const [scenes, setScenes] = useState<Array<SceneSpec & { id: string }>>([]);
  const applyScene = (a: Record<string, any>) => {
    const op = String(a.op ?? 'render');
    if (op === 'remove') { setScenes((l) => l.filter((x) => x.id !== a.id)); return; }
    if (op === 'update') { setScenes((l) => l.map((x) => (x.id === a.id ? { ...x, ...(a.data !== undefined ? { data: a.data } : {}), params: { ...x.params, ...(a.params ?? {}) }, ...(a.title ? { title: a.title } : {}) } : x))); return; }
    const sp = a.spec as SceneSpec & { id: string } | undefined;
    if (!sp?.id || (sp.kind !== 'pixi' && sp.kind !== 'three') || !sceneExists(sp.kind, String(sp.scene))) return;
    setScenes((l) => [...l.filter((x) => x.id !== sp.id), sp].slice(-4));
  };
  const scenesRef = useRef(scenes); scenesRef.current = scenes;
  const queue = useRef<Array<{ text: string; ev: ActionEvent }>>([]);
  const applyAction = (a: Record<string, any>) => {
    const op = String(a.op ?? 'render');
    if (op === 'remove') { setActions((l) => l.filter((x) => x.id !== a.id)); return; }
    if (op === 'update') { setActions((l) => l.map((x) => (x.id === a.id ? { ...x, props: { ...x.props, ...(a.props ?? {}) } } : x))); return; }
    const spec = a.spec as ActionSpec | undefined;
    if (!spec?.id || !(ACTION_COMPONENTS as readonly string[]).includes(spec.component)) return;
    // Chat hébergé par le studio : les composants « zone chat » s'affichent dans le dashboard (le fil le signale)
    const zone = (spec.zone === 'chat' && !window.agent?.hosted ? 'chat' : 'dashboard') as ActionSpec['zone'];
    setActions((l) => [...l.filter((x) => x.id !== spec.id), { ...spec, zone }].slice(-12));
    if (spec.zone === 'chat') setMsgs((l) => [...l.filter((m) => !(m.role === 'action' && m.actionId === spec.id)), { id: uid(), role: 'action', actionId: spec.id }]);
  };
  const endRef = useRef<HTMLDivElement>(null);
  const loaded = useRef(false);
  const seen = useRef(new Set<string>());
  const ctxRef = useRef(context); ctxRef.current = context;
  const onUiRef = useRef(onUi); onUiRef.current = onUi;
  const has = typeof window !== 'undefined' && !!window.agent;
  const hosted = has && !!window.agent?.hosted; // chat affiché par le studio (onglet « Chat app »)
  useEffect(() => { window.agent?.shell?.({ agentName, commands }); }, [agentName, commands.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  const [voice, setVoice] = useState<VState>(V0);
  const askRef = useRef<(t: string) => void>(() => {});
  // Boutons « Demander au contremaître de corriger » des error boundaries (panneaux, actions, scènes).
  useEffect(() => { (window as any).__ES_ASK = (t: string) => askRef.current(t); return () => { delete (window as any).__ES_ASK; }; }, []);
  useEffect(() => { // Voix Google (outil du contremaître) : ordres dictés → même chemin que le chat écrit
    const offV = window.agent?.onVoice?.((t) => askRef.current(t));
    const offS = window.agent?.onVoiceState?.((st) => setVoice(st as VState));
    window.agent?.voice?.('state');
    return () => { offV?.(); offS?.(); };
  }, []);

  useEffect(() => { // fil du chat conservé à travers les rechargements à chaud (nouvelle version)
    if (!window.agent?.transcript) { loaded.current = true; return; }
    window.agent.transcript().then((m) => { if (Array.isArray(m) && m.length) setMsgs(m as Msg[]); }).catch(() => {}).finally(() => { loaded.current = true; });
  }, []);
  useEffect(() => {
    if (loaded.current) window.agent?.saveTranscript?.(msgs.map((m) => (m.role === 'confirm' ? { id: m.id, role: 'confirm', tool: m.tool } : m.role === 'agent' ? { ...m, busy: false } : m)));
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [msgs]);
  useEffect(() => window.agent?.onPipeline?.((e) => setMsgs((l) => {
    const p = e as unknown as Extract<Msg, { role: 'pipeline' }>;
    const i = l.findIndex((x) => x.id === p.id);
    if (i < 0) return [...l, { ...p, role: 'pipeline' }];
    const c = [...l]; c[i] = { ...p, role: 'pipeline' }; return c;
  })), []);
  useEffect(() => { // surveillance continue : signalement proactif
    const fresh = alerts.filter((a) => !seen.current.has(a));
    fresh.forEach((a) => seen.current.add(a));
    if (fresh.length) setMsgs((l) => [...l, ...fresh.map((text) => ({ id: uid(), role: 'alert' as const, text }))]);
  }, [alerts.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchAgent = (id: string, f: (m: Extract<Msg, { role: 'agent' }>) => Partial<Extract<Msg, { role: 'agent' }>>) =>
    setMsgs((l) => l.map((m) => (m.id === id && m.role === 'agent' ? { ...m, ...f(m) } : m)));

  const ask = useCallback(async (text: string, ev?: ActionEvent) => {
    const t = text.trim();
    if (!t || busy || !window.agent) return;
    const id = uid(); const t0 = Date.now();
    setQ(''); setBusy(true);
    setMsgs((l) => [...l, { id: uid(), role: 'user', text: t }, { id, role: 'agent', text: '', steps: [], busy: true }]);
    try {
      const final = await window.agent.ask(t, {
        context: { ...(typeof ctxRef.current === 'object' && ctxRef.current ? ctxRef.current as object : { dashboard: ctxRef.current }), ...(ev ? { ui_event: ev } : {}), actions_affichees: actionsRef.current.map((a) => ({ id: a.id, component: a.component, zone: a.zone })), scenes_affichees: scenesRef.current.map((x) => ({ id: x.id, kind: x.kind, scene: x.scene })), scenes_sur_mesure_disponibles: customScenes() },
        onDelta: (d) => patchAgent(id, (m) => ({ text: m.text + d })),
        onUi: (patch) => {
          if (patch?.__action && typeof patch.__action === 'object') { applyAction(patch.__action as Record<string, any>); return; }
          if (patch?.__scene && typeof patch.__scene === 'object') { applyScene(patch.__scene as Record<string, any>); return; }
          if (patch?.panel && typeof patch.panel === 'object') {
            const p = patch.panel as Partial<TempPanel>;
            const tp: TempPanel = { id: `tmp-${uid()}`, type: (['bar', 'hbar', 'line', 'table'].includes(String(p.type)) ? p.type : 'bar') as TempPanel['type'], title: String(p.title ?? 'Résultat'), data: Array.isArray(p.data) ? p.data : [] };
            setTemp((l) => [tp, ...l].slice(0, 3));
          }
          onUiRef.current?.(patch);
        },
        onConfirm: (el, info) => setMsgs((l) => [...l, { id: uid(), role: 'confirm', tool: info.tool, el }]),
        onEvent: (e) => {
          if (e.type === 'plan') patchAgent(id, () => ({ plan: e.tasks }));
          else if (e.type === 'tool_call' && !['plan_tasks', 'update_task', 'set_dashboard'].includes(e.tool) && !/^voice_/.test(e.tool)) patchAgent(id, (m) => ({ steps: [...m.steps, { id: e.id, tool: e.tool, args: e.args, kind: 'tool' }] }));
          else if (e.type === 'tool_result') patchAgent(id, (m) => ({ steps: m.steps.map((s) => (s.id === e.id ? { ...s, ok: e.ok, result: e.result, error: e.error, ms: e.ms } : s)) }));
          else if (e.type === 'voice') patchAgent(id, (m) => ({ steps: [...m.steps, { id: uid(), tool: String(e.tool), ok: (e.result as { ok?: boolean })?.ok !== false, args: e.args, result: e.result, kind: 'voice' }] }));
          else if (e.type === 'cli') patchAgent(id, (m) => ({ steps: [...m.steps, { id: uid(), tool: e.command, ok: e.ok, output: e.output, kind: 'cli' }] }));
        },
      });
      patchAgent(id, (m) => ({ text: final || m.text, busy: false, ms: Date.now() - t0 }));
    } catch (e) {
      patchAgent(id, (m) => ({ text: `${m.text}\n⚠️ ${(e as Error).message}`, busy: false }));
    } finally { setBusy(false); }
  }, [busy]);
  // Interaction sur un composant d'action → événement envoyé au contremaître (file d'attente s'il travaille déjà)
  const onAction = useCallback((e: ActionEvent) => {
    const v = e.value === undefined ? '' : ` : ${typeof e.value === 'string' ? e.value : JSON.stringify(e.value)}`;
    const text = `⚡ ${e.label ?? e.id} · ${e.event}${v}`;
    if (busy) queue.current.push({ text, ev: e }); else void ask(text, e);
  }, [ask, busy]);
  useEffect(() => { if (!busy && queue.current.length) { const n = queue.current.shift()!; void ask(n.text, n.ev); } }, [busy, ask]);

  askRef.current = (t) => void ask(t);
  const shell = useMemo(() => ({ ask, busy }), [ask, busy]);
  return (
    <ShellCtx.Provider value={shell}>
      <div className={cn('control-room grid h-screen grid-cols-1 overflow-hidden bg-background text-foreground', !hosted && 'lg:grid-cols-[minmax(0,1fr)_minmax(320px,28%)]')}>
        {/* ---- Zone DASHBOARD ---- */}
        <main className="min-h-0 overflow-y-auto p-3 md:p-4" data-testid="dashboard">
          <header className="mb-3 flex flex-wrap items-center gap-3">
            <div className="mr-auto min-w-0">
              <h1 className="truncate text-lg font-semibold tracking-wide text-foreground">{title}</h1>
              {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
            </div>
            {status}
          </header>
          <ActionZone specs={actions.filter((a) => a.zone !== 'chat')} onEvent={onAction} />
              {scenes.length > 0 && <div className="mb-3 grid gap-3 xl:grid-cols-2">{scenes.map((sc) => (
                <Panel key={sc.id} id={sc.id} focus title={`✦ ${sc.title ?? sc.scene}`} subtitle={`${sc.kind === 'pixi' ? 'PixiJS' : 'three.js'} · ${sc.scene} · rendu vivant`} right={<button className="text-xs text-muted-foreground hover:text-foreground/80" onClick={() => setScenes((l) => l.filter((x) => x.id !== sc.id))} aria-label="Fermer">✕</button>}>
                  <Scene spec={sc} height={280} onEvent={(event, value) => onAction({ id: sc.id, component: 'Scene' as never, event, value, label: sc.title ?? sc.scene })} />
                </Panel>
              ))}</div>}
              {temp.length > 0 && <div className="mb-3 grid gap-3 md:grid-cols-2">{temp.map((p) => <TempPanelView key={p.id} p={p} onClose={() => setTemp((l) => l.filter((x) => x.id !== p.id))} />)}</div>}
          {children}
        </main>
        {/* ---- Zone CHAT contremaître (hors studio ; dans le studio : onglet « Chat app ») ---- */}
        {!hosted && <aside className="flex min-h-0 flex-col border-l border-border bg-card" data-testid="chat">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
            {voice.enabled ? <VoiceOrb v={voice} /> : <span className="grid size-7 place-items-center rounded-full bg-black/5 text-sm">🦺</span>}
            <div className="min-w-0"><div className="truncate text-sm font-semibold text-foreground">{agentName}</div><div className="text-[11px] text-muted-foreground">{voice.speaking ? '🔊 parle… (parle pour l’interrompre)' : voice.listening ? (voice.mode === 'handsfree' ? '🎙️ mains libres · dis « Jarvis, … »' : '🎙️ j’écoute…') : 'contremaître du pipeline · ordres, analyses, évolutions'}</div></div>
            <span className={cn('ml-auto size-2 rounded-full', busy ? 'animate-pulse bg-amber-400' : 'bg-emerald-400')} />
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-sm" data-testid="chat-log">
            {!msgs.length && <p className="text-xs text-muted-foreground">Donne un ordre en langage naturel : je décompose, je fais exécuter par les outils MCP, je contrôle et je te fais le compte rendu. Pour faire évoluer l’app, demande-le ici aussi.</p>}
            {msgs.map((m) => {
              if (m.role === 'user') return <div key={m.id} className="ml-6 rounded-lg bg-black/5 px-3 py-2 text-foreground">{m.text}</div>;
              if (m.role === 'confirm') return <Mount key={m.id} el={m.el} />;
              if (m.role === 'action') { const a = actions.find((x) => x.id === m.actionId); return a ? <div key={m.id} className="rounded-lg border border-border bg-black/5 p-2" data-testid="chat-action"><ActionView spec={a} onEvent={onAction} /></div> : null; }
              if (m.role === 'alert') return (
                <div key={m.id} className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs" data-testid="chat-alert">
                  <div className="font-semibold text-red-700">🚨 Surveillance : {m.text}</div>
                  <div className="mt-1 flex gap-1"><Button size="xs" variant="outline" disabled={busy} onClick={() => ask(`Analyse cette alerte : ${m.text}`)}>Analyser</Button><Button size="xs" variant="outline" disabled={busy} onClick={() => ask(`Envoie une alerte : ${m.text}`)}>Alerter</Button></div>
                </div>
              );
              if (m.role === 'pipeline') return (
                <details key={m.id} open={m.status === 'running'} className="rounded-lg border border-border bg-black/5 px-3 py-2 text-xs" data-testid="chat-pipeline">
                  <summary className="cursor-pointer font-semibold text-foreground/80">🛠️ {m.title} · {m.status === 'running' ? 'en cours…' : m.status === 'done' ? 'terminé' : 'échec'}</summary>
                  <ul className="mt-1 space-y-0.5">{m.steps.map((s, i) => <li key={i} className="font-mono text-[11px] text-foreground/80">{s.ok === false ? '✕' : s.ok ? '✓' : '·'} {s.label}{s.detail ? <span className="text-muted-foreground"> — {s.detail}</span> : null}</li>)}</ul>
                </details>
              );
              return (
                <div key={m.id} className="space-y-1.5 rounded-lg border border-border/60 bg-black/[0.03] px-3 py-2">
                  {m.plan && m.plan.length > 0 && (
                    <div className="rounded-md bg-muted p-2" data-testid="chat-plan">
                      <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Plan de chantier</div>
                      {m.plan.map((t) => <div key={t.id} className={cn('flex gap-1.5 text-xs', t.status === 'done' && 'text-emerald-700', t.status === 'failed' && 'text-red-700', t.status === 'doing' && 'text-amber-700')}><span className="font-mono">{STATUS[t.status] ?? '○'}</span><span>{t.title}{t.note ? <span className="text-muted-foreground"> — {t.note}</span> : null}</span></div>)}
                    </div>
                  )}
                  {m.steps.map((s) => (
                    <details key={s.id} className="text-xs" data-testid="chat-step">
                      <summary className="cursor-pointer text-foreground/80">{s.kind === 'cli' ? '🖥️' : s.kind === 'voice' ? '🔊' : '🔎'} {s.kind === 'tool' ? `appel ${s.tool}` : s.tool} {s.ok === undefined ? '…' : s.ok ? '✓' : '✕'}{s.ms ? <span className="text-muted-foreground"> · {s.ms} ms</span> : null}</summary>
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[10px] text-foreground/80">{s.kind === 'cli' ? s.output : s.kind === 'voice' ? `${short(s.args)}\n→ ${short(s.result)}` : `args ${short(s.args)}\n→ ${s.error ? `erreur : ${s.error}` : short(s.result)}`}</pre>
                    </details>
                  ))}
                  <div className="whitespace-pre-wrap text-foreground" data-testid="agent-answer">{m.text || (m.busy ? '…' : '')}</div>
                  {m.ms && <div className="text-[10px] text-muted-foreground">{(m.ms / 1000).toFixed(1)} s</div>}
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
          {(voice.listening || voice.speaking || voice.interim) && (
            <div className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-xs" data-testid="voice-live">
              <VoiceBars v={voice} />
              <span className="min-w-0 flex-1 truncate italic text-foreground">{voice.interim || (voice.speaking ? 'le contremaître parle…' : '…')}</span>
              {voice.speaking && <button className="text-muted-foreground hover:text-red-700" onClick={() => window.agent?.voice?.('stop')} aria-label="Couper la parole">■</button>}
            </div>
          )}
          {voice.error && <div className="px-3 py-1 text-[11px] text-amber-700" data-testid="voice-error">🎙️ {voice.error}</div>}
          {commands.length > 0 && <div className="flex flex-wrap gap-1 border-t border-border px-3 pt-2">{commands.slice(0, 6).map((c) => <button key={c} disabled={busy || !has} onClick={() => ask(c)} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-foreground/80 hover:bg-black/5 disabled:opacity-40">{c}</button>)}</div>}
          <form className="flex gap-2 p-3" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
            <textarea value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(q); } }} rows={2} placeholder={has ? 'Ordre au contremaître… (« simule +10 % de prix », « ajoute un panneau de marge »)' : 'Ouvre l’app dans le studio pour parler au contremaître'} disabled={!has} className="min-h-[44px] flex-1 resize-none rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-border" data-testid="agent-input" />
            {voice.enabled && (
              <div className="flex flex-col gap-1">
                <button type="button" title="Maintenir pour parler (ou barre Espace)" data-testid="voice-ptt"
                  onPointerDown={(e) => { e.preventDefault(); window.agent?.voice?.('ptt-down'); }} onPointerUp={() => window.agent?.voice?.('ptt-up')} onPointerLeave={() => voice.mode === 'ptt' && window.agent?.voice?.('ptt-up')}
                  className={cn('grid h-8 w-9 place-items-center rounded-md border text-sm', voice.listening && voice.mode === 'ptt' ? 'border-border bg-black/10 ' : 'border-border hover:bg-black/5')}>🎙️</button>
                <button type="button" title="Mains libres (« Jarvis, … »)" data-testid="voice-handsfree" onClick={() => window.agent?.voice?.('toggle')}
                  className={cn('rounded-md border px-1 text-[9px] uppercase tracking-wider', voice.mode === 'handsfree' ? 'border-border bg-black/5 text-foreground' : 'border-border text-muted-foreground')}>auto</button>
              </div>
            )}
            <Button type="submit" disabled={busy || !q.trim() || !has} data-testid="agent-send">{busy ? '…' : 'Envoyer'}</Button>
          </form>
        </aside>}
      </div>
      <Toaster position="bottom-right" richColors />
    </ShellCtx.Provider>
  );
}
