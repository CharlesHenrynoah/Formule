import { Component, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppSpec, AppDataBundle, ViewSpec } from '@formule/contracts/browser';
import { mcp, notify, onMeta, onRefresh, onViewCommand, prepareAction, type Meta } from './bridge';
import { fmtTime } from './format';
import { KpiView, LineView, NoteView, RankingView, SimulationView, TableView } from './views';
import { BarsView, DonutView, HeatmapView, HistogramView, ScatterView } from './shapes';
import { applyPalette, seedOf } from './palette';

// Mise en page : plusieurs graphiques par ligne sur grand écran.
const SPAN: Record<string, string> = {
  line: 'md:col-span-2 xl:col-span-6', donut: 'xl:col-span-3', bars: 'md:col-span-2 xl:col-span-6', ranking: 'xl:col-span-3',
  histogram: 'md:col-span-2 xl:col-span-3', scatter: 'md:col-span-2 xl:col-span-3', heatmap: 'md:col-span-2 xl:col-span-6', note: 'xl:col-span-3',
  table: 'md:col-span-2 xl:col-span-6', simulation: 'md:col-span-2 xl:col-span-6',
};
// Ordre d'affichage : graphiques d'abord, simulation, puis le détail tabulaire.
const ORDER: Record<string, number> = { kpi: -1, line: 0, donut: 1, bars: 1, ranking: 1, histogram: 2, scatter: 2, heatmap: 3, note: 3, simulation: 4, table: 5 };

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-');

export type QueryState = { raw: unknown; status: 'ready' | 'loading' | 'stale' | 'error' | 'empty' | 'partial'; observedAt: string | null; syncedAt: string; error?: string; coverageNote?: string; demo: boolean; source: string };

class Boundary extends Component<{ children: ReactNode; id: string }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: Error) { return { err: e.message }; }
  componentDidCatch(e: Error) { notify('formule:error', { viewId: this.props.id, message: e.message }); }
  render() {
    if (this.state.err) return <div role="alert" className="rounded-xl border border-dashed border-line bg-card p-4 text-sm text-ink">Erreur dans cette vue : {this.state.err}</div>;
    return this.props.children;
  }
}

function initialStates(spec: AppSpec, data: AppDataBundle): Record<string, QueryState> {
  const out: Record<string, QueryState> = {};
  for (const q of spec.queries) {
    const d = data.queries[q.id];
    if (!d) { out[q.id] = { raw: null, status: 'error', observedAt: null, syncedAt: data.builtAt, error: 'aucune lecture disponible', demo: spec.demo, source: q.serverId }; continue; }
    const e = d.envelope;
    out[q.id] = {
      raw: d.raw, observedAt: e.observedAt, syncedAt: e.fetchedAt, demo: e.source.demo, source: e.source.serverName,
      status: e.status === 'error' ? 'error' : e.status === 'empty' ? 'empty' : e.status === 'partial' ? 'partial' : 'ready',
      coverageNote: e.coverage.note,
    };
  }
  return out;
}

export function App({ spec: embedded, data }: { spec: AppSpec; data: AppDataBundle }) {
  // Le statut de certification vient du Studio (version vérifiée) ; le bundle embarqué reste « aperçu ».
  const [meta, setMeta] = useState<Meta>({ certification: data.certification });
  useEffect(() => onMeta(setMeta), []);
  const spec = useMemo(() => (meta.requirements ? { ...embedded, requirements: embedded.requirements.map((r) => { const m = meta.requirements!.find((x) => x.id === r.id); return m ? { ...r, status: m.status, reason: m.reason } : r; }) } : embedded), [embedded, meta]);
  // couleurs dynamiques : graine = interface (titre + accent choisi)
  useMemo(() => applyPalette(seedOf(embedded.title), embedded.style.accent), [embedded.title, embedded.style.accent]);
  useMemo(() => {
    const r = document.documentElement;
    const ACC: Record<string, string> = { orange: '#ff8a1f', rouge: '#ff5a5f', bleu: '#3b9bff', vert: '#34c77b', violet: '#b07cff', cyan: '#3fd0e0', sable: '#d5ba82', mono: '#ffffff' };
    r.style.setProperty('--accent', ACC[embedded.style.accent] ?? '#ffffff');
    if (embedded.style.theme === 'graphite') { r.style.setProperty('--color-app', '#141414'); r.style.setProperty('--color-card', '#1b1b1b'); r.style.setProperty('--color-line', '#2b2b2b'); }
    if (embedded.style.font === 'mono') r.classList.add('font-mono-app');
  }, [embedded.style]);
  const [qs, setQs] = useState(() => initialStates(spec, data));
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    await Promise.all(spec.queries.map(async (q) => {
      setQs((s) => ({ ...s, [q.id]: { ...s[q.id], status: s[q.id].raw ? s[q.id].status : 'loading' } }));
      try {
        const res = (await mcp.call(`${q.serverId}__${q.tool}`, q.args)) as { envelope: { status: string; observedAt: string | null; fetchedAt: string; error?: { message: string }; coverage: { note?: string } }; raw: unknown };
        if (res.envelope.status === 'error') throw new Error(res.envelope.error?.message ?? 'lecture refusée');
        setQs((s) => ({ ...s, [q.id]: { ...s[q.id], raw: res.raw, observedAt: res.envelope.observedAt, syncedAt: res.envelope.fetchedAt, status: res.envelope.status === 'partial' ? 'partial' : res.envelope.status === 'empty' ? 'empty' : 'ready', error: undefined, coverageNote: res.envelope.coverage.note } }));
      } catch (e) {
        // Panne : dernière donnée autorisée marquée obsolète, jamais remplacée par une valeur inventée.
        setQs((s) => ({ ...s, [q.id]: { ...s[q.id], status: s[q.id].raw ? 'stale' : 'error', error: (e as Error).message } }));
      }
    }));
    setBusy(false);
  }, [spec.queries]);

  useEffect(() => onRefresh(() => { void refresh(); }), [refresh]);
  useEffect(() => onViewCommand((c) => {
    if (c.op === 'reset') { setHidden(new Set()); setFocus(null); return; }
    if (!c.viewId) return;
    if (c.op === 'hide') setHidden((h) => new Set(h).add(c.viewId!));
    if (c.op === 'show') setHidden((h) => { const n = new Set(h); n.delete(c.viewId!); return n; });
    if (c.op === 'focus') setFocus(c.viewId);
  }), []);
  useEffect(() => {
    const polls = spec.queries.filter((q) => q.refresh.mode === 'poll' && q.refresh.intervalSec);
    if (!polls.length) return;
    const min = Math.min(...polls.map((q) => q.refresh.intervalSec!));
    // backoff avec jitter géré par la cadence + aléa
    const t = setInterval(() => void refresh(), (min + Math.random() * 5) * 1000);
    return () => clearInterval(t);
  }, [refresh, spec.queries]);
  useEffect(() => { notify('formule:ready', { views: spec.views.map((v) => ({ id: v.id, kind: v.kind, title: v.title })) }); }, [spec.views]);

  const lastObs = useMemo(() => Object.values(qs).map((q) => q.observedAt).filter(Boolean).sort().pop() ?? null, [qs]);
  const lastSync = useMemo(() => Object.values(qs).map((q) => q.syncedAt).filter(Boolean).sort().pop() ?? null, [qs]);
  const visible = spec.views.filter((v) => (focus ? v.id === focus : !hidden.has(v.id)));
  const sections = useMemo(() => {
    const out: { name: string; views: ViewSpec[] }[] = [];
    for (const v of visible) { const n = (v as { section?: string }).section ?? 'Vue d’ensemble'; let g = out.find((x) => x.name === n); if (!g) { g = { name: n, views: [] }; out.push(g); } g.views.push(v); }
    for (const g of out) g.views.sort((a, b) => (ORDER[a.kind] ?? 3) - (ORDER[b.kind] ?? 3));
    return out;
  }, [visible]);
  const [active, setActive] = useState<string | null>(null);
  const kpis = visible.filter((v) => v.kind === 'kpi');
  const others = visible.filter((v) => v.kind !== 'kpi').map((v, i) => ({ v, i })).sort((a, b) => (ORDER[a.v.kind] ?? 3) - (ORDER[b.v.kind] ?? 3) || a.i - b.i).map((x) => x.v);
  const cert = meta.certification;
  const covered = spec.requirements.filter((r) => r.mandatory && r.status === 'covered').length;
  const total = spec.requirements.filter((r) => r.mandatory).length;

  const render = (v: ViewSpec) => {
    const q = 'queryId' in v ? qs[v.queryId] : undefined;
    const body = (() => {
      switch (v.kind) {
        case 'kpi': return <KpiView view={v} q={q!} />;
        case 'line': return <LineView view={v} q={q!} />;
        case 'table': return <TableView view={v} q={q!} full={focus === v.id} />;
        case 'ranking': return <RankingView view={v} q={q!} />;
        case 'simulation': return <SimulationView view={v} q={q!} />;
        case 'note': return <NoteView view={v} />;
        case 'bars': return <BarsView view={v} q={q!} />;
        case 'donut': return <DonutView view={v} q={q!} />;
        case 'histogram': return <HistogramView view={v} q={q!} />;
        case 'scatter': return <ScatterView view={v} q={q!} />;
        case 'heatmap': return <HeatmapView view={v} q={q!} />;
      }
    })();
    return <Boundary key={v.id} id={v.id}>{body}</Boundary>;
  };

  return (
    <main className={`min-h-full p-5 ${spec.style.density === 'compact' ? 'space-y-3' : 'space-y-5'}`}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{spec.title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-mute">{spec.mission}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {spec.demo && <span className="rounded-xl border border-line px-2.5 py-1 font-medium text-ink" title="Données synthétiques d'un serveur de démonstration">DÉMO</span>}
          <span className={`rounded-xl border px-2 py-1 ${cert.certified ? 'border-[var(--accent)] bg-[var(--accent)] text-black' : 'border-line text-ink'}`} title={cert.message}>
            {cert.label === 'certifiée' ? `Certifiée · ${covered}/${total}` : cert.label === 'partielle' ? `Partielle · ${covered}/${total}` : cert.label === 'aperçu' ? 'Aperçu non certifié' : 'Non certifiée'}
          </span>
          <span className="text-mute">Observé <span className="num text-ink">{fmtTime(lastObs)}</span></span>
          <span className="text-mute">Dernière acquisition <span className="num text-ink">{fmtTime(lastSync)}</span></span>
          <button onClick={() => void refresh()} disabled={busy} className="rounded-full border border-[var(--accent)] px-3 py-1 text-[var(--accent)] hover:bg-[var(--accent)] hover:text-black disabled:opacity-50">{busy ? 'Actualisation…' : 'Actualiser'}</button>
          {focus && <button onClick={() => setFocus(null)} className="rounded-full border border-line px-3 py-1 hover:border-white">Tout afficher</button>}
        </div>
      </header>

      {!cert.certified && spec.requirements.some((r) => r.mandatory && r.status !== 'covered') && (
        <div role="status" className="rounded-xl border border-dashed border-line bg-card px-4 py-2 text-sm">
          <span className="font-medium text-ink">Livraison incomplète.</span>{' '}
          Manque : {spec.requirements.filter((r) => r.mandatory && r.status !== 'covered').map((r) => `${r.label}${r.reason ? ` (${r.reason})` : ''}`).join(' ; ')}.
        </div>
      )}

      {sections.length > 1 && !focus ? (
        <div className={spec.style.nav === 'sidebar' ? 'grid gap-6 lg:grid-cols-[200px_1fr]' : ''}>
          {spec.style.nav === 'sidebar' && (
            <nav aria-label="Sections" className="hidden lg:block">
              <ul className="sticky top-4 space-y-1 border-l border-line pl-3 text-[13px]">
                {sections.map((sec) => <li key={sec.name}><a href={`#s-${slug(sec.name)}`} onClick={(e) => { e.preventDefault(); document.getElementById(`s-${slug(sec.name)}`)?.scrollIntoView({ behavior: 'smooth' }); setActive(sec.name); }} className={`block rounded-md px-2 py-1 ${active === sec.name ? 'text-[var(--accent)]' : 'text-mute hover:text-ink'}`}>{sec.name}</a></li>)}
              </ul>
            </nav>
          )}
          <div className="min-w-0 space-y-8">
            {sections.map((sec) => {
              const k = sec.views.filter((v) => v.kind === 'kpi'); const o = sec.views.filter((v) => v.kind !== 'kpi');
              return (
                <section key={sec.name} id={`s-${slug(sec.name)}`} aria-label={sec.name} className="scroll-mt-4 space-y-3">
                  <h2 className="flex items-center gap-2 text-[15px] font-semibold"><span className="h-3 w-1 rounded-full bg-[var(--accent)]" />{sec.name}</h2>
                  {k.length > 0 && <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">{k.map(render)}</div>}
                  {o.length > 0 && <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">{o.map((v) => <div key={v.id} className={SPAN[v.kind]}>{render(v)}</div>)}</div>}
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        <>
          {kpis.length > 0 && <section aria-label="Indicateurs" className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(210px,1fr))]">{kpis.map(render)}</section>}
          {others.length > 0 && <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">{others.map((v) => <div key={v.id} className={focus ? 'md:col-span-2 xl:col-span-6' : SPAN[v.kind]}>{render(v)}</div>)}</section>}
        </>
      )}
      {visible.length === 0 && <p className="text-sm text-mute">Aucune vue affichée. Demande à Formule Agent de réafficher une vue.</p>}

      {spec.actions.length > 0 && !focus && <Actions spec={spec} certified={cert.certified} />}
    </main>
  );
}

function Actions({ spec, certified }: { spec: AppSpec; certified: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const action = spec.actions.find((a) => a.id === open);
  const submit = async () => {
    if (!action) return;
    const args: Record<string, unknown> = { ...action.fixedArgs };
    for (const f of action.fields) {
      const raw = vals[f.name] ?? (f.default !== undefined ? String(f.default) : '');
      if (f.required && raw === '') { setMsg(`« ${f.label} » est obligatoire.`); return; }
      if (raw === '') continue;
      if (f.type === 'number') {
        const n = Number(raw); if (!Number.isFinite(n)) { setMsg(`« ${f.label} » doit être un nombre.`); return; }
        if (f.min !== undefined && n < f.min || f.max !== undefined && n > f.max) { setMsg(`« ${f.label} » hors bornes.`); return; }
        args[f.name] = n;
      } else args[f.name] = raw;
    }
    setMsg('Confirmation demandée dans le fil de Formule Agent…');
    try { const r = (await prepareAction(action.id, args)) as { message: string }; setMsg(r.message); setOpen(null); }
    catch (e) { setMsg((e as Error).message); }
  };
  return (
    <section aria-label="Actions" className="rounded-xl border border-line bg-card p-4">
      <div className="label mb-3">Actions · confirmation obligatoire</div>
      <div className="flex flex-wrap gap-2">
        {spec.actions.map((a) => (
          <button key={a.id} disabled={!certified} title={certified ? a.effect : 'Aperçu non certifié : aucune action externe'} onClick={() => { setOpen(a.id); setVals({}); setMsg(null); }}
            className="rounded-full border border-line px-3.5 py-1.5 text-sm hover:border-white disabled:opacity-40">{a.label}</button>
        ))}
      </div>
      {action && (
        <form className="mt-4 grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <p className="text-sm text-mute sm:col-span-3">{action.effect}</p>
          {action.fields.map((f) => (
            <label key={f.name} className="text-sm">
              <span className="label">{f.label}{f.required ? ' *' : ''}</span>
              {f.type === 'enum' ? (
                <select className="mt-1 w-full rounded-xl border border-line bg-app px-2 py-1.5" value={vals[f.name] ?? String(f.default ?? '')} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })}>
                  <option value="">—</option>{f.options?.map((o) => <option key={o}>{o}</option>)}
                </select>
              ) : (
                <input className="mt-1 w-full rounded-xl border border-line bg-app px-2 py-1.5 num" inputMode={f.type === 'number' ? 'decimal' : 'text'} value={vals[f.name] ?? String(f.default ?? '')} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} />
              )}
            </label>
          ))}
          <div className="flex gap-2 sm:col-span-3">
            <button type="submit" className="rounded-full bg-white px-4 py-1.5 text-sm font-medium text-black">Préparer</button>
            <button type="button" onClick={() => setOpen(null)} className="rounded-full border border-line px-4 py-1.5 text-sm">Annuler</button>
          </div>
        </form>
      )}
      {msg && <p role="status" className="mt-3 text-sm text-mute">{msg}</p>}
    </section>
  );
}
