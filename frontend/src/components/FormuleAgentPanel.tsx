/**
 * Panneau unique « Formule Agent » : fil de conversation de l'interface ouverte (un fil par interface, historique conservé),
 * avancement de la construction en étapes neutres repliables, et composer en bas.
 * Présentation seulement : la crew et l'agent de l'app (logique, outils, confirmations) restent inchangés.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { AlertTriangle, Check, ChevronRight, Loader2, Mic, Play, Siren, Square, Terminal, Volume2, Wrench, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ChatMsg } from '../lib/appChat';
import { CONTINUE_ORDER, isPaused } from '../lib/source';
import { AGENT_NAME, crewSteps, neutral, type CrewStep } from '../lib/neutral';
import type { AgentEvent } from '../types';
import type { VoiceState } from '../voice/provider';
import { CHAT_MODES, type ChatMode } from '../lib/chatMode';

export type HostedConfirm = { callId: string; tool: string; args: unknown; answer: (ok: boolean) => void };

function Inline({ text }: { text: string }) {
  return <>{text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g).map((p, i) => p.startsWith('**') && p.endsWith('**') && p.length > 4 ? <strong key={i}>{p.slice(2, -2)}</strong> : p.startsWith('`') && p.endsWith('`') && p.length > 2 ? <code key={i} className="rounded bg-background/70 px-1 font-mono text-[12px]">{p.slice(1, -1)}</code> : p)}</>;
}
const short = (v: unknown) => { try { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 900 ? `${s.slice(0, 900)}…` : s; } catch { return String(v); } };

const Mark = ({ ok, running }: { ok?: boolean; running?: boolean }) => running
  ? <Loader2 className="size-3 shrink-0 animate-spin" />
  : ok === false ? <X className="size-3 shrink-0 text-destructive" /> : <Check className="size-3 shrink-0 text-muted-foreground" />;

/** Une étape neutre, repliée par défaut (détail technique masqué). */
function Step({ s }: { s: CrewStep }) {
  return (
    <details className="group text-xs" data-testid="fa-step">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-0.5 text-muted-foreground [&::-webkit-details-marker]:hidden">
        <Mark running={s.status === 'running'} ok={s.status !== 'failed'} />
        <span className={cn(s.status === 'running' && 'text-foreground')}>{s.name}</span>
        {s.details.length > 0 && <ChevronRight className="ml-auto size-3 transition group-open:rotate-90" />}
      </summary>
      {s.details.length > 0 && (
        <ul className="mt-0.5 mb-1 ml-4 max-h-40 space-y-0.5 overflow-auto border-l pl-2">
          {s.details.slice(-40).map((d, i) => <li key={i} className="flex gap-1 font-mono text-[10.5px] text-muted-foreground">{d.ok === false ? '✕' : d.ok ? '✓' : '·'} <span className="min-w-0 break-words">{d.text}</span></li>)}
        </ul>
      )}
    </details>
  );
}

type KanbanSnap = { todo?: string[]; doing?: string[]; done?: string[]; wip?: number; limit?: number };

function Kanban({ snap }: { snap: KanbanSnap }) {
  const col = (name: string, items: string[] = []) => (
    <div className="min-w-0">
      <div className="mb-1 truncate text-[10px] font-medium text-foreground">{name}</div>
      <div className="space-y-1">
        {items.length ? items.map((item) => <div key={item} className="truncate rounded-sm border bg-background px-1 py-0.5 text-foreground">{item}</div>) : <div className="text-muted-foreground">—</div>}
      </div>
    </div>
  );
  return (
    <div className="mb-2 grid grid-cols-3 gap-1.5 font-mono text-[10px]" data-testid="fa-kanban">
      {col('À faire', snap.todo)}
      {col(`En cours · ${snap.wip ?? 0}/${snap.limit ?? 2}`, snap.doing)}
      {col('Terminé', snap.done)}
    </div>
  );
}

/** Bloc « construction » : le flux, puis les étapes neutres. */
export function BuildSteps({ events, running, title }: { events: AgentEvent[]; running: boolean; title: string }) {
  const { steps, summary } = crewSteps(events, running);
  const kanban = [...events].reverse().find((event) => event.kind === 'kanban') as KanbanSnap | undefined;
  if (!steps.length && !kanban && !running) return null;
  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2" data-testid="fa-build">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium">{running ? <Loader2 className="size-3.5 animate-spin" /> : null}<span className="min-w-0 flex-1 truncate">{title}</span>
        {summary ? <span className="text-[10px] font-normal text-muted-foreground">{(summary.ms / 1000).toFixed(0)} s</span> : null}</div>
      {kanban ? <Kanban snap={kanban} /> : null}
      {steps.length ? steps.map((s) => <Step key={s.name} s={s} />) : <div className="text-xs text-muted-foreground">Préparation…</div>}
    </div>
  );
}

type Props = {
  msgs: ChatMsg[]; busy: boolean; running: boolean; appTitle?: string; versionPicker?: ReactNode;
  events: AgentEvent[]; buildTitle: string; showBuild: boolean;
  offer?: { text: string; canBuild: boolean } | null; onOffer?: (ok: boolean) => void;
  hint: string | null; commands: string[]; voice: VoiceState | null; confirm: HostedConfirm | null;
  mode: ChatMode; onModeChange: (m: ChatMode) => void;
  onSend: (text: string) => void; onVoice: (cmd: 'ptt-down' | 'ptt-up' | 'toggle' | 'stop') => void;
  composer: ReactNode;
};

export function FormuleAgentPanel({ msgs, busy, running, appTitle, versionPicker, events, buildTitle, showBuild, offer, onOffer, hint, commands, voice, confirm, mode, onModeChange, onSend, onVoice, composer }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs, busy, confirm, events.length]);
  const send = (t: string) => { if (!t.trim() || busy) return; onSend(t.trim()); };
  const v = voice?.enabled ? voice : null;
  const last = msgs[msgs.length - 1];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-card" data-testid="formule-agent">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2" data-testid="fa-header">
        <div className="min-w-[8.5rem] flex-1">
          <div className="whitespace-nowrap text-sm font-semibold leading-tight tracking-normal" data-testid="fa-title">{AGENT_NAME}</div>
          {(v?.speaking || v?.listening || appTitle) && <div className="truncate text-[11px] text-muted-foreground" data-testid="fa-subtitle">{v?.speaking ? '🔊 parle… (parle pour l’interrompre)' : v?.listening ? (v.mode === 'handsfree' ? '🎙️ mains libres · dis « Jarvis, … »' : '🎙️ j’écoute…') : appTitle}</div>}
        </div>
        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5" data-testid="fa-header-tools">
        <div className="flex shrink-0 rounded-md border border-border p-0.5" role="tablist" aria-label="Mode Ask ou Agent" data-testid="fa-mode">
          {CHAT_MODES.map((m) => (
            <button key={m.id} type="button" role="tab" aria-selected={mode === m.id} title={m.hint} disabled={busy || running}
              data-testid={`fa-mode-${m.id}`} data-active={mode === m.id || undefined}
              onClick={() => onModeChange(m.id)}
              className={cn('rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors disabled:opacity-50',
                mode === m.id ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>{m.label}</button>
          ))}
        </div>
        {v && (
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" size="icon-xs" variant={v.listening && v.mode === 'ptt' ? 'default' : 'ghost'} title="Maintenir pour parler" data-testid="app-chat-ptt"
              onPointerDown={(e) => { e.preventDefault(); onVoice('ptt-down'); }} onPointerUp={() => onVoice('ptt-up')} onPointerLeave={() => v.mode === 'ptt' && onVoice('ptt-up')}><Mic /></Button>
            <Button type="button" size="xs" variant={v.mode === 'handsfree' ? 'default' : 'ghost'} title="Mains libres (« Jarvis, … »)" onClick={() => onVoice('toggle')} className="h-6 px-1.5 text-[9px] uppercase">auto</Button>
          </div>
        )}
        {versionPicker}
        <span className={cn('size-2 shrink-0 rotate-45', busy || running ? 'animate-pulse bg-[var(--f1-accent)]' : 'bg-zinc-500')} data-testid="fa-status" />
        </div>
      </div>
      <div className="border-b px-3 py-1 text-[10px] text-muted-foreground" data-testid="fa-mode-hint">
        {mode === 'ask' ? 'Ask · lecture de l’interface et des données' : 'Agent · écriture, actions et évolutions'}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-sm" data-testid="fa-log">
        {!msgs.length && !showBuild && (
          <p className="text-xs text-muted-foreground" data-testid="fa-empty">{hint ?? 'Décris ce que tu veux voir : je crée l’interface, puis tu la fais évoluer ou tu l’interroges sur ses données, ici même.'}</p>
        )}
        {msgs.map((m) => {
          if (m.role === 'user') return <div key={m.id} className="ml-6 rounded-lg bg-primary/15 px-3 py-2">{m.text}</div>;
          if (m.role === 'confirm') return <div key={m.id} className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300">⚠ Confirmation : {m.tool}</div>;
          if (m.role === 'action') return <div key={m.id} className="rounded-md border border-zinc-700 bg-white/5 px-2 py-1 text-xs text-zinc-300" data-testid="app-chat-action">⚡ Action « {m.actionId} » affichée dans l’interface</div>;
          if (m.role === 'alert') return (
            <div key={m.id} className="rounded-lg border border-zinc-700 bg-white/5 px-3 py-2 text-xs" data-testid="app-chat-alert">
              <div className="flex items-center gap-1 font-semibold text-zinc-300"><Siren className="size-3.5" /> Surveillance : {neutral(m.text)}</div>
              <div className="mt-1 flex gap-1"><Button size="xs" variant="outline" disabled={busy} onClick={() => send(`Analyse cette alerte : ${m.text}`)}>Analyser</Button><Button size="xs" variant="outline" disabled={busy} onClick={() => send(`Envoie une alerte : ${m.text}`)}>Alerter</Button></div>
            </div>
          );
          if (m.role === 'pipeline') return (
            <details key={m.id} className="group rounded-lg border bg-muted/20 px-3 py-2 text-xs" data-testid="app-chat-pipeline">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium [&::-webkit-details-marker]:hidden">
                <Mark running={m.status === 'running'} ok={m.status !== 'failed'} />
                <span className="min-w-0 flex-1 truncate">{neutral(m.title)}</span>
                <span className="text-[10px] font-normal text-muted-foreground">{m.status === 'running' ? 'en cours' : m.status === 'done' ? 'terminé' : m.status === 'source' ? 'à valider' : m.status === 'rejected' ? 'rejeté' : 'échec'}</span>
                <ChevronRight className="size-3 transition group-open:rotate-90" />
              </summary>
              <ul className="mt-1 ml-4 space-y-0.5 border-l pl-2">{m.steps.map((s, i) => <li key={i} className="text-[11px] text-muted-foreground">{s.ok === false ? '✕' : s.ok ? '✓' : '·'} {neutral(s.label)}{s.detail ? <span className="opacity-70"> — {neutral(s.detail)}</span> : null}</li>)}</ul>
            </details>
          );
          return (
            <div key={m.id} className="space-y-1.5 rounded-lg border bg-muted/30 px-3 py-2">
              {m.plan && m.plan.length > 0 && (
                <details className="group text-xs">
                  <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3 transition group-open:rotate-90" />Plan · {m.plan.filter((t) => t.status === 'done').length}/{m.plan.length}</summary>
                  {m.plan.map((t) => <div key={t.id} className="ml-4 text-[11px] text-muted-foreground">{t.status === 'done' ? '✓' : t.status === 'failed' ? '✕' : t.status === 'doing' ? '…' : '·'} {neutral(t.title)}{t.note ? ` — ${neutral(t.note)}` : ''}</div>)}
                </details>
              )}
              {m.steps.length > 0 && (
                <details className="group text-xs" data-testid="app-chat-steps">
                  <summary className="flex cursor-pointer list-none items-center gap-1 text-muted-foreground [&::-webkit-details-marker]:hidden"><Wrench className="size-3" />{m.steps.length} action{m.steps.length > 1 ? 's' : ''}<ChevronRight className="size-3 transition group-open:rotate-90" /></summary>
                  {m.steps.map((s) => (
                    <details key={s.id} className="ml-4 text-xs" data-testid="app-chat-step">
                      <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground">
                        {s.kind === 'cli' ? <Terminal className="size-3" /> : s.kind === 'voice' ? <Volume2 className="size-3" /> : <Wrench className="size-3" />}
                        <span className="font-mono">{s.tool}</span> {s.ok === undefined ? '…' : s.ok ? '✓' : '✕'}{s.ms ? <span className="opacity-60"> · {s.ms} ms</span> : null}
                      </summary>
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background/70 p-2 font-mono text-[10px] text-muted-foreground">{s.kind === 'cli' ? s.output : s.kind === 'voice' ? `${short(s.args)}\n→ ${short(s.result)}` : `args ${short(s.args)}\n→ ${s.error ? `erreur : ${s.error}` : short(s.result)}`}</pre>
                    </details>
                  ))}
                </details>
              )}
              <div className="whitespace-pre-wrap" data-testid="app-chat-answer">{m.text ? <Inline text={neutral(m.text)} /> : busy && m === last ? <span className="animate-pulse">▍</span> : ''}</div>
              {m === last && !busy && isPaused(m.text) && (
                <Button size="xs" className="mt-1" onClick={() => send(CONTINUE_ORDER)} data-testid="app-chat-continue"><Play />Continuer</Button>
              )}
            </div>
          );
        })}
        {showBuild && <BuildSteps events={events} running={running} title={buildTitle} />}
        {offer && (
          <div className="rounded-lg border bg-muted/30 p-3 text-xs" data-testid="fa-source">
            <div className="whitespace-pre-wrap text-foreground">{offer.text}</div>
            <div className="mt-2 flex gap-2">
              <Button size="sm" className="flex-1" disabled={!offer.canBuild} title={offer.canBuild ? 'Construire avec ces lectures' : 'Ces lectures ne portent pas encore les mesures demandées'} onClick={() => onOffer?.(true)} data-testid="fa-source-yes">Valider</Button>
              <Button size="sm" variant="outline" className="flex-1" onClick={() => onOffer?.(false)} data-testid="fa-source-no">Rejeter</Button>
            </div>
          </div>
        )}
        {confirm && (
          <div className="rounded-lg border border-zinc-700 bg-white/5 p-3 text-xs" data-testid="app-chat-confirm">
            <div className="flex items-center gap-1 font-semibold text-zinc-300"><AlertTriangle className="size-3.5" /> Action à confirmer : {confirm.tool}</div>
            <pre className="my-2 max-h-28 overflow-auto whitespace-pre-wrap rounded bg-background/70 p-2 font-mono text-[10px]">{short(confirm.args)}</pre>
            <div className="flex gap-2"><Button size="sm" className="flex-1" onClick={() => confirm.answer(true)} data-testid="app-chat-confirm-yes">Oui, exécuter</Button><Button size="sm" variant="outline" className="flex-1" onClick={() => confirm.answer(false)}>Non</Button></div>
            {v && <div className="mt-1 text-[10px] text-muted-foreground">…ou réponds « oui » / « non » à la voix.</div>}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {v && (v.listening || v.speaking || v.interim) && (
        <div className="flex items-center gap-2 border-t px-3 py-1.5 text-xs" data-testid="app-chat-voice-live">
          <div className="flex h-4 items-end gap-0.5" aria-hidden>{Array.from({ length: 12 }, (_, i) => { const l = v.speaking ? v.out : v.level; return <span key={i} className={cn('w-1 rounded-sm', v.speaking ? 'bg-zinc-100/80' : 'bg-zinc-400/80')} style={{ height: `${Math.max(12, Math.min(100, l * 100 * (0.5 + Math.abs(Math.sin(i * 1.7 + l * 9)))))}%` }} />; })}</div>
          <span className="min-w-0 flex-1 truncate italic text-muted-foreground">{v.interim || (v.speaking ? 'Formule Agent parle…' : '…')}</span>
          {v.speaking && <Button size="icon-xs" variant="ghost" onClick={() => onVoice('stop')} aria-label="Couper la parole"><Square /></Button>}
        </div>
      )}
      {voice?.error && <div className="px-3 py-1 text-[11px] text-zinc-300">🎙️ {voice.error}</div>}
      {commands.length > 0 && <div className="flex flex-nowrap gap-1 overflow-x-auto border-t px-3 pt-2 [scrollbar-width:none]">{commands.slice(0, 6).map((c) => <button key={c} disabled={busy} onClick={() => send(c)} className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted disabled:opacity-40">{c}</button>)}</div>}
      <div className="flex items-end gap-1 border-t p-2" data-testid="fa-composer-slot">
        <div className="min-w-0 flex-1">{composer}</div>
      </div>
    </div>
  );
}
