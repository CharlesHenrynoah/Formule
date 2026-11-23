import { useEffect, useMemo, useRef, useState } from 'react';
import { AppShell, KpiTile, Panel, useLive, useShell } from '@/components/es/app-shell';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, PolarAngleAxis, RadialBar, RadialBarChart, ReferenceLine, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { Scene, registerScene } from '@/components/es/scenes';
import { conversionMachine } from '@/components/es/scene-examples/conversion-machine';

// Scène sur mesure (PixiJS, chargée à la demande) : le tunnel de conversion comme une machine — aussi pilotable par le contremaître.
registerScene('conversion-machine', 'pixi', conversionMachine);
function MachineScene({ stages, scenario }: { stages: Array<{ label: string; value: number }>; scenario: { price_change_pct: number; traffic_change_pct: number; elasticity: number } }) {
  const { ask } = useShell(); // dans l'AppShell : un clic sur une étape devient un ordre au contremaître
  return <Scene spec={{ kind: 'pixi', scene: 'conversion-machine', data: { stages }, params: { speed: 1.2, traffic_pct: scenario.traffic_change_pct, boost_stage: stages.length - 1, boost_pct: Math.round(scenario.price_change_pct * scenario.elasticity) } }}
    height={230} onEvent={(e, v) => { if (e === 'stage_click') ask(`Explique l’étape « ${(v as { label?: string }).label} » du tunnel et comment l’améliorer`); }} />;
}

type Kpi = { valeur: number; moyenne: number; variation_pct: number };
type Kpis = { date: string; kpis: Record<'commandes' | 'ca_eur' | 'conversion_pct' | 'prix_moyen', Kpi>; seuils: { commandes_min: number; conversion_min: number }; alertes: string[]; statut: string; vide?: boolean };
type Point = { date: string; commandes: number; ca_eur: number; conversion_pct: number; visiteurs: number; prix_moyen: number };
type Anomaly = { date: string; commandes: number; z: number; cause_probable: string };
type Sim = { serie: Array<{ date: string; ca_prevu: number; ca_scenario: number }>; ecart_ca_pct: number; variation_commandes_pct: number; total_ca_scenario: number; total_ca_prevu: number };
type Action = { id: string; action: string; statut: string; origine: string; createdAt: string };
type Scenario = { price_change_pct: number; traffic_change_pct: number; elasticity: number };
type Metric = 'commandes' | 'ca_eur' | 'conversion_pct' | 'visiteurs';

const fmt = (n: number) => `${n > 0 ? '+' : ''}${Math.round(n * 10) / 10} %`;
const eur = (n: number) => `${Math.round(n).toLocaleString('fr-FR')} €`;
const short = (d: string) => d.slice(5).split('-').reverse().join('/');
const DOW = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
const METRICS: Record<Metric, string> = { commandes: 'Commandes', ca_eur: 'CA €', conversion_pct: 'Conversion %', visiteurs: 'Visiteurs' };
const comboCfg = { commandes: { label: 'Commandes', color: 'var(--chart-2)' }, ca_eur: { label: 'CA €', color: 'var(--chart-1)' } } satisfies ChartConfig;
const lineCfg = { reel: { label: 'Réel', color: 'var(--chart-1)' }, prevision: { label: 'Prévision', color: 'var(--chart-5)' } } satisfies ChartConfig;
const simCfg = { ca_prevu: { label: 'Réel projeté', color: 'var(--chart-2)' }, ca_scenario: { label: 'Scénario', color: 'var(--chart-4)' }, mix: { label: 'Mix', color: 'var(--chart-1)' } } satisfies ChartConfig;
const dowCfg = { value: { label: 'Commandes moy.', color: 'var(--chart-3)' } } satisfies ChartConfig;
const gaugeCfg = { value: { label: 'Niveau', color: 'var(--chart-1)' } } satisfies ChartConfig;

function Gauge({ value, max, label, sub, alert }: { value: number; max: number; label: string; sub: string; alert?: boolean }) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return (
    <div className="relative">
      <ChartContainer config={gaugeCfg} className="mx-auto aspect-square h-[120px]">
        <RadialBarChart data={[{ value: pct, fill: alert ? 'var(--chart-4)' : 'var(--color-value)' }]} startAngle={210} endAngle={-30} innerRadius="72%" outerRadius="100%">
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar dataKey="value" background={{ fill: 'rgba(148,163,184,0.12)' }} cornerRadius={8} />
        </RadialBarChart>
      </ChartContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center"><span className="font-mono text-xl font-semibold text-cyan-100">{label}</span><span className="text-[10px] text-slate-400">{sub}</span></div>
    </div>
  );
}

function AnomalyChip({ a }: { a: Anomaly }) {
  const { ask, busy } = useShell();
  return <button disabled={busy} onClick={() => ask(`Pourquoi les ventes ont baissé le ${short(a.date)} ? Quel produit et est-il en stock ?`)} className="rounded border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 text-[11px] text-rose-200 hover:bg-rose-500/20">⚠ {short(a.date)} · {a.commandes} cmd · {a.cause_probable}</button>;
}

export default function App() {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [series, setSeries] = useState<Point[]>([]);
  const [forecast, setForecast] = useState<Array<{ date: string; commandes: number; ca_eur: number }>>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [actions, setActions] = useState<Action[]>([]);
  const [live, setLive] = useState<{ valeur_cumulee_jour: number; tendance: string } | null>(null);
  const [scenario, setScenario] = useState<Scenario>({ price_change_pct: 0, traffic_change_pct: 0, elasticity: -1.6 });
  const [xfade, setXfade] = useState(60);
  const [stages, setStages] = useState<Array<{ label: string; value: number }>>([]);
  useEffect(() => { window.mcp?.call('demo__get_funnel', {}).then((r: any) => setStages(r?.etapes ?? r?.data?.etapes ?? [])).catch(() => {}); }, []);
  const [metric, setMetric] = useState<Metric>('commandes');
  const [focus, setFocus] = useState<string>('');
  const [sim, setSim] = useState<Sim | null>(null);
  const simSeq = useRef(0);

  // ---- Monitoring live : source MCP → historique local → agrégats ----
  const load = async () => {
    if (!window.app || !window.mcp) return;
    try {
      const r = await window.mcp.call('demo__get_metrics', { source: 'ventes', days: 30 });
      await window.app.call('ingest_metrics', { points: r.points ?? [] });
      setLive(r.live ?? null);
      const [k, s, f, a, l] = await Promise.all([
        window.app.call('get_kpis', {}), window.app.call('get_series', { days: 30 }), window.app.call('forecast', { days: 7 }),
        window.app.call('detect_anomalies', {}), window.app.call('get_action_log', {}),
      ]);
      setKpis(k); setSeries(s.points ?? []); setForecast(f.previsions ?? []); setAnomalies(a.anomalies ?? []); setActions(l.actions ?? []);
    } catch (e) { toast.error(`Source : ${(e as Error).message}`); }
  };
  const liveCtl = useLive(load, 15);

  // ---- Simulation : recalcul instantané à chaque mouvement de slider ou ordre du contremaître ----
  useEffect(() => {
    if (!window.app || !series.length) return;
    const id = ++simSeq.current;
    const t = setTimeout(async () => {
      try { const r = await window.app!.call('simulate_scenario', { ...scenario, days: 14 }); if (id === simSeq.current) setSim(r); }
      catch (e) { toast.error((e as Error).message); }
    }, 90);
    return () => clearTimeout(t);
  }, [scenario, series.length, liveCtl.tick]);
  useEffect(() => { if (!focus) return; document.querySelector(`[data-panel="${focus}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); const t = setTimeout(() => setFocus(''), 6000); return () => clearTimeout(t); }, [focus]);

  // ---- Patchs d'état envoyés par le contremaître (chat) ----
  const onUi = (p: Record<string, any>) => {
    if (p.scenario) setScenario((s) => ({ ...s, ...p.scenario }));
    if (typeof p.crossfader === 'number') setXfade(p.crossfader);
    if (p.metric && p.metric in METRICS) setMetric(p.metric);
    if (typeof p.focus === 'string') setFocus(p.focus);
    if (p.seuil || p.refresh) liveCtl.refresh();
  };

  const combo = useMemo(() => series.map((p) => ({ date: short(p.date), commandes: p.commandes, ca_eur: p.ca_eur })), [series]);
  const multi = useMemo(() => [
    ...series.map((p) => ({ date: short(p.date), reel: p[metric] as number })),
    ...(metric === 'commandes' || metric === 'ca_eur' ? forecast.map((p) => ({ date: short(p.date), prevision: p[metric] })) : []),
  ], [series, forecast, metric]);
  const byDow = useMemo(() => DOW.map((label, d) => { const xs = series.filter((p) => new Date(p.date).getUTCDay() === d); return { label, value: xs.length ? Math.round(xs.reduce((a, p) => a + p.commandes, 0) / xs.length) : 0 }; }), [series]);
  const heat = useMemo(() => { const max = Math.max(1, ...series.map((p) => p.commandes)); return series.slice(-28).map((p) => ({ ...p, k: p.commandes / max })); }, [series]);
  const mix = useMemo(() => (sim?.serie ?? []).map((x) => ({ date: short(x.date), ca_prevu: x.ca_prevu, ca_scenario: x.ca_scenario, mix: Math.round(x.ca_prevu * (1 - xfade / 100) + x.ca_scenario * (xfade / 100)) })), [sim, xfade]);
  const k = kpis && !kpis.vide ? kpis : null;
  const alerts = [...(k?.alertes ?? []), ...anomalies.slice(-1).map((a) => `anomalie ${short(a.date)} : ${a.commandes} commandes (${a.cause_probable})`)];

  const status = (
    <div className="flex items-center gap-2 text-xs">
      <span className={`rounded-full px-2 py-0.5 font-semibold ${liveCtl.every ? 'bg-cyan-500/20 text-cyan-200' : 'bg-slate-500/20 text-slate-300'}`}><span className={liveCtl.every ? 'animate-pulse' : ''}>●</span> {liveCtl.every ? `LIVE ${liveCtl.every}s` : 'PAUSE'}</span>
      {[5, 15, 60, 0].map((s) => <button key={s} onClick={() => liveCtl.setEvery(s)} className={`rounded px-1.5 py-0.5 ${liveCtl.every === s ? 'bg-cyan-500/25 text-cyan-100' : 'text-slate-400 hover:text-cyan-200'}`}>{s ? `${s}s` : '⏸'}</button>)}
      <span className="text-slate-500">synchro {liveCtl.syncAt || '—'}</span>
    </div>
  );

  return (
    <AppShell
      title="Console ventes" subtitle="Monitoring live · simulation · actions — source MCP demo__get_metrics" status={status} agentName="Contremaître ventes"
      onUi={onUi} alerts={alerts} context={{ scenario, crossfader: xfade, metric, seuils: k?.seuils, derniere_anomalie: anomalies.at(-1)?.date }}
      commands={['Pourquoi les ventes ont baissé ? Quel produit, et est-il en stock ?', 'Simule +10 % de prix', 'Alerte si commandes < 100', 'Compare cette semaine et la semaine dernière', 'Envoie une alerte', 'Ajoute un panneau de marge par produit']}
    >
      <div className="grid gap-3">
        {/* Ligne 1 : tuiles + jauges */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6" data-panel="kpis">
          <KpiTile label="Commandes du jour" value={k?.kpis.commandes.valeur ?? '—'} delta={k?.kpis.commandes.variation_pct} hint={k ? `seuil ${k.seuils.commandes_min}` : ''} alert={!!k && k.kpis.commandes.valeur < k.seuils.commandes_min} />
          <KpiTile label="CA du jour" value={k ? eur(k.kpis.ca_eur.valeur) : '—'} delta={k?.kpis.ca_eur.variation_pct} hint="vs 7 j" />
          <KpiTile label="Prix moyen" value={k ? `${k.kpis.prix_moyen.valeur} €` : '—'} delta={k?.kpis.prix_moyen.variation_pct} />
          <KpiTile label="Live (cumul jour)" value={live?.valeur_cumulee_jour ?? '—'} hint={live?.tendance} />
          <Panel title="Conversion" className="p-2"><Gauge value={k?.kpis.conversion_pct.valeur ?? 0} max={(k?.seuils.conversion_min ?? 4.5) * 1.6} label={`${k?.kpis.conversion_pct.valeur ?? '—'} %`} sub={`seuil ${k?.seuils.conversion_min ?? '—'} %`} alert={!!k && k.kpis.conversion_pct.valeur < k.seuils.conversion_min} /></Panel>
          <Panel title="Objectif jour" className="p-2"><Gauge value={k?.kpis.commandes.valeur ?? 0} max={125} label={`${Math.round(((k?.kpis.commandes.valeur ?? 0) / 125) * 100)} %`} sub="125 commandes" /></Panel>
        </div>

        {/* Ligne 2 : combo barres + courbe, barres horizontales */}
        <div className="grid gap-3 xl:grid-cols-[2fr_1fr]">
          <Panel id="combo" focus={focus === 'combo'} title="Commandes & CA · 30 jours" subtitle="barres = commandes · courbe = CA" right={<div className="flex flex-wrap justify-end gap-1">{anomalies.map((a) => <AnomalyChip key={a.date} a={a} />)}</div>}>
            <ChartContainer config={comboCfg} className="h-[220px] w-full">
              <ComposedChart data={combo}>
                <CartesianGrid vertical={false} strokeOpacity={0.12} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={20} />
                <YAxis yAxisId="l" width={32} tickLine={false} axisLine={false} />
                <YAxis yAxisId="r" orientation="right" width={44} tickLine={false} axisLine={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                {k && <ReferenceLine yAxisId="l" y={k.seuils.commandes_min} stroke="var(--chart-4)" strokeDasharray="4 4" />}
                <Bar yAxisId="l" dataKey="commandes" fill="var(--color-commandes)" radius={3} />
                <Line yAxisId="r" dataKey="ca_eur" stroke="var(--color-ca_eur)" strokeWidth={2} dot={false} />
                <ChartLegend content={<ChartLegendContent />} />
              </ComposedChart>
            </ChartContainer>
          </Panel>
          <Panel id="dow" focus={focus === 'dow'} title="Moyenne par jour de semaine">
            <ChartContainer config={dowCfg} className="h-[220px] w-full">
              <BarChart data={byDow} layout="vertical" margin={{ left: 4 }}>
                <XAxis type="number" hide /><YAxis type="category" dataKey="label" width={36} tickLine={false} axisLine={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="value" fill="var(--color-value)" radius={4} />
              </BarChart>
            </ChartContainer>
          </Panel>
        </div>

        {/* Ligne 3 : multi-courbes à onglets + heatmap */}
        <div className="grid gap-3 xl:grid-cols-[2fr_1fr]">
          <Panel id="trend" focus={focus === 'trend' || focus === metric} title={`Tendance · ${METRICS[metric]}`} subtitle="réel 30 j + prévision 7 j" right={
            <Tabs value={metric} onValueChange={(v) => setMetric(v as Metric)}><TabsList className="h-7">{(Object.keys(METRICS) as Metric[]).map((m) => <TabsTrigger key={m} value={m} className="px-2 text-[11px]">{METRICS[m]}</TabsTrigger>)}</TabsList></Tabs>
          }>
            <ChartContainer config={lineCfg} className="h-[200px] w-full">
              <AreaChart data={multi}>
                <CartesianGrid vertical={false} strokeOpacity={0.12} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={20} />
                <YAxis width={40} tickLine={false} axisLine={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Area dataKey="reel" type="monotone" stroke="var(--color-reel)" fill="var(--color-reel)" fillOpacity={0.25} />
                <Area dataKey="prevision" type="monotone" stroke="var(--color-prevision)" fill="var(--color-prevision)" fillOpacity={0.1} strokeDasharray="5 4" />
              </AreaChart>
            </ChartContainer>
          </Panel>
          <Panel id="heatmap" focus={focus === 'heatmap'} title="Heatmap · 4 semaines" subtitle="intensité des commandes par jour">
            <div className="grid grid-cols-7 gap-1">
              {DOW.map((d) => <div key={d} className="text-center text-[10px] text-slate-500">{d}</div>)}
              {heat.length > 0 && Array.from({ length: new Date(heat[0].date).getUTCDay() }).map((_, i) => <div key={`e${i}`} />)}
              {heat.map((p) => <div key={p.date} title={`${short(p.date)} · ${p.commandes} commandes`} className="aspect-square rounded-sm border border-white/5" style={{ background: `color-mix(in oklch, var(--chart-1) ${Math.round(p.k * 100)}%, transparent)` }} />)}
            </div>
          </Panel>
        </div>

        {/* Ligne 4 : simulation, tableau, journal */}
        <div className="grid gap-3 xl:grid-cols-[2fr_1fr]">
          <Panel id="simulation" focus={focus === 'simulation'} title="Simulation · what-if" subtitle={sim ? `CA 14 j ${eur(sim.total_ca_scenario)} (${fmt(sim.ecart_ca_pct)} vs réel projeté) · commandes ${fmt(sim.variation_commandes_pct)}` : 'recalcul instantané'}>
            <div className="grid gap-3 md:grid-cols-[220px_1fr]">
              <div className="space-y-3 text-xs">
                {([['price_change_pct', 'Prix', -20, 20, 1], ['traffic_change_pct', 'Trafic', -30, 30, 1], ['elasticity', 'Élasticité', -3, 0, 0.1]] as const).map(([key, label, min, max, step]) => (
                  <div key={key} className="space-y-1.5">
                    <div className="flex justify-between"><span className="text-slate-300">{label}</span><span className="font-mono text-cyan-200">{key === 'elasticity' ? scenario[key].toFixed(1) : fmt(scenario[key])}</span></div>
                    <Slider data-testid={`slider-${key}`} min={min} max={max} step={step} value={[scenario[key]]} onValueChange={([v]) => setScenario((s) => ({ ...s, [key]: v }))} />
                  </div>
                ))}
                <div className="space-y-1.5"><div className="flex justify-between"><span className="text-slate-300">Mix réel ↔ scénario</span><span className="font-mono text-cyan-200">{xfade} %</span></div><Slider min={0} max={100} step={1} value={[xfade]} onValueChange={([v]) => setXfade(v)} /></div>
              </div>
              <ChartContainer config={simCfg} className="h-[200px] w-full">
                <LineChart data={mix}>
                  <CartesianGrid vertical={false} strokeOpacity={0.12} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={20} />
                  <YAxis width={48} tickLine={false} axisLine={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Line dataKey="ca_prevu" stroke="var(--color-ca_prevu)" dot={false} strokeOpacity={0.7} />
                  <Line dataKey="ca_scenario" stroke="var(--color-ca_scenario)" dot={false} strokeOpacity={0.7} />
                  <Line dataKey="mix" stroke="var(--color-mix)" strokeWidth={3} dot={false} isAnimationActive={false} />
                  <ChartLegend content={<ChartLegendContent />} />
                </LineChart>
              </ChartContainer>
            </div>
          </Panel>
          <div className="grid gap-3">
            <Panel id="table" focus={focus === 'table'} title="7 derniers jours">
              <table className="w-full font-mono text-[11px]">
                <thead className="text-slate-500"><tr><th className="text-left font-normal">Jour</th><th className="text-right font-normal">Cmd</th><th className="text-right font-normal">CA</th><th className="text-right font-normal">Conv.</th></tr></thead>
                <tbody>{series.slice(-7).reverse().map((p) => <tr key={p.date} className={anomalies.some((a) => a.date === p.date) ? 'text-rose-300' : 'text-slate-200'}><td>{short(p.date)}</td><td className="text-right">{p.commandes}</td><td className="text-right">{eur(p.ca_eur)}</td><td className="text-right">{p.conversion_pct} %</td></tr>)}</tbody>
              </table>
            </Panel>
            <Panel id="journal" focus={focus === 'journal'} title="Journal des actions" subtitle="actions confirmées dans le chat">
              <div className="max-h-28 space-y-0.5 overflow-auto text-[11px]">
                {actions.length ? actions.map((a) => <div key={a.id} className="flex justify-between gap-2"><span className="truncate">{new Date(a.createdAt).toLocaleTimeString('fr-FR')} · {a.action} <span className="text-slate-500">({a.origine})</span></span><span className={a.statut === 'executee' ? 'text-emerald-400' : 'text-slate-400'}>{a.statut}</span></div>) : <span className="text-slate-500">Aucune action : demande-la au contremaître.</span>}
              </div>
            </Panel>
          </div>
        </div>

        {/* Ligne 5 : simulation VIVANTE (PixiJS) — les curseurs du what-if pilotent la machine en direct */}
        {stages.length > 1 && (
          <Panel id="machine" focus={focus === 'machine'} className="mt-3" title="Tunnel de conversion · machine" subtitle="particules = visiteurs · chutes = pertes · engrenage rouge = goulot · curseurs Prix/Trafic en direct · clic sur une étape → contremaître">
            <MachineScene stages={stages} scenario={scenario} />
          </Panel>
        )}
      </div>
    </AppShell>
  );
}
