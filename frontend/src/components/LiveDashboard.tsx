/**
 * Tableau vivant : les graphiques shadcn / recharts du studio.
 * Chaque carte interroge ses sources à l'ouverture. Un filtre ou un détail ne relance que les cartes concernées.
 */
import { useEffect, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '../api';
import type { ChartPlace, ChartSpec, DashboardSpec, Density } from '../lib/dashboard';

type Row = Record<string, string | number>;
const cfg = { value: { label: 'Valeur', color: 'var(--chart-1)' } } satisfies ChartConfig;
const fmt = (n: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(n);

function ChartCard({ chart, args, quiet, density }: { chart: ChartSpec; args: Record<string, unknown>; quiet: boolean; density: Density }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [drill, setDrill] = useState('__all');
  const key = JSON.stringify(args);
  useEffect(() => { setDrill('__all'); }, [chart.id, chart.tool, key]);
  const query = drill !== '__all' ? { ...args, [chart.x]: drill } : args;
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    if (quiet) return;
    let stop = false;
    setLoading(true); setErr(null);
    api.interpret({ tool: chart.tool, args: query, x: chart.x, y: chart.y })
      .then((r) => { if (!stop) setRows(r.rows ?? []); })
      .catch((e: Error) => { if (!stop) { setErr(e.message); setRows([]); } })
      .finally(() => { if (!stop) setLoading(false); });
    return () => { stop = true; };
  }, [chart.tool, chart.x, chart.y, queryKey, quiet]); // eslint-disable-line react-hooks/exhaustive-deps

  const data = rows ?? [];
  const labels = [...new Set(data.map((r) => String(r.label ?? r[chart.x] ?? '')).filter(Boolean))].slice(0, 12);
  const kpi = chart.type === 'kpi'
    ? (data.length <= 1 ? Number(data[0]?.value ?? 0) : data.reduce((s, r) => s + Number(r.value ?? 0), 0))
    : 0;

  return (
    <section className={`flex min-w-0 flex-col rounded-md border bg-card ${density === 'dense' ? 'p-2' : density === 'calme' ? 'p-5' : 'p-3'} ${chart.type === 'kpi' ? '' : density === 'dense' ? 'min-h-44' : density === 'calme' ? 'min-h-72' : 'min-h-64'}`} data-testid="dashboard-chart" data-chart={chart.id} data-place={chart.place ?? 'gaze'}>
      <header className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-[11px] font-semibold uppercase tracking-[0.14em]">{chart.title}</h3>
          <p className="truncate text-[11px] text-muted-foreground">{chart.tool.split('__').slice(1).join(' · ') || chart.tool}</p>
        </div>
        {chart.type !== 'kpi' && labels.length > 1 && (
          <Select value={drill} onValueChange={setDrill}>
            <SelectTrigger size="sm" className="h-7 max-w-36 text-xs" aria-label={`Détail de ${chart.title}`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">Tout</SelectItem>
              {labels.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </header>
      {quiet || (loading && !data.length) ? <Skeleton className="h-40 w-full" /> : err ? (
        <p className="text-xs text-destructive">{err}</p>
      ) : chart.type === 'kpi' ? (
        <div className={`font-mono font-semibold tabular-nums ${density === 'dense' ? 'text-2xl' : density === 'calme' ? 'text-5xl' : 'text-3xl'}`}>{data.length === 1 && data[0].label && !/^\d+$/.test(String(data[0].label)) && Number(data[0].value) === 0 ? String(data[0].label) : fmt(kpi)}</div>
      ) : chart.type === 'table' ? (
        <div className="max-h-56 overflow-auto">
          <table className="w-full text-xs">
            <tbody>
              {data.slice(0, 12).map((r, i) => (
                <tr key={i} className="border-b border-border/60">
                  {Object.entries(r).slice(0, 6).map(([k, v]) => <td key={k} className="py-1 pr-3 font-mono">{String(v)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {!data.length && <p className="text-xs text-muted-foreground">Aucune ligne.</p>}
        </div>
      ) : chart.type === 'pie' ? (
        <ChartContainer config={cfg} className={`${density === 'dense' ? 'h-40' : density === 'calme' ? 'h-64' : 'h-52'} w-full`}>
          <PieChart>
            <ChartTooltip content={<ChartTooltipContent />} />
            <Pie data={data} dataKey="value" nameKey="label" innerRadius={48} strokeWidth={2}>
              {data.map((_, i) => <Cell key={i} fill={`var(--chart-${(i % 5) + 1})`} />)}
            </Pie>
          </PieChart>
        </ChartContainer>
      ) : chart.type === 'line' ? (
        <ChartContainer config={cfg} className={`${density === 'dense' ? 'h-40' : density === 'calme' ? 'h-64' : 'h-52'} w-full`}>
          <LineChart data={data}><CartesianGrid vertical={false} strokeOpacity={0.15} /><XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={16} /><YAxis width={40} tickLine={false} axisLine={false} /><ChartTooltip content={<ChartTooltipContent />} /><Line dataKey="value" stroke="var(--color-value)" strokeWidth={2} dot={false} /></LineChart>
        </ChartContainer>
      ) : chart.type === 'area' ? (
        <ChartContainer config={cfg} className={`${density === 'dense' ? 'h-40' : density === 'calme' ? 'h-64' : 'h-52'} w-full`}>
          <AreaChart data={data}><CartesianGrid vertical={false} strokeOpacity={0.15} /><XAxis dataKey="label" tickLine={false} axisLine={false} /><YAxis width={40} tickLine={false} axisLine={false} /><ChartTooltip content={<ChartTooltipContent />} /><Area dataKey="value" stroke="var(--color-value)" fill="var(--color-value)" fillOpacity={0.2} /></AreaChart>
        </ChartContainer>
      ) : (
        <ChartContainer config={cfg} className={`${density === 'dense' ? 'h-40' : density === 'calme' ? 'h-64' : 'h-52'} w-full`}>
          <BarChart data={data}><CartesianGrid vertical={false} strokeOpacity={0.15} /><XAxis dataKey="label" tickLine={false} axisLine={false} /><ChartTooltip content={<ChartTooltipContent />} /><Bar dataKey="value" fill="var(--color-value)" radius={4} /></BarChart>
        </ChartContainer>
      )}
    </section>
  );
}

export function LiveDashboard({ spec, building, pendingChartId }: { spec: DashboardSpec; building: boolean; pendingChartId: string | null }) {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const filterKey = spec.filters.map((f) => f.id).join('|');
  useEffect(() => { setFilters({}); }, [spec.title, filterKey]);

  const withFilters = (chart: ChartSpec) => {
    const args = { ...chart.args };
    for (const f of spec.filters) {
      const v = filters[f.id];
      if (v && v !== '__all') args[f.arg] = v;
    }
    return args;
  };

  const density: Density = spec.density ?? (spec.charts.length <= 1 ? 'calme' : spec.charts.length <= 3 ? 'parle' : 'dense');
  const span = (place: ChartPlace | undefined, type: ChartSpec['type']) => {
    const p = place ?? (type === 'kpi' ? 'signal' : type === 'table' || type === 'area' ? 'voice' : 'gaze');
    if (density === 'calme') return '';
    if (density === 'parle') return p === 'voice' ? 'md:col-span-4' : 'md:col-span-2';
    return p === 'voice' ? 'col-span-2 md:col-span-6' : p === 'signal' ? 'col-span-1 md:col-span-2' : 'col-span-1 md:col-span-3';
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="live-dashboard" data-density={density}>
      <header className={`border-b ${density === 'dense' ? 'px-4 py-2' : density === 'calme' ? 'px-8 py-8' : 'px-5 py-4'}`}>
        <h2 className={`font-semibold tracking-tight ${density === 'dense' ? 'text-base' : density === 'calme' ? 'text-2xl' : 'text-lg'}`}>{spec.title || 'Tableau'}</h2>
        {spec.description && <p className={`mt-1 max-w-2xl text-muted-foreground ${density === 'dense' ? 'text-xs' : 'text-sm'}`}>{spec.description}</p>}
        {spec.filters.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {spec.filters.map((f) => (
              <Select key={f.id} value={filters[f.id] ?? '__all'} onValueChange={(v) => setFilters((s) => ({ ...s, [f.id]: v }))}>
                <SelectTrigger size="sm" className="h-8 w-40 text-xs" aria-label={f.label}><SelectValue placeholder={f.label} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">{f.label} · tout</SelectItem>
                  {f.options.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}
                </SelectContent>
              </Select>
            ))}
          </div>
        )}
      </header>
      <div className={`min-h-0 flex-1 overflow-auto ${density === 'dense' ? 'p-2' : density === 'calme' ? 'p-8' : 'p-4'}`}>
        {spec.charts.length === 0 ? (
          building ? (
            <div className={`grid ${density === 'dense' ? 'grid-cols-2 gap-2 md:grid-cols-6' : density === 'calme' ? 'mx-auto max-w-xl gap-6' : 'gap-3 md:grid-cols-4'}`}>
              <Skeleton className="h-20 md:col-span-2" /><Skeleton className={density === 'calme' ? 'h-72' : 'h-48 md:col-span-2'} /><Skeleton className="h-48 md:col-span-2" />
            </div>
          ) : <p className="max-w-xl text-sm text-muted-foreground">{spec.description || 'Aucun graphique.'}</p>
        ) : (
          <div className={density === 'calme' ? 'mx-auto grid max-w-2xl gap-8' : density === 'parle' ? 'grid grid-cols-1 gap-3 md:grid-cols-4' : 'grid grid-cols-2 gap-2 md:grid-cols-6'}>
            {spec.charts.map((c) => (
              <div key={c.id} className={span(c.place, c.type)}>
                <ChartCard chart={c} args={withFilters(c)} quiet={pendingChartId === c.id} density={density} />
              </div>
            ))}
          </div>
        )}
      </div>
      {building && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border bg-background/95 px-3 py-1 text-xs text-muted-foreground shadow-sm" data-testid="dashboard-capsule">
          Construction du tableau…
        </div>
      )}
    </div>
  );
}
