import { useMemo, useState, type ReactNode } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts';
import { notify } from './bridge';
import {
  aggregate, filterRows, getCollection, getPath, rank, toSeries, detectGaps, simulateLinear, SERIES_COLORS, classifyValue,
  type ViewSpec, type Point,
} from '@formule/contracts/browser';
import type { QueryState } from './App';
import { STATE_LABEL, fmtDate, fmtNum, fmtSmart, fmtTime } from './format';
import { Chart } from './chart';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Gauge, Sparkline } from './shapes';
import { seriesColor } from './palette';

type V<K extends ViewSpec['kind']> = Extract<ViewSpec, { kind: K }>;
const refTime = (q: QueryState) => (q.observedAt ? Date.parse(q.observedAt) : Date.parse(q.syncedAt));

export function Card({ title, q, children, extra, id }: { title: string; q?: QueryState; children: ReactNode; extra?: ReactNode; id: string }) {
  const st = q?.status ?? 'ready';
  return (
    <article aria-labelledby={`t-${id}`} data-view={id} data-state={st} className="h-full rounded-2xl border border-line bg-card p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id={`t-${id}`} className="text-[13px] font-medium text-ink">{title}</h2>
        <div className="flex items-center gap-2 text-[11px]">
          {extra}
          {q?.coverageNote && /approximati/.test(q.coverageNote) && <span title={q.coverageNote} className="cursor-help rounded-full border border-line px-1.5 py-0.5 text-mute">≈ approx.</span>}
          {q && st !== 'ready' && <span className={`rounded-xl border px-1.5 py-0.5 ${st === 'error' ? 'border-white text-ink' : 'border-line text-mute'}`}>{STATE_LABEL[st]}</span>}
        </div>
      </div>
      {q?.status === 'stale' && <p className="mb-2 text-xs text-mute">Dernière donnée du {fmtTime(q.observedAt ?? q.syncedAt)} — actualisation en échec : {q.error}</p>}
      {q?.coverageNote && q.status === 'partial' && <p className="mb-2 text-xs text-mute">Couverture partielle : {q.coverageNote}</p>}
      {children}
      {q && <p className="mt-3 text-[11px] text-mute">Source {q.source}{q.demo ? ' (démo)' : ''} · observé {fmtTime(q.observedAt)}</p>}
    </article>
  );
}

export function ErrorState({ q }: { q: QueryState }) {
  return (
    <div className="text-sm">
      <p className="font-medium text-ink">Donnée indisponible — lecture impossible : {q.error ?? 'erreur inconnue'}.</p>
      <p className="mt-1 text-mute">Actualise, reconnecte la source, ou demande un diagnostic à Formule Agent.</p>
    </div>
  );
}

export function KpiView({ view, q }: { view: V<'kpi'>; q: QueryState }) {
  const b = view.bindings;
  const res = useMemo(() => {
    if (q.raw == null) return null;
    if (b.aggregate) return aggregate(q.raw, b.aggregate, b.unit, refTime(q));
    const cv = classifyValue(getPath(q.raw, b.value!), 'number');
    const unit = b.unitPath ? (getPath(q.raw, b.unitPath) as string) : b.unit;
    return { state: cv.state, value: cv.value as number | null, unit, reason: cv.reason, count: 1, skipped: 0 };
  }, [q, b]);
  if (q.status === 'error' || !res) return <Card id={view.id} title={view.title} q={q}><ErrorState q={q} /></Card>;
  const ok = res.state === 'available' || res.state === 'partial';
  if (b.aggregate?.agg === 'top') {
    const label = (res as { label?: string }).label;
    return (
      <Card id={view.id} title={view.title} q={q}>
        <span data-binding={view.id} data-value={label ?? ''} title={label} className="block break-all text-lg font-semibold leading-snug text-[var(--accent)]">{label ?? 'Donnée indisponible'}</span>
        {label && <p className="num mt-1 text-xs text-mute">{b.aggregate.measure?.split('.').pop()?.replace(/_/g, ' ')} : {fmtSmart(res.value)} · max sur {res.count} élément(s)</p>}
      </Card>
    );
  }
  return (
    <Card id={view.id} title={view.title} q={q}>
      <div className="flex min-w-0 items-baseline gap-2">
        <span data-binding={view.id} data-value={ok ? String(res.value) : ''} data-value-state={res.state} title={ok ? fmtNum(res.value) : undefined} className={`num truncate font-medium ${ok && fmtSmart(res.value).length > 8 ? 'text-2xl' : 'text-3xl'}`}>
          {ok ? fmtSmart(res.value) : res.state === 'empty' ? 'Vide' : res.state === 'inaccessible' || res.state === 'missing' ? 'Donnée indisponible' : STATE_LABEL[res.state] ?? '—'}
        </span>
        {ok && res.unit && <span className="num text-sm text-mute">{res.unit}</span>}
      </div>
      {ok && res.unit === '%' && res.value !== null && res.value >= 0 && res.value <= 100 && <Gauge value={res.value} />}
      {b.spark && q.raw != null && <Sparkline raw={q.raw} spark={b.spark} />}
      {!ok && res.reason && <p className="mt-1 text-xs text-mute">{res.reason}</p>}
      {res.state === 'partial' && <p className="mt-1 text-xs text-mute">{res.skipped} ligne(s) sans mesure exclue(s)</p>}
      {b.aggregate && ok && <p className="mt-1 text-[11px] text-mute">{res.count} ligne(s) agrégée(s)</p>}
    </Card>
  );
}

function Legend({ items }: { items: { name: string; color: string; dashed?: boolean }[] }) {
  return <div className="flex flex-wrap gap-3 text-[11px] text-mute">{items.map((i) => <span key={i.name} className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4" style={{ background: i.dashed ? `repeating-linear-gradient(90deg, ${i.color} 0 4px, transparent 4px 7px)` : i.color }} />{i.name}</span>)}</div>;
}

const timeAxis = { stroke: '#2c2c2c', tick: { fill: '#8a8a8a', fontSize: 10 }, tickLine: false, axisLine: false };
const peak = (points: Point[]) => {
  const vs = points.map((p) => p.v).filter((v): v is number => v !== null).map(Math.abs);
  return vs.length ? Math.max(...vs) : 0;
};

/** Courbe shadcn. Chaque date a sa place. Si les séries n’ont pas le même ordre de grandeur, chacune a sa propre échelle. */
function SeriesChart({ series }: { series: { name: string; points: Point[]; color: string; area?: boolean }[] }) {
  const peaks = series.map((s) => peak(s.points));
  const hi = Math.max(0, ...peaks);
  const lo = Math.min(...peaks.filter((p) => p > 0));
  const split = series.length > 1 && hi / (lo || 1) >= 6;
  const panels = split ? series.map((s) => [s]) : [series];
  return (
    <div className="space-y-3">
      {panels.map((panel) => <SeriesPanel key={panel.map((s) => s.name).join('|')} series={panel} height={split ? 150 : 260} />)}
    </div>
  );
}

function SeriesPanel({ series, height }: { series: { name: string; points: Point[]; color: string; area?: boolean }[]; height: number }) {
  const rows = useMemo(() => {
    const map = new Map<number, Record<string, number | string | null>>();
    const stamps = series.flatMap((s) => s.points.map((p) => p.t));
    const days = stamps.map((t) => fmtDate(t));
    const clash = days.length !== new Set(days).size;
    const lab = (t: number) => (clash ? new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : fmtDate(t));
    series.forEach((s, i) => {
      for (const p of s.points) {
        const row = map.get(p.t) ?? { t: p.t, label: lab(p.t) };
        row[`s${i}`] = p.v;
        map.set(p.t, row);
      }
    });
    return [...map.values()].sort((a, b) => Number(a.t) - Number(b.t));
  }, [series]);
  const config: ChartConfig = Object.fromEntries(series.map((s, i) => [`s${i}`, { label: s.name, color: s.color }]));
  return (
    <ChartContainer config={config} className="aspect-auto w-full min-w-0" style={{ height }}>
      <ComposedChart data={rows} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="#262626" />
        <XAxis dataKey="label" minTickGap={36} interval="preserveStartEnd" {...timeAxis} />
        <YAxis width={58} tickFormatter={(v) => fmtSmart(Number(v))} {...timeAxis} domain={['auto', 'auto']} />
        <ChartTooltip cursor={{ stroke: '#555', strokeDasharray: '3 3' }} content={<ChartTooltipContent />} />
        {series.map((s, i) => (s.area ? (
          <Area key={s.name} dataKey={`s${i}`} name={s.name} type="monotone" stroke={s.color} fill={s.color} fillOpacity={0.16} strokeWidth={2} connectNulls={false} dot={false} isAnimationActive animationDuration={700} />
        ) : (
          <Line key={s.name} dataKey={`s${i}`} name={s.name} type="monotone" stroke={s.color} strokeWidth={2} connectNulls={false} dot={false} isAnimationActive animationDuration={700} />
        )))}
      </ComposedChart>
    </ChartContainer>
  );
}

export function LineView({ view, q }: { view: V<'line'>; q: QueryState }) {
  const b = view.bindings;
  const data = useMemo(() => {
    const rows = q.raw == null ? undefined : getCollection(q.raw, b.collection);
    if (!rows) return null;
    return b.series.map((s, i) => { const r = toSeries(rows, b.t, s.path, getPath); return { name: `${s.label}${s.unit ? ` (${s.unit})` : ''}`, points: r.points, rejected: r.rejected, color: seriesColor(i), area: i === 0 }; });
  }, [q, b]);
  if (q.status === 'error' || !data) return <Card id={view.id} title={view.title} q={q}><ErrorState q={q} /></Card>;
  const n = data[0]?.points.length ?? 0;
  const gaps = data[0] ? detectGaps(data[0].points) : [];
  const nulls = data.reduce((a, s) => a + s.points.filter((p) => p.v === null).length, 0);
  return (
    <Card id={view.id} title={view.title} q={q} extra={<Legend items={data} />}>
      {n === 0 ? <p className="text-sm text-mute">Vide : aucun point sur la période.</p> : <SeriesChart series={data} />}
      <p data-binding={view.id} data-points={n} className="mt-2 text-[11px] text-mute">
        {n} points{gaps.length ? ` · ${gaps.length} interruption(s) de série non comblée(s)` : ''}{nulls ? ` · ${nulls} mesure(s) absente(s) laissée(s) en trou` : ''}{data.some((d) => d.rejected) ? ` · ${data[0].rejected} horodatage(s) invalide(s) écarté(s)` : ''}
      </p>
    </Card>
  );
}

export function TableView({ view, q, full }: { view: V<'table'>; q: QueryState; full?: boolean }) {
  const b = view.bindings;
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const [facet, setFacet] = useState<string | null>(null);
  const size = full ? 25 : 8;
  const allRows = useMemo(() => { const rows = q.raw == null ? undefined : getCollection(q.raw, b.collection); return rows ? filterRows(rows, b.where ?? [], Date.parse(q.observedAt ?? q.syncedAt)) : undefined; }, [q, b]);
  const facetOptions = useMemo(() => {
    if (!b.facets || !allRows) return [];
    if (b.facets.groups) return Object.keys(b.facets.groups).filter((g) => allRows.some((r) => b.facets!.groups![g].includes(String(getPath(r, b.facets!.path)))));
    return [...new Set(allRows.map((r) => getPath(r, b.facets!.path)).filter((x) => x !== null && x !== undefined && x !== '').map(String))].slice(0, 10);
  }, [allRows, b.facets]);
  const rows = useMemo(() => {
    if (!allRows || !facet || !b.facets) return allRows;
    return allRows.filter((r) => { const v = String(getPath(r, b.facets!.path)); return b.facets!.groups ? b.facets!.groups[facet]?.includes(v) : v === facet; });
  }, [allRows, facet, b.facets]);
  const view_ = useMemo(() => {
    if (!rows) return [];
    let r = rows.map((row) => b.columns.map((c) => getPath(row, c.path)));
    if (filter) { const f = filter.toLowerCase(); r = r.filter((cells) => cells.some((c) => String(c ?? '').toLowerCase().includes(f))); }
    if (sort) r = [...r].sort((x, y) => { const a = x[sort.col], bb = y[sort.col]; if (a == null) return 1; if (bb == null) return -1; return (a < bb ? -1 : a > bb ? 1 : 0) * sort.dir; });
    return r;
  }, [rows, filter, sort, b.columns]);
  if (q.status === 'error' || !rows) return <Card id={view.id} title={view.title} q={q}><ErrorState q={q} /></Card>;
  const pages = Math.max(1, Math.ceil(view_.length / size));
  const slice = view_.slice(page * size, page * size + size);
  const cell = (v: unknown, t: string, unit: string | null) => {
    if (v === null || v === undefined) return <span className="text-mute">—</span>;
    if (t === 'number') return typeof v === 'number' ? <span className="num">{fmtNum(v)}{unit ? <span className="text-mute"> {unit}</span> : null}</span> : <span className="underline decoration-dotted" title="valeur non numérique">{String(v)}</span>;
    if (t === 'time') return <span className="num">{fmtTime(String(v))}</span>;
    if (t === 'link' && typeof v === 'string' && /^https:\/\//.test(v)) return <button className="text-[var(--accent)] underline-offset-2 hover:underline" onClick={() => notify('formule:open-link', { url: v })}>Ouvrir ↗</button>;
    if (Array.isArray(v)) return <span className="text-mute">{v.slice(0, 4).join(', ')}{v.length > 4 ? '…' : ''}</span>;
    return String(v);
  };
  return (
    <Card id={view.id} title={view.title} q={q} extra={<input aria-label="Filtrer" placeholder="Filtrer…" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }} className="w-32 rounded-xl border border-line bg-app px-2 py-0.5 text-xs" />}>
      {facetOptions.length > 1 && (
        <div role="group" aria-label="Filtres" className="mb-3 flex flex-wrap gap-1.5">
          {[null, ...facetOptions].map((f) => <button key={f ?? 'tout'} onClick={() => { setFacet(f); setPage(0); }} className={`rounded-full border px-2.5 py-0.5 text-[11px] ${facet === f ? 'border-[var(--accent)] bg-[var(--accent)] text-black' : 'border-line text-mute hover:text-ink'}`}>{f ?? 'Tout'}</button>)}
        </div>
      )}
      {rows.length === 0 ? <p className="text-sm text-mute">{facet ? 'Aucun élément dans cette catégorie parmi les résultats reçus.' : 'Vide : la source n’a renvoyé aucune ligne.'}</p> : (
        <div className="overflow-x-auto">
          <table data-binding={view.id} data-rows={allRows?.length ?? 0} className="w-full text-left text-sm">
            <thead><tr>{b.columns.map((c, i) => (
              <th key={c.path} className="border-b border-line py-1.5 pr-3 font-normal">
                <button className="label hover:text-ink" onClick={() => setSort((s) => (s?.col === i ? { col: i, dir: (s.dir * -1) as 1 | -1 } : { col: i, dir: 1 }))}>{c.label}{sort?.col === i ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</button>
              </th>))}</tr></thead>
            <tbody>{slice.map((r, i) => <tr key={i} className="border-b border-line/50">{r.map((v, j) => <td key={j} className="py-1.5 pr-3">{cell(v, b.columns[j].type, b.columns[j].unit)}</td>)}</tr>)}</tbody>
          </table>
          <div className="mt-2 flex items-center justify-between text-[11px] text-mute">
            <span className="num">{view_.length} / {allRows?.length ?? 0} lignes</span>
            <span className="flex gap-1">
              <button disabled={page === 0} onClick={() => setPage(page - 1)} className="rounded-full border border-line px-2 disabled:opacity-40">‹</button>
              <span className="num px-1">{page + 1}/{pages}</span>
              <button disabled={page >= pages - 1} onClick={() => setPage(page + 1)} className="rounded-full border border-line px-2 disabled:opacity-40">›</button>
            </span>
          </div>
        </div>
      )}
    </Card>
  );
}

export function RankingView({ view, q }: { view: V<'ranking'>; q: QueryState }) {
  const b = view.bindings;
  const r = useMemo(() => (q.raw == null ? null : rank(q.raw, b)), [q, b]);
  if (q.status === 'error' || !r) return <Card id={view.id} title={view.title} q={q}><ErrorState q={q} /></Card>;
  const max = Math.max(...r.rows.map((x) => Math.abs(x.value)), 1);
  const partial = q.status === 'partial';
  return (
    <Card id={view.id} title={view.title} q={q}>
      <p className="mb-2 text-[11px] text-mute">Population : {b.population}{partial ? ' · top des résultats reçus' : ''}</p>
      {r.rows.length === 0 ? <p className="text-sm text-mute">Vide.</p> : (
        <ol data-binding={view.id} data-first={r.rows[0] ? `${r.rows[0].label}=${r.rows[0].value}` : ''} className="space-y-1.5">
          {r.rows.map((x, i) => (
            <li key={x.label + i} className="grid grid-cols-[1.5rem_1fr_auto] items-center gap-2 text-sm">
              <span className="num text-mute">{i + 1}</span>
              <span className="relative min-w-0 break-words" title={x.label}><span className="absolute inset-y-0 left-0 rounded-md opacity-30" style={{ width: `${(Math.abs(x.value) / max) * 100}%`, background: seriesColor(i) }} /><span className="relative px-1.5">{x.label}</span></span>
              <span className="num">{fmtNum(x.value)}{b.unit ? <span className="text-mute"> {b.unit}</span> : null}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

const WINDOWS = [{ id: 60, l: '60 pts' }, { id: 180, l: '180 pts' }, { id: 0, l: 'Tout' }];

/**
 * Simulation : réel et scénario visuellement séparés. Éventail pessimiste/central/optimiste,
 * repère « aujourd'hui », projection par période, hypothèses visibles. Aucun effet externe.
 */
export function SimulationView({ view, q }: { view: V<'simulation'>; q: QueryState }) {
  const b = view.bindings;
  const defaults = useMemo(() => ({ dispersion_pct: 2, ...Object.fromEntries(view.model.params.map((p) => [p.id, p.default])) }), [view.model.params]);
  const params = useMemo(() => (view.model.params.some((p) => p.id === 'dispersion_pct') ? view.model.params : [...view.model.params, { id: 'dispersion_pct', label: 'Fourchette ±', min: 0, max: 10, step: 0.5, default: 2, unit: '%' }]), [view.model.params]);
  const [p, setP] = useState<Record<string, number>>(defaults);
  const [win, setWin] = useState(60);
  const [presets, setPresets] = useState<{ name: string; values: Record<string, number> }[]>(() => {
    try { return JSON.parse(localStorage.getItem(`presets:${view.id}`) ?? '[]'); } catch { return []; }
  });
  const base = useMemo(() => { const rows = q.raw == null ? undefined : getCollection(q.raw, b.collection); return rows ? toSeries(rows, b.t, b.v, getPath).points : null; }, [q, b]);
  const sim = useMemo(() => {
    if (!base) return null;
    const h = p.horizon ?? 7, v = p.variation_pct ?? 0, d = p.dispersion_pct ?? 0;
    return { central: simulateLinear(base, { variation_pct: v, horizon: h }), low: simulateLinear(base, { variation_pct: v - d, horizon: h }), high: simulateLinear(base, { variation_pct: v + d, horizon: h }) };
  }, [base, p]);
  if (q.status === 'error' || !sim || !base) return <Card id={view.id} title={view.title} q={q}><ErrorState q={q} /></Card>;

  const c = sim.central; const last = [...base].reverse().find((x) => x.v !== null);
  const end = c.scenario[c.scenario.length - 1]; const lo = sim.low.scenario[sim.low.scenario.length - 1]; const hi = sim.high.scenario[sim.high.scenario.length - 1];
  const delta = last?.v && end?.v != null ? ((end.v - last.v) / Math.abs(last.v)) * 100 : null;
  const shown = win ? base.slice(-win) : base;
  const unit = b.unit ?? '';
  const savePreset = () => {
    const name = `Preset ${presets.length + 1}`; const next = [...presets, { name, values: p }]; setPresets(next);
    try { localStorage.setItem(`presets:${view.id}`, JSON.stringify(next)); } catch { /* stockage indisponible en sandbox */ }
  };
  const quick = [
    { l: 'Pessimiste', v: -Math.max(2, Math.abs(p.variation_pct ?? 0) || 3) },
    { l: 'Stable', v: 0 },
    { l: 'Optimiste', v: Math.max(2, Math.abs(p.variation_pct ?? 0) || 3) },
  ];
  const maxBar = Math.max(...c.scenario.slice(1).map((x) => Math.abs(x.v ?? 0)), 1);
  const animKey = `${p.variation_pct}|${p.horizon}|${p.dispersion_pct}|${win}`;

  return (
    <Card id={view.id} title={view.title} q={q} extra={<span className="rounded-full border border-white px-2 py-0.5 font-medium text-ink">Scénario</span>}>
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Dernière observation" value={last?.v ?? null} unit={unit} sub={last ? new Date(last.t).toLocaleDateString('fr-FR') : '—'} tone="real" />
        <Stat label="Fin d’horizon · central" value={end?.v ?? null} unit={unit} sub={delta === null ? '—' : `${delta >= 0 ? '▲' : '▼'} ${fmtNum(Math.round(delta * 10) / 10)} % vs observé`} tone={delta !== null && delta < 0 ? 'down' : 'up'} />
        <Stat label="Fourchette" value={null} text={`${fmtNum(lo?.v ?? null)} → ${fmtNum(hi?.v ?? null)}`} unit={unit} sub={`± ${p.dispersion_pct ?? 0} % par période`} tone="band" />
        <Stat label="Horizon" value={p.horizon ?? 7} unit="pér." sub={c.step ? `pas ≈ ${fmtDuration(c.step)}` : 'pas inconnu'} tone="neutral" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_280px]">
        <div>
          <div className="mb-2 flex items-center justify-between gap-2 text-[11px]">
            <div className="flex flex-wrap gap-3 text-mute">
              <LegendDot color={seriesColor(0)} l="Réel (observé)" /><LegendDot color={seriesColor(2)} l="Central" dashed /><LegendDot color={seriesColor(2)} l="Fourchette" band />
            </div>
            <div role="group" aria-label="Fenêtre" className="flex rounded-full border border-line p-0.5">
              {WINDOWS.map((x) => <button key={x.id} onClick={() => setWin(x.id)} className={`rounded-full px-2.5 py-0.5 ${win === x.id ? 'bg-white text-black' : 'text-mute'}`}>{x.l}</button>)}
            </div>
          </div>
          <Chart height={300} unit={unit} label="Réel et scénario" animKey={animKey}
            series={[
              { name: 'Réel', points: shown, color: seriesColor(0), area: true },
              { name: 'Central', points: c.scenario, color: seriesColor(2), dashed: true, width: 2.25, animate: true },
              { name: 'Pessimiste', points: sim.low.scenario, color: seriesColor(3), width: 1, animate: true },
              { name: 'Optimiste', points: sim.high.scenario, color: seriesColor(1), width: 1, animate: true },
            ]}
            bands={[{ name: 'Fourchette', low: sim.low.scenario, high: sim.high.scenario, color: seriesColor(2) }]}
            markers={last ? [{ t: last.t, label: 'Aujourd’hui · début du scénario' }] : []} />
          <div className="mt-3">
            <div className="label mb-1.5">Projection centrale par période</div>
            <div className="flex h-16 items-end gap-[3px]" aria-label="Projection par période">
              {c.scenario.slice(1).map((x, i) => (
                <div key={i} title={`Période ${i + 1} : ${fmtNum(x.v)} ${unit}`} className="group relative flex-1 rounded-t-md opacity-70 transition-all duration-500 hover:opacity-100" style={{ background: seriesColor(2), height: `${Math.max(4, (Math.abs(x.v ?? 0) / maxBar) * 100)}%` }}>
                  {c.scenario.length <= 16 && <span className="num absolute -top-4 left-1/2 hidden -translate-x-1/2 text-[9px] text-ink group-hover:block">{fmtNum(x.v)}</span>}
                </div>
              ))}
            </div>
          </div>
          <p data-binding={view.id} data-scenario-end={end ? String(end.v) : ''} className="mt-2 text-xs text-mute">
            Résultat de simulation, pas une observation. Les trous de la série réelle restent des trous.
          </p>
        </div>

        <div className="space-y-3 rounded-xl border border-line bg-app p-4">
          <div className="label text-ink">Hypothèses</div>
          <div className="grid grid-cols-3 gap-1">
            {quick.map((x) => <button key={x.l} onClick={() => setP({ ...p, variation_pct: x.v })} className={`rounded-full border px-1 py-1 text-[11px] ${p.variation_pct === x.v ? 'border-white bg-white text-black' : 'border-line text-mute hover:text-ink'}`}>{x.l}</button>)}
          </div>
          {params.map((x) => (
            <label key={x.id} className="block text-sm">
              <span className="label flex justify-between"><span>{x.label}</span><span className="num normal-case text-ink">{(p[x.id] ?? x.default) > 0 && x.id === 'variation_pct' ? '+' : ''}{p[x.id] ?? x.default} {x.unit}</span></span>
              <input type="range" min={x.min} max={x.max} step={x.step} value={p[x.id] ?? x.default} onChange={(e) => setP({ ...p, [x.id]: Number(e.target.value) })} className="mt-1 w-full" />
            </label>
          ))}
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => setP(defaults)} className="rounded-full border border-line px-2.5 py-1 text-xs hover:border-white">Réinitialiser</button>
            <button onClick={savePreset} className="rounded-full border border-line px-2.5 py-1 text-xs hover:border-white">Enregistrer le preset</button>
            {presets.map((x) => <button key={x.name} onClick={() => setP(x.values)} className="rounded-full border border-line px-2.5 py-1 text-xs">{x.name}</button>)}
          </div>
          <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-mute">{[...view.model.assumptions, ...c.assumptions, `fourchette : variation ± ${p.dispersion_pct ?? 0} % (plage d’hypothèses, pas une probabilité)`].map((a) => <li key={a}>{a}</li>)}</ul>
          <p className="text-[11px] text-mute">Aucun effet externe · calcul reproductible.</p>
        </div>
      </div>
    </Card>
  );
}

function Stat({ label, value, unit, sub, tone, text }: { label: string; value: number | null; unit: string; sub: string; tone: 'real' | 'up' | 'down' | 'band' | 'neutral'; text?: string }) {
  const color = { real: 'text-mute', up: 'text-ink', down: 'text-ink', band: 'text-mute', neutral: 'text-mute' }[tone];
  return (
    <div className="rounded-xl border border-line bg-app/60 px-3 py-2">
      <div className="label">{label}</div>
      <div className="mt-1 flex items-baseline gap-1"><span className="num text-xl text-ink">{text ?? fmtNum(value)}</span>{unit && <span className="num text-[11px] text-mute">{unit}</span>}</div>
      <div className={`num mt-0.5 text-[11px] ${color}`}>{sub}</div>
    </div>
  );
}
function LegendDot({ color, l, dashed, band }: { color: string; l: string; dashed?: boolean; band?: boolean }) {
  return <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-4 rounded-[2px]" style={band ? { background: color + '44' } : { background: dashed ? `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)` : color, height: 2 }} />{l}</span>;
}
function fmtDuration(ms: number) {
  const h = ms / 3_600_000; if (h < 36) return `${Math.round(h)} h`;
  const d = h / 24; if (d < 45) return `${Math.round(d)} j`;
  return `${Math.round(d / 30.4)} mois`;
}

export function NoteView({ view }: { view: V<'note'> }) {
  return <Card id={view.id} title={view.title}><p className={`text-sm whitespace-pre-line ${/indisponible/i.test(view.text) ? 'font-medium text-ink' : 'text-mute'}`}>{view.text}</p></Card>;
}
