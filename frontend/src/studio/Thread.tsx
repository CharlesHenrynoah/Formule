import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, CircleAlert, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import type { ActionCard } from '../lib/api';
import { cn } from '../lib/utils';

export type Item =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'agent'; id: string; text: string; tone?: 'error' | 'muted' }
  | { kind: 'working'; id: string; text: string }
  | { kind: 'sourcing'; id: string; jobId: string; summary: Sourcing; decision: 'validé' | 'rejeté' | null }
  | { kind: 'build'; id: string; jobId: string; startedAt: number; endedAt: number | null; step: string | null; steps: string[]; logs: string[]; state: string }
  | { kind: 'card'; id: string; card: ActionCard; result?: string };

export interface Sourcing {
  sources: { server: string; tool: string; status: string; demo: boolean; rows: number | null; observedAt: string | null; coverage: { complete: boolean; pages: number; note?: string }; error: { kind: string; message: string } | null }[];
  requirements: { id: string; label: string; mandatory: boolean; status: string; reason: string | null }[];
  canApprove: boolean; demo: boolean;
}

const STEPS = ['Analyse des données', 'Conception', 'Construction', 'Vérification'];
const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—');

export function Thread(p: { items: Item[]; onApprove: (jobId: string, ok: boolean) => void; onCard: (c: ActionCard, ok: boolean) => void; commands: string[]; onCommand: (c: string) => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [p.items]);
  return (
    <div className="flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
      <div className="space-y-3">
        {p.items.length === 0 && <p className="pt-6 text-center text-sm text-faint">Formule Agent attend ta demande.</p>}
        {p.items.map((it) => {
          switch (it.kind) {
            case 'user': return <div key={it.id} className="ml-10 rounded-2xl bg-raised px-4 py-2.5 text-[14px] whitespace-pre-wrap">{it.text}</div>;
            case 'agent': return <AgentText key={it.id} text={it.text} tone={it.tone} />;
            case 'working': return <div key={it.id} className="flex items-center gap-2 text-sm text-mute"><span className="diamond pulse" />{it.text}</div>;
            case 'sourcing': return <SourcingCard key={it.id} it={it} onDecide={(ok) => p.onApprove(it.jobId, ok)} />;
            case 'build': return <BuildBlock key={it.id} it={it} />;
            case 'card': return <ActionCardView key={it.id} it={it} onDecide={(ok) => p.onCard(it.card, ok)} />;
          }
        })}
        <div ref={end} />
      </div>
      {p.commands.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {p.commands.map((c) => <button key={c} onClick={() => p.onCommand(c)} className="rounded-xl border border-edge px-2 py-1 text-xs text-mute hover:border-petrol/60 hover:text-ink">{c}</button>)}
        </div>
      )}
    </div>
  );
}

function AgentText({ text, tone }: { text: string; tone?: 'error' | 'muted' }) {
  return (
    <div className={cn('text-[14px] leading-relaxed', tone === 'error' ? 'text-danger' : tone === 'muted' ? 'text-mute' : 'text-ink')}>
      {text}
    </div>
  );
}

function SourcingCard({ it, onDecide }: { it: Extract<Item, { kind: 'sourcing' }>; onDecide: (ok: boolean) => void }) {
  const s = it.summary;
  const mand = s.requirements.filter((r) => r.mandatory);
  const ok = mand.filter((r) => r.status === 'covered').length;
  return (
    <div className="rounded-xl border border-edge bg-panel">
      <div className="border-b border-edge px-3 py-2"><span className="label-f text-ink">Ce que j’ai réellement lu</span></div>
      <div className="space-y-2 px-3 py-2.5 text-[13px]">
        {s.sources.map((x) => (
          <div key={x.tool} className="flex items-start gap-2">
            {x.status === 'error' ? <CircleAlert size={14} className="mt-0.5 shrink-0 text-danger" /> : <Check size={14} className="mt-0.5 shrink-0 text-petrol" />}
            <div className="min-w-0">
              <div><span className="text-ink">{x.server}</span> <span className="text-faint">·</span> <span className="num text-[12px] text-mute">{x.tool}</span>{x.demo && <span className="ml-1.5 text-[11px] text-warn">démo</span>}</div>
              <div className="text-[12px] text-mute">
                {x.status === 'error' ? `Échec : ${x.error?.message ?? x.error?.kind}` : <>{x.rows !== null ? <><span className="num">{x.rows}</span> lignes</> : 'objet'} · observé <span className="num">{hhmm(x.observedAt)}</span>{x.coverage.pages > 1 ? <> · <span className="num">{x.coverage.pages}</span> pages</> : null}{!x.coverage.complete && <span className="text-warn"> · {x.coverage.note}</span>}</>}
              </div>
            </div>
          </div>
        ))}
        <div className="border-t border-edge pt-2">
          <div className="label-f mb-1 text-faint">Exigences <span className="num normal-case tracking-normal">{ok}/{mand.length}</span></div>
          <ul className="space-y-0.5">
            {s.requirements.map((r) => (
              <li key={r.id} className="flex gap-2 text-[12.5px]">
                <span className={cn('mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full', r.status === 'covered' ? 'bg-petrol' : 'bg-danger')} />
                <span className={r.status === 'covered' ? 'text-ink' : 'text-mute'}>{r.label}{!r.mandatory && <span className="text-faint"> (facultatif)</span>}{r.status !== 'covered' && <span className="text-danger"> — {r.reason ?? 'manquant'}</span>}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-edge px-3 py-2">
        {it.decision ? <span className="text-sm text-mute">{it.decision === 'validé' ? 'Validé.' : 'Rejeté. Rien n’a été construit.'}</span> : (
          <>
            <Button variant="primary" size="sm" disabled={!s.canApprove} onClick={() => onDecide(true)} title={s.canApprove ? '' : 'Les lectures ne portent aucune mesure demandée'}>Valider</Button>
            <Button variant="ghost" size="sm" onClick={() => onDecide(false)}>Rejeter</Button>
            {s.canApprove && ok < mand.length && <span className="text-[12px] text-warn">Livraison partielle : {mand.length - ok} exigence(s) manquante(s).</span>}
          </>
        )}
      </div>
    </div>
  );
}

function BuildBlock({ it }: { it: Extract<Item, { kind: 'build' }> }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (it.endedAt) return; const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, [it.endedAt]);
  const secs = Math.round(((it.endedAt ?? now) - it.startedAt) / 1000);
  const idx = it.step ? STEPS.indexOf(it.step) : it.endedAt ? STEPS.length : 0;
  return (
    <div className="rounded-xl border border-edge bg-panel">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        {open ? <ChevronDown size={14} className="text-faint" /> : <ChevronRight size={14} className="text-faint" />}
        <span className="label-f text-ink">Création de l’interface</span>
        <span className="num ml-auto text-[12px] text-mute">{secs} s</span>
        {!it.endedAt && <span className="diamond pulse ml-1" />}
      </button>
      <ol className="flex flex-wrap gap-x-3 gap-y-1 border-t border-edge px-3 py-2 text-[12px]">
        {STEPS.map((s, i) => {
          const done = it.endedAt ? !['FAILED', 'CANCELLED', 'BLOCKED'].includes(it.state) || i < idx : i < idx;
          const active = !it.endedAt && i === idx;
          return <li key={s} className={cn('flex items-center gap-1.5 whitespace-nowrap', done ? 'text-ink' : active ? 'text-petrol' : 'text-faint')}><span className={cn('h-1.5 w-1.5 rounded-full', done ? 'bg-ink' : active ? 'bg-petrol' : 'bg-faint')} />{s}</li>;
        })}
      </ol>
      {open && <pre className="num max-h-56 overflow-y-auto whitespace-pre-wrap border-t border-edge px-3 py-2 text-[11px] leading-relaxed text-mute">{it.logs.join('\n') || '…'}</pre>}
    </div>
  );
}

function ActionCardView({ it, onDecide }: { it: Extract<Item, { kind: 'card' }>; onDecide: (ok: boolean) => void }) {
  const c = it.card;
  return (
    <div className={cn('rounded-xl border bg-panel', c.status === 'pending' ? 'border-petrol/70' : 'border-edge')}>
      <div className="border-b border-edge px-3 py-2"><span className="label-f text-ink">Action · {c.label}</span>{c.demo && <span className="ml-2 text-[11px] text-warn">source de démo</span>}</div>
      <div className="space-y-1 px-3 py-2 text-[13px]">
        <p className="text-mute">{c.effect}</p>
        <p className="text-[12px] text-faint">{c.server} · <span className="num">{c.tool}</span></p>
        <table className="num mt-1 text-[12px]"><tbody>{Object.entries(c.args).map(([k, v]) => <tr key={k}><td className="pr-3 text-faint">{k}</td><td className="text-ink">{JSON.stringify(v)}</td></tr>)}</tbody></table>
        {it.result && <p className={cn('pt-1 text-[12.5px]', c.status === 'done' ? 'text-petrol' : c.status === 'error' ? 'text-danger' : 'text-mute')}>{it.result}</p>}
      </div>
      {c.status === 'pending' && (
        <div className="flex gap-2 border-t border-edge px-3 py-2">
          <Button variant="primary" size="sm" onClick={() => onDecide(true)}><Check size={13} />Oui, exécuter</Button>
          <Button variant="ghost" size="sm" onClick={() => onDecide(false)}><X size={13} />Non</Button>
        </div>
      )}
      {c.status === 'running' && <div className="flex items-center gap-2 border-t border-edge px-3 py-2 text-sm text-mute"><span className="diamond pulse" />Exécution puis vérification…</div>}
    </div>
  );
}
