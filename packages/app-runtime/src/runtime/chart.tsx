import { useEffect, useRef, useState } from 'react';
import type { Point } from '@formule/contracts/browser';
import { fmtDate, fmtNum } from './format';

export interface ChartSeries { name: string; points: Point[]; color: string; dashed?: boolean; area?: boolean; width?: number; animate?: boolean }
export interface ChartBand { name: string; low: Point[]; high: Point[]; color: string }
export interface ChartMarker { t: number; label: string }

/**
 * Graphique canvas à hauteur fixe. Une absence de mesure reste un trou (le tracé s'interrompt).
 * Bandes de scénario, repère « aujourd'hui », infobulle au survol, animation des séries de scénario.
 */
export function Chart({ series, bands = [], markers = [], height = 240, label, unit, animKey }: { series: ChartSeries[]; bands?: ChartBand[]; markers?: ChartMarker[]; height?: number; label: string; unit?: string | null; animKey?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const [progress, setProgress] = useState(1);
  const geo = useRef<{ x: (t: number) => number; t0: number; t1: number; pad: { l: number; r: number } } | null>(null);

  useEffect(() => {
    const el = wrap.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 640)); ro.observe(el); return () => ro.disconnect();
  }, []);
  // animation : le scénario se redessine progressivement à chaque changement d'hypothèse
  useEffect(() => {
    if (!series.some((s) => s.animate) || typeof requestAnimationFrame === 'undefined') return;
    let raf = 0; const start = performance.now();
    const step = (now: number) => { const p = Math.min(1, (now - start) / 450); setProgress(1 - (1 - p) ** 3); if (p < 1) raf = requestAnimationFrame(step); };
    setProgress(0); raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [animKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const c = ref.current; const ctx = c?.getContext?.('2d'); if (!c || !ctx) return;
    const dpr = window.devicePixelRatio || 1; c.width = w * dpr; c.height = height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, height);
    const all = [...series.flatMap((s) => s.points), ...bands.flatMap((b) => [...b.low, ...b.high])];
    const vals = all.map((p) => p.v).filter((v): v is number => v !== null);
    if (!all.length || !vals.length) return;
    const pad = { l: 56, r: 14, t: 14, b: 26 };
    const t0 = Math.min(...all.map((p) => p.t)), t1 = Math.max(...all.map((p) => p.t));
    let v0 = Math.min(...vals), v1 = Math.max(...vals); const span = v1 - v0 || Math.abs(v1) || 1; v0 -= span * 0.06; v1 += span * 0.06;
    const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (w - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - v0) / (v1 - v0)) * (height - pad.t - pad.b);
    geo.current = { x, t0, t1, pad };
    // grille
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif'; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = v0 + ((v1 - v0) * i) / 4; const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = '#262626'; ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
      ctx.fillStyle = '#8a8a8a'; ctx.fillText(fmtNum(Math.round(v * 100) / 100), 4, yy + 3);
    }
    let lastLabel = -Infinity;
    for (let i = 0; i <= 4; i++) {
      const t = t0 + ((t1 - t0) * i) / 4;
      const lx = Math.min(w - 46, Math.max(pad.l, x(t) - 14));
      if (lx - lastLabel < 46) continue;
      lastLabel = lx;
      ctx.fillStyle = '#8a8a8a';
      ctx.fillText(fmtDate(t), lx, height - 8);
    }
    const clipX = (s: { animate?: boolean }) => (s.animate && markers[0] ? x(markers[0].t) + (w - pad.r - x(markers[0].t)) * progress : w);
    // bandes (fourchette de scénario)
    for (const b of bands) {
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, markers[0] ? x(markers[0].t) + (w - pad.r - x(markers[0].t)) * progress : w, height); ctx.clip();
      const hi = b.high.filter((p) => p.v !== null), lo = b.low.filter((p) => p.v !== null);
      if (hi.length > 1) {
        const g = ctx.createLinearGradient(0, pad.t, 0, height - pad.b); g.addColorStop(0, b.color + '55'); g.addColorStop(1, b.color + '14');
        ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(x(hi[0].t), y(hi[0].v!));
        for (const p of hi) ctx.lineTo(x(p.t), y(p.v!));
        for (const p of [...lo].reverse()) ctx.lineTo(x(p.t), y(p.v!));
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }
    // séries
    for (const s of series) {
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, clipX(s), height); ctx.clip();
      const segs: Point[][] = []; let cur: Point[] = [];
      for (const p of s.points) { if (p.v === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(p); }
      if (cur.length) segs.push(cur);
      if (s.area) for (const seg of segs) {
        if (seg.length < 2) continue;
        const g = ctx.createLinearGradient(0, pad.t, 0, height - pad.b); g.addColorStop(0, s.color + '40'); g.addColorStop(1, s.color + '00');
        ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(x(seg[0].t), height - pad.b);
        for (const p of seg) ctx.lineTo(x(p.t), y(p.v!));
        ctx.lineTo(x(seg[seg.length - 1].t), height - pad.b); ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width ?? 1.75; ctx.setLineDash(s.dashed ? [6, 4] : []); ctx.lineJoin = 'round';
      for (const seg of segs) { ctx.beginPath(); seg.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.v!)) : ctx.moveTo(x(p.t), y(p.v!)))); ctx.stroke(); }
      ctx.setLineDash([]);
      if (s.points.length < 90) { ctx.fillStyle = s.color; for (const p of s.points) if (p.v !== null) { ctx.beginPath(); ctx.arc(x(p.t), y(p.v), 2, 0, Math.PI * 2); ctx.fill(); } }
      ctx.restore();
    }
    // repères
    for (const m of markers) {
      const xx = Math.round(x(m.t)) + 0.5;
      ctx.strokeStyle = '#ffffff66'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(xx, pad.t); ctx.lineTo(xx, height - pad.b); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#d0d0d0'; ctx.font = '500 10px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
      const lw = ctx.measureText(m.label).width;
      ctx.fillText(m.label, xx + 4 + lw > w - pad.r ? xx - 4 - lw : xx + 4, pad.t + 9);
    }
    // survol
    if (hover) {
      const xx = Math.round(x(hover.t)) + 0.5;
      ctx.strokeStyle = '#f5f5f555'; ctx.beginPath(); ctx.moveTo(xx, pad.t); ctx.lineTo(xx, height - pad.b); ctx.stroke();
      for (const s of series) { const p = nearest(s.points, hover.t); if (p && p.v !== null && Math.abs(x(p.t) - xx) < 6) { ctx.fillStyle = s.color; ctx.beginPath(); ctx.arc(x(p.t), y(p.v), 4, 0, Math.PI * 2); ctx.fill(); } }
    }
  }, [series, bands, markers, w, height, hover, progress]);

  const onMove = (e: React.MouseEvent) => {
    const g = geo.current; if (!g) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect(); const px = e.clientX - rect.left;
    const t = g.t0 + ((px - g.pad.l) / Math.max(1, w - g.pad.l - g.pad.r)) * (g.t1 - g.t0);
    const allT = series.flatMap((s) => s.points.map((p) => p.t));
    const tt = allT.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a), allT[0] ?? t);
    setHover({ x: px, t: tt });
  };
  const tip = hover ? [
    ...series.map((s) => ({ name: s.name, color: s.color, p: nearest(s.points, hover.t) })),
  ].filter((r) => r.p && r.p.t === hover.t) : [];

  return (
    <div ref={wrap} style={{ height }} className="relative w-full" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <canvas ref={ref} role="img" aria-label={label} style={{ width: '100%', height }} />
      {hover && tip.length > 0 && (
        <div className="pointer-events-none absolute top-2 z-10 min-w-36 rounded-xl border border-line bg-app/95 px-2.5 py-1.5 text-[11px] shadow-none" style={{ left: Math.min(Math.max(hover.x + 12, 0), w - 170) }}>
          <div className="num mb-1 text-mute">{new Date(hover.t).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
          {tip.map((r) => <div key={r.name} className="flex items-center justify-between gap-3"><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: r.color }} />{r.name}</span><span className="num">{r.p!.v === null ? 'trou' : `${fmtNum(r.p!.v)}${unit ? ` ${unit}` : ''}`}</span></div>)}
        </div>
      )}
    </div>
  );
}

function nearest(pts: Point[], t: number): Point | undefined {
  let best: Point | undefined; let d = Infinity;
  for (const p of pts) { const dd = Math.abs(p.t - t); if (dd < d) { d = dd; best = p; } }
  return best;
}
