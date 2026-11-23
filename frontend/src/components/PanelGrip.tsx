/** Poignée verticale du panneau Formule Agent : relief sobre (parallélépipède noir/gris), points de préhension,
 *  clic ou glisser vers la gauche = ouvrir ; ouvert = glisser pour redimensionner ; pastille si du neuf arrive replié. */
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

type Props = { open: boolean; unread: boolean; busy?: boolean; onDragStart: () => void; onDrag: (dx: number) => void; onDragEnd: (moved: boolean) => void };

export function PanelGrip({ open, unread, busy = false, onDragStart, onDrag, onDragEnd }: Props) {
  const start = useRef<{ x: number; moved: boolean } | null>(null);
  const { lit, mode } = useActivityLights(busy);
  return (
    <div role="separator" aria-orientation="vertical" aria-label={open ? 'Replier ou redimensionner Formule Agent' : 'Ouvrir Formule Agent'}
      title={open ? 'Clic : replier · glisser : redimensionner · Ctrl/⌘ + .' : 'Clic : ouvrir Formule Agent · Ctrl/⌘ + .'} tabIndex={0}
      data-testid="fa-grip" data-open={open}
      onPointerDown={(e) => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); start.current = { x: e.clientX, moved: false }; onDragStart(); }}
      onPointerMove={(e) => { const s = start.current; if (!s) return; const dx = e.clientX - s.x; if (Math.abs(dx) > CLICK_SLOP_PX) s.moved = true; if (s.moved) onDrag(dx); }}
      onPointerUp={() => { const s = start.current; start.current = null; onDragEnd(!!s?.moved); }}
      onPointerCancel={() => { start.current = null; onDragEnd(true); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDragStart(); onDragEnd(false); } }}
      className={cn('f1-keep-shadow group relative flex w-3 shrink-0 touch-none select-none items-center justify-center self-stretch rounded-md border border-zinc-700/80',
        'bg-gradient-to-r from-zinc-700 via-zinc-800 to-zinc-950 shadow-[inset_1px_0_0_rgba(255,255,255,0.12),inset_-1px_0_0_rgba(0,0,0,0.6)]',
        'transition-colors hover:from-zinc-600 hover:via-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-zinc-400', 'cursor-pointer')}>
      <span className="flex flex-col gap-1" aria-hidden data-testid="fa-grip-lights" data-state={mode} data-lit={lit}>
        {Array.from({ length: GRIP_DOTS }, (_, i) => {
          const on = i < lit;
          return <span key={i} className={cn('f1-round size-[4px] rounded-full transition-[background-color,box-shadow] duration-100', on ? (mode === 'reduced' ? 'animate-pulse' : '') : 'bg-zinc-500/70 shadow-[0_1px_0_rgba(0,0,0,0.6)] group-hover:bg-zinc-300')}
            style={on ? { backgroundColor: PETRONAS, boxShadow: `0 0 4px ${PETRONAS_GLOW}, 0 0 8px ${PETRONAS}99` } : undefined} data-on={on || undefined} />;
        })}
      </span>
      {unread && !open && <span className="f1-keep-shadow absolute top-2 left-1/2 size-2.5 -translate-x-1/2 rotate-45 border border-zinc-900 bg-white shadow-[0_0_8px_rgba(255,255,255,0.9)]" data-testid="fa-grip-dot" aria-label="Nouveau message" />}
    </div>
  );
}

export const GRIP_DOTS = 6;
/** En dessous de ce déplacement, c'est un clic (bascule) ; au-delà, un glisser (redimensionner / rouvrir). */
export const CLICK_SLOP_PX = 4;
export const PETRONAS = '#00A19C';
export const PETRONAS_GLOW = '#00D2BE';
export const LIGHT_STEP_MS = 140;

/** Séquence « feux de départ » : 0..6 points allumés un par un, maintien 2 pas, extinction 1 pas, puis reprise. */
export const lightsAt = (step: number) => { const k = step % (GRIP_DOTS + 3); return k <= GRIP_DOTS ? k : k <= GRIP_DOTS + 1 ? GRIP_DOTS : 0; };

/** Indicateur d'activité de la poignée : repos (gris), travail (séquence bouclée ; pulsation si mouvement réduit), fin (flash). */
function useActivityLights(busy: boolean): { lit: number; mode: 'idle' | 'working' | 'reduced' | 'flash' } {
  const [step, setStep] = useState(0);
  const [flash, setFlash] = useState(false);
  const was = useRef(busy);
  const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  useEffect(() => {
    if (!busy) return;
    setStep(1);
    if (reduced) return;
    const t = window.setInterval(() => setStep((n) => n + 1), LIGHT_STEP_MS);
    return () => window.clearInterval(t);
  }, [busy, reduced]);
  useEffect(() => {
    if (was.current && !busy) { setFlash(true); const t = window.setTimeout(() => setFlash(false), 450); was.current = busy; return () => window.clearTimeout(t); }
    was.current = busy;
  }, [busy]);
  if (busy) return reduced ? { lit: GRIP_DOTS, mode: 'reduced' } : { lit: lightsAt(step), mode: 'working' };
  if (flash) return { lit: GRIP_DOTS, mode: 'flash' };
  return { lit: 0, mode: 'idle' };
}
