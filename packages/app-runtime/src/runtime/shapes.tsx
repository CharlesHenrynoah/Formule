import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, Scatter, ScatterChart, XAxis, YAxis, ZAxis, RadialBar, RadialBarChart, PolarAngleAxis, Area, AreaChart, Label, LabelList } from 'recharts';
import { groupAgg, histogram, scatter, daily, getCollection, getPath, toSeries, type ViewSpec } from '@formule/contracts/browser';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import type { QueryState } from './App';
import { Card, ErrorState } from './views';
import { fmtNum, fmtSmart } from './format';
import { rampColor } from './palette';

type V<K extends ViewSpec['kind']> = Extract<ViewSpec, { kind: K }>;
export const PALETTE = Array.from({ length: 12 }, (_, i) => `var(--chart-${i + 1})`);
const OTHER = 'var(--chart-other)';
const GAIN = '#34c77b'; // oklch(0.74 0.17 150)
const LOSS = '#ff5a5f'; // oklch(0.68 0.2 22)
const axis = { stroke: '#2c2c2c', tick: { fill: '#8a8a8a', fontSize: 10, fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif' }, tickLine: false };
const short = (s: string, n = 14) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Barres par catégorie. Les noms longs ou nombreux passent en barres horizontales shadcn : une ligne par libellé, valeur écrite à côté. */
export function BarsView({ view, q }: { view: V<'bars'>; q: QueryState }) {
  const b = view.bindings;
  const r = useMemo(() => (q.raw == null ? null : groupAgg(q.raw, { ...b, refTime: Date.parse(q.observedAt ?? q.syncedAt) })), [q, b]);
  if (q.status === 'error' || !r) return <Card id={view.id} title={view.title} q={q}><ErrorState q={q} /></Card>;
  const signed = r.groups.some((g) => g.value < 0);
  const horizontal = r.groups.length > 5 || r.groups.some((g) => g.label.length > 10);
  const data = r.groups.map((g, i) => ({ ...g, fill: signed ? (g.value >= 0 ? GAIN : LOSS) : PALETTE[i % 12] }));
  const metric = b.agg === 'count' ? 'Nombre' : b.agg === 'sum' ? `Total${b.unit ? ` (${b.unit})` : ''}` : `Moyenne${b.unit ? ` (${b.unit})` : ''}`;
  const config: ChartConfig = { value: { label: metric, color: 'var(--chart-1)' } };
  const axisW = Math.min(210, Math.max(88, ...data.map((d) => Math.min(d.label.length, 28) * 6.6)));
  const height = horizontal ? Math.max(200, data.length * 36 + 28) : 240;
  return (
    <Card id={view.id} title={view.title} q={q}>
      {data.length === 0 ? <p className="text-sm text-mute">Vide.</p> : (
        <div data-binding={view.id} data-first={r.groups[0] ? `${r.groups[0].label}=${r.groups[0].value}` : ''} className="min-w-0">
          <ChartContainer config={config} className="aspect-auto w-full min-w-0" style={{ height }}>
            <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={horizontal ? { left: 4, right: 64, top: 8, bottom: 4 } : { left: 0, right: 8, top: 16, bottom: 28 }}>
              <CartesianGrid horizontal={!horizontal} vertical={horizontal} stroke="#262626" />
              {horizontal ? (
                <>
                  <XAxis type="number" {...axis} tickFormatter={(v) => compact(Number(v))} />
                  <YAxis type="category" dataKey="label" {...axis} width={axisW} interval={0} tick={(p) => {
                    const full = String(p.payload?.value ?? '');
                    return (
                      <g transform={`translate(${Number(p.x ?? 0)},${Number(p.y ?? 0)})`}>
                        <title>{full}</title>
                        <text x={-6} y={0} dy={4} textAnchor="end" fill="#8a8a8a" fontSize={11}>{short(full, 28)}</text>
                      </g>
                    );
                  }} />
                </>
              ) : (
                <>
                  <XAxis dataKey="label" {...axis} interval={0} height={36} tickFormatter={(v) => short(String(v), 12)} />
                  <YAxis {...axis} width={52} tickFormatter={(v) => compact(Number(v))} />
                </>
              )}
              <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
              <Bar dataKey="value" radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} isAnimationActive animationDuration={700}>
                {data.map((d) => <Cell key={d.label} fill={d.fill} />)}
                <LabelList dataKey="value" position={horizontal ? 'right' : 'top'} formatter={(v) => fmtSmart(Number(v))} className="fill-mute" fontSize={10} />
              </Bar>
            </BarChart>
          </ChartContainer>
        </div>
      )}
      {r.others && (
        <p className="mt-2 break-words text-[11px] leading-relaxed text-mute">
          {r.others.label} : {fmtSmart(r.others.value)}{b.unit ? ` ${b.unit}` : ''}
          {r.others.members?.length ? ` — ${r.others.members.map((m) => `${m.label} ${fmtSmart(m.value)}`).join(' · ')}` : ''}. Hors du graphique, pour ne pas écraser l’échelle.
        </p>
      )}
      {r.skipped > 0 && <p className="mt-1 text-[11px] text-warn">{r.skipped} ligne(s) sans mesure exclue(s)</p>}
    </Card>
  );
}

/** Anneau de répartition (parts d'un total). */
export function DonutView({ view, q }: { view: V<'donut'>; q: QueryState }) {
  const b = view.bindings;
  const r = useMemo(() => (q.raw == null ? null : groupAgg(q.raw, { ...b, refTime: Date.parse(q.observedAt ?? q.syncedAt) })), [q, b]);
  if (q.status === 'error' || !r) return <Card id={view.id} title={view.title} q={q}><ErrorState q={q} /></Card>;
  const data = [...r.groups, ...(r.others ? [r.others] : [])].filter((g) => g.value > 0).map((g, i) => ({ ...g, fill: g.label.startsWith('Autres') ? OTHER : PALETTE[i % 12] }));
  const total = data.reduce((a, g) => a + g.value, 0);
  const config: ChartConfig = Object.fromEntries(data.map((d) => [d.label, { label: d.label, color: d.fill }]));
  return (
    <Card id={view.id} title={view.title} q={q}>
      {data.length === 0 ? <p className="text-sm text-mute">Vide.</p> : (
        <div data-binding={view.id} data-first={r.groups[0] ? `${r.groups[0].label}=${r.groups[0].value}` : ''} className="grid items-center gap-3">
          <ChartContainer config={config} className="mx-auto aspect-square h-[190px]">
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent nameKey="label" hideLabel />} />
              <Pie data={data} dataKey="value" nameKey="label" innerRadius={58} outerRadius={88} paddingAngle={2} strokeWidth={0} isAnimationActive animationDuration={800}>
                {data.map((d) => <Cell key={d.label} fill={d.fill} />)}
                <Label content={({ viewBox }) => {
                  const vb = viewBox as { cx?: number; cy?: number };
                  if (vb?.cx === undefined) return null;
                  return <text x={vb.cx} y={vb.cy} textAnchor="middle" dominantBaseline="middle"><tspan x={vb.cx} y={vb.cy} className="fill-ink text-xl" style={{ fontFamily: '-apple-system, BlinkMacSystemFont, system-ui, sans-serif' }}>{fmtSmart(total)}</tspan><tspan x={vb.cx} y={(vb.cy ?? 0) + 18} className="fill-mute text-[10px]">{b.agg === 'count' ? 'lignes' : b.unit ?? 'total'}</tspan></text>;
                }} />
              </Pie>
            </PieChart>
          </ChartContainer>
          <ul className="grid gap-1 text-xs">
            {data.map((d) => (
              <li key={d.label} className="flex items-start gap-2" title={`${d.label} : ${fmtSmart(d.value)}`}>
                <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ background: d.fill }} />
                <span className="min-w-0 flex-1 break-words">
                  {d.label}
                  {d.members?.length ? <span className="mt-0.5 block text-[10px] leading-relaxed text-mute">{d.members.map((m) => `${m.label} ${fmtSmart(m.value)}`).join(' · ')}</span> : null}
                </span>
                <span className="num shrink-0 text-mute">{fmtSmart(d.value)}{total ? ` · ${Math.round((d.value / total) * 1000) / 10} %` : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

/** Distribution d'une mesure (les valeurs absentes sont comptées à part, jamais comme zéro). */
export function HistogramView({ view, q }: { view: V<'histogram'>; q: QueryState }) {
  const b = view.bindings;
  const r = useMemo(() => (q.raw == null ? null : histogram(q.raw, b)), [q, b]);
  if (q.status === 'error' || !r) return <Card id={view.id} title={view.title} q={q}><ErrorState q={q} /></Card>;
  const data = r.bins.map((x) => ({ range: `${fmtNum(x.from)}–${fmtNum(x.to)}`, n: x.n }));
  return (
    <Card id={view.id} title={view.title} q={q}>
      <div data-binding={view.id} data-count={r.n}>
        <ChartContainer config={{ n: { label: 'Effectif', color: 'var(--chart-4)' } }} className="aspect-auto h-[220px] w-full min-w-0">
          <BarChart data={data} barCategoryGap={1} margin={{ left: 0, right: 8, top: 8, bottom: 4 }}>
            <defs><linearGradient id={`h-${view.id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--chart-4)" stopOpacity={0.95} /><stop offset="100%" stopColor="var(--chart-4)" stopOpacity={0.35} /></linearGradient></defs>
            <CartesianGrid vertical={false} stroke="#262626" />
            <XAxis dataKey="range" {...axis} interval="preserveStartEnd" minTickGap={32} angle={data.length > 6 ? -28 : 0} textAnchor={data.length > 6 ? 'end' : 'middle'} height={data.length > 6 ? 52 : 28} />
            <YAxis {...axis} width={36} allowDecimals={false} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
            <Bar dataKey="n" fill={`url(#h-${view.id})`} radius={[2, 2, 0, 0]} animationDuration={700} />
          </BarChart>
        </ChartContainer>
      </div>
      <p className="mt-2 num text-[11px] text-mute">n = {r.n} · min {fmtNum(r.min)} · médiane {fmtNum(r.median)} · max {fmtNum(r.max)}{b.unit ? ` ${b.unit}` : ''}{r.missing ? ` · ${r.missing} sans mesure` : ''}</p>
    </Card>
  );
}

/** Nuage de points entre deux mesures (corrélation visuelle, pas de causalité). */
export function ScatterView({ view, q }: { view: V<'scatter'>; q: QueryState }) {
  const b = view.bindings;
  const r = useMemo(() => (q.raw == null ? null : scatter(q.raw, b)), [q, b]);
  if (q.status === 'error' || !r) return <Card id={view.id} title={view.title} q={q}><ErrorState q={q} /></Card>;
  const cats = [...new Set(r.pts.map((p) => p.c ?? '—'))].slice(0, 8);
  const spread = (xs: number[]) => { const pos = xs.filter((v) => v > 0); return pos.length === xs.length && pos.length > 2 && Math.max(...pos) / Math.min(...pos) > 100; };
  const logX = spread(r.pts.map((p) => p.x)), logY = spread(r.pts.map((p) => p.y));
  const corr = pearson(r.pts.map((p) => p.x), r.pts.map((p) => p.y));
  const config: ChartConfig = Object.fromEntries(cats.map((c, i) => [c, { label: c, color: PALETTE[i % 12] }]));
  return (
    <Card id={view.id} title={view.title} q={q} extra={corr !== null ? <span className="num text-mute">r = {fmtNum(Math.round(corr * 100) / 100)}</span> : undefined}>
      <div data-binding={view.id} data-count={r.pts.length}>
        <ChartContainer config={config} className="aspect-auto h-[230px] w-full">
          <ScatterChart margin={{ left: 0, right: 12, top: 8, bottom: 8 }}>
            <CartesianGrid stroke="#262626" />
            <XAxis type="number" dataKey="x" name={b.xLabel} {...axis} tickFormatter={(v) => compact(v)} domain={['auto', 'auto']} scale={logX ? 'log' : 'auto'} />
            <YAxis type="number" dataKey="y" name={b.yLabel} {...axis} width={52} tickFormatter={(v) => compact(v)} domain={['auto', 'auto']} scale={logY ? 'log' : 'auto'} />
            <ZAxis range={[18, 18]} />
            <ChartTooltip cursor={{ strokeDasharray: '3 3', stroke: '#555' }} content={<ChartTooltipContent hideLabel />} />
            {cats.map((c, i) => <Scatter key={c} name={c} data={r.pts.filter((p) => (p.c ?? '—') === c)} fill={PALETTE[i % 12]} fillOpacity={0.75} animationDuration={700} />)}
          </ScatterChart>
        </ChartContainer>
      </div>
      <p className="mt-2 text-[11px] text-mute">{logX || logY ? `échelle logarithmique (${[logX && 'x', logY && 'y'].filter(Boolean).join(', ')}) · ` : ''}x : {b.xLabel}{b.xUnit ? ` (${b.xUnit})` : ''} · y : {b.yLabel}{b.yUnit ? ` (${b.yUnit})` : ''} · {r.pts.length} points{r.dropped ? ` · ${r.dropped} incomplets écartés` : ''}{cats.length > 1 ? ` · couleur : ${cats.join(', ')}` : ''}</p>
    </Card>
  );
}

/** Calendrier : une case par jour, couleur = valeur. Un jour sans mesure reste vide (pas zéro). */
export function HeatmapView({ view, q }: { view: V<'heatmap'>; q: QueryState }) {
  const b = view.bindings;
  const r = useMemo(() => (q.raw == null ? null : daily(q.raw, b)), [q, b]);
  if (q.status === 'error' || !r) return <Card id={view.id} title={view.title} q={q}><ErrorState q={q} /></Card>;
  const days = r.days.slice(-371);
  const vals = days.map((d) => d.v); const min = Math.min(...vals), max = Math.max(...vals);
  const byDay = new Map(days.map((d) => [d.day, d]));
  const start = days.length ? new Date(days[0].t) : new Date(); start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  const end = days.length ? days[days.length - 1].t : Date.now();
  const weeks: { day: string; t: number }[][] = [];
  for (let t = start.getTime(), i = 0; t <= end; t += 86_400_000, i++) { const w = Math.floor(i / 7); (weeks[w] ??= []).push({ day: new Date(t).toISOString().slice(0, 10), t }); }
  const cell = 11, gap = 2;
  const color = (v: number) => rampColor(max === min ? 0.6 : (v - min) / (max - min), 'var(--chart-1)');
  return (
    <Card id={view.id} title={view.title} q={q}>
      <div data-binding={view.id} data-count={r.days.length} className="overflow-x-auto">
        <svg width={weeks.length * (cell + gap) + 24} height={7 * (cell + gap) + 18} role="img" aria-label={`${view.title} : ${r.days.length} jours mesurés`}>
          {['L', '', 'M', '', 'V', '', 'D'].map((l, i) => <text key={i} x={0} y={i * (cell + gap) + cell} fontSize={9} fill="#8a8a8a">{l}</text>)}
          {weeks.map((w, wi) => w.map((d, di) => {
            const m = byDay.get(d.day);
            return <rect key={d.day} x={14 + wi * (cell + gap)} y={di * (cell + gap)} width={cell} height={cell} rx={2} fill={m ? color(m.v) : 'transparent'} stroke={m ? 'none' : '#2a2a2a'}>
              <title>{`${new Date(d.t).toLocaleDateString('fr-FR')} : ${m ? `${fmtNum(m.v)}${b.unit ? ` ${b.unit}` : ''}` : 'aucune mesure'}`}</title>
            </rect>;
          }))}
          {weeks.map((w, wi) => (new Date(w[0].t).getUTCDate() <= 7 ? <text key={`m${wi}`} x={14 + wi * (cell + gap)} y={7 * (cell + gap) + 12} fontSize={9} fill="#8a8a8a">{new Date(w[0].t).toLocaleDateString('fr-FR', { month: 'short' })}</text> : null))}
        </svg>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-mute">
        <span className="num">{fmtNum(min)}</span>
        <span className="h-2 w-28 rounded" style={{ background: `linear-gradient(90deg, ${rampColor(0, 'var(--chart-1)')}, var(--chart-1))` }} />
        <span className="num">{fmtNum(max)}{b.unit ? ` ${b.unit}` : ''}</span>
        <span>· {r.days.length} jours mesurés{days.length < r.days.length ? ' (12 derniers mois affichés)' : ''} · case vide = aucune mesure</span>
      </div>
    </Card>
  );
}

/** Jauge radiale pour un pourcentage. */
export function Gauge({ value }: { value: number }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <ChartContainer config={{ v: { label: '%', color: 'var(--chart-2)' } }} className="aspect-auto h-[72px] w-[120px]">
      <RadialBarChart data={[{ v }]} startAngle={180} endAngle={0} innerRadius={42} outerRadius={56} cy="90%">
        <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
        <RadialBar dataKey="v" background cornerRadius={6} fill="var(--chart-2)" animationDuration={900} />
      </RadialBarChart>
    </ChartContainer>
  );
}

/** Mini-courbe dans une carte KPI (tendance des 40 derniers points mesurés). */
export function Sparkline({ raw, spark }: { raw: unknown; spark: { collection: string; t: string; v: string } }) {
  const pts = useMemo(() => toSeries(getCollection(raw, spark.collection) ?? [], spark.t, spark.v, getPath).points.filter((p) => p.v !== null).slice(-40), [raw, spark]);
  if (pts.length < 3) return null;
  const id = `sp${Math.abs(hash(spark.v + spark.t))}`;
  return (
    <ChartContainer config={{ v: { label: 'valeur', color: 'var(--chart-1)' } }} className="mt-2 aspect-auto h-[42px] w-full">
      <AreaChart data={pts} margin={{ top: 2, bottom: 0, left: 0, right: 0 }}>
        <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.45} /><stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} /></linearGradient></defs>
        <Area dataKey="v" type="monotone" stroke="var(--chart-1)" strokeWidth={1.5} fill={`url(#${id})`} isAnimationActive animationDuration={700} connectNulls={false} />
      </AreaChart>
    </ChartContainer>
  );
}

function pearson(x: number[], y: number[]): number | null {
  const n = x.length; if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7);

/** Notation compacte pour les axes (12,9 Md, 633 k). */
function compact(v: number) { return new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 }).format(v); }
