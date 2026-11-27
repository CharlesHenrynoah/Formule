import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Paperclip, Plug, Square, X, RotateCcw } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { Preview } from './Preview';
import { Thread, type Item, type Sourcing } from './Thread';
import { McpDialog } from './McpDialog';
import { useVoice } from './voice';
import { Button } from '../components/ui/button';
import { api, type ActionCard, type CatalogServer, type Message, type Project, type VersionMeta } from '../lib/api';
import { cn } from '../lib/utils';

const SUGGESTIONS = [
  { label: 'Revenu du mois', prompt: 'Crée une interface du revenu du mois : total facturé ce mois-ci, évolution des montants facturés et détail des factures avec leur statut.' },
  { label: 'Pipeline commercial', prompt: 'Crée une interface du pipeline commercial : montant ouvert, répartition par étape, classement des commerciaux et liste des affaires.' },
  { label: 'Publicités rentables', prompt: 'Crée une interface des publicités rentables : dépense, revenu attribué, ROAS global et classement des campagnes par ROAS.' },
  { label: 'Inscriptions devenues clients', prompt: 'Crée une interface des inscriptions devenues clients : inscriptions, taux de conversion en clients et courbe quotidienne, avec une simulation.' },
];
const EVENT_TYPES = ['job.created', 'job.state', 'step', 'log', 'source', 'requirement', 'answer', 'certification', 'published', 'limitation', 'error', 'job.done'];
const uid = () => Math.random().toString(36).slice(2, 10);
type VersionFull = VersionMeta & { hasHtml: boolean; spec: { title: string; commands: string[]; requirements: { id: string; status: string; reason?: string }[]; views: { id: string; kind: string; title: string }[] } };

function labelOf(v: VersionMeta | null): 'certifiée' | 'partielle' | 'non certifiée' | 'aperçu' {
  if (!v) return 'aperçu';
  if (v.status === 'ACTIVE' || (v.status === 'SUPERSEDED' && v.was_certified)) return 'certifiée';
  if (v.status === 'PARTIAL' || (v.status === 'SUPERSEDED' && !v.was_certified)) return 'partielle';
  return v.certification && !v.certification.certified && v.certification.outcome === 'FAILED' ? 'non certifiée' : 'aperçu';
}

function toItems(msgs: Message[]): Item[] {
  const items: Item[] = [];
  for (const m of msgs) {
    const c = m.content;
    if (m.role === 'user') { items.push({ kind: 'user', id: m.id, text: c.text }); continue; }
    if (c.kind === 'sourcing') { items.push({ kind: 'sourcing', id: m.id, jobId: '', summary: c as unknown as Sourcing, decision: c.decision ?? 'validé' }); continue; }
    if (c.card) {
      const stale = Date.now() - Date.parse(m.created_at) > 10 * 60_000;
      items.push({ kind: 'agent', id: m.id + 't', text: c.text });
      items.push({ kind: 'card', id: m.id, card: { ...c.card, status: stale ? 'declined' : 'pending' }, ...(stale ? { result: 'Expirée sans réponse : rien n’est parti.' } : {}) });
      continue;
    }
    if (c.opId && c.opStatus) {
      const card = [...items].reverse().find((x) => x.kind === 'card' && x.card.opId === c.opId) as Extract<Item, { kind: 'card' }> | undefined;
      if (card) { card.card = { ...card.card, status: c.opStatus === 'done' ? 'done' : c.opStatus === 'declined' ? 'declined' : 'error' }; card.result = c.text; continue; }
    }
    if (c.text) items.push({ kind: 'agent', id: m.id, text: c.text });
  }
  return items;
}

export function Studio({ go }: { go: (p: string) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionMeta[]>([]);
  const [selN, setSelN] = useState<number | null>(null);
  const [verFull, setVerFull] = useState<VersionFull | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [mode, setMode] = useState<'ask' | 'agent'>('agent');
  const [job, setJob] = useState<{ id: string } | null>(null);
  const [meta, setMeta] = useState<{ demo: boolean; voice: unknown; engine?: string | null; semanticEngine?: string | null; git?: { commit?: string | null; branch?: string | null } | null } | null>(null);
  const [toolCount, setToolCount] = useState<number | null>(null);
  const [files, setFiles] = useState<{ id: string; name: string; rows: number }[]>([]);
  const [text, setText] = useState('');
  const [panelW, setPanelW] = useState(400);
  const [collapsed, setCollapsed] = useState(false);
  const [unread, setUnread] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [tabs, setTabs] = useState<{ id: string; title: string }[]>([]);
  const [tab, setTab] = useState('interface');
  const [appError, setAppError] = useState<string | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const es = useRef<EventSource | null>(null);
  const curRef = useRef<string | null>(null); curRef.current = currentId;
  const collapsedRef = useRef(collapsed); collapsedRef.current = collapsed;
  const voiceRef = useRef<ReturnType<typeof useVoice> | null>(null);

  const push = useCallback((...it: Item[]) => { setItems((x) => [...x, ...it]); if (collapsedRef.current) setUnread(true); }, []);
  const loadProjects = useCallback(async () => setProjects(await api<Project[]>('/api/projects')), []);
  const loadTools = useCallback(async () => {
    try { const c = await api<CatalogServer[]>('/api/mcp/catalog'); setToolCount(c.reduce((a, s) => a + s.tools.filter((t) => t.permission === 'read' || t.permission === 'write').length, 0)); } catch { setToolCount(null); }
  }, []);
  useEffect(() => { void loadProjects(); void loadTools(); api('/api/meta').then(setMeta).catch(() => setMeta({ demo: true, voice: null })); }, [loadProjects, loadTools]);

  const loadVersions = useCallback(async (pid: string, pick?: number) => {
    const [p, vs] = await Promise.all([api<Project>(`/api/projects/${pid}`), api<VersionMeta[]>(`/api/projects/${pid}/versions`)]);
    setVersions(vs);
    const n = pick ?? p.active_version ?? vs[vs.length - 1]?.n ?? null;
    setSelN(n);
    return n;
  }, []);
  useEffect(() => {
    if (!currentId || !selN) { setVerFull(null); return; }
    api<VersionFull>(`/api/projects/${currentId}/versions/${selN}`).then(setVerFull).catch(() => setVerFull(null));
    setTabs([]); setTab('interface'); setAppError(null);
  }, [currentId, selN]);

  const openProject = useCallback(async (id: string) => {
    if (job) return;
    setCurrentId(id); setErr(null);
    await loadVersions(id);
    setItems(toItems(await api<Message[]>(`/api/projects/${id}/messages`)));
  }, [job, loadVersions]);

  const newInterface = () => { if (job) return; setCurrentId(null); setVersions([]); setSelN(null); setItems([]); setMode('agent'); setFiles([]); setText(''); };

  // ---------- flux de construction (SSE, reprise par Last-Event-ID) ----------
  const follow = useCallback((jobId: string, evolving: boolean) => {
    es.current?.close();
    const src = new EventSource(`/api/jobs/${jobId}/events`);
    es.current = src;
    const buildId = `b-${jobId}`;
    const ensureBuild = () => setItems((x) => (x.some((i) => i.id === buildId) ? x : [...x.filter((i) => i.kind !== 'working'), { kind: 'build', id: buildId, jobId, startedAt: Date.now(), endedAt: null, step: 'Analyse des données', steps: [], logs: [], state: 'DISCOVERY' }]));
    const patchBuild = (f: (b: Extract<Item, { kind: 'build' }>) => Extract<Item, { kind: 'build' }>) => setItems((x) => x.map((i) => (i.id === buildId && i.kind === 'build' ? f(i) : i)));
    const handle = (e: MessageEvent) => {
      const ev = JSON.parse(e.data) as { type: string; seq: number; payload: Record<string, any> };
      const p = ev.payload;
      switch (ev.type) {
        case 'job.state':
          if (evolving || ['CONTRACT', 'BUILD', 'CERTIFICATION', 'REPAIR'].includes(p.to)) ensureBuild();
          patchBuild((b) => ({ ...b, step: p.step ?? b.step, state: p.to, logs: [...b.logs, `${p.from} → ${p.to}`] }));
          break;
        case 'source': setItems((x) => [...x.filter((i) => i.kind !== 'working'), { kind: 'sourcing', id: `s-${jobId}`, jobId, summary: p as Sourcing, decision: null }]); break;
        case 'log': patchBuild((b) => ({ ...b, logs: [...b.logs, p.text] })); setItems((x) => x.map((i) => (i.kind === 'working' ? { ...i, text: p.text } : i))); break;
        case 'certification': patchBuild((b) => ({ ...b, logs: [...b.logs, `v${p.version} : ${p.message}`] })); break;
        case 'published':
          if (p.projectId && curRef.current !== p.projectId) { setCurrentId(p.projectId); }
          void loadVersions(p.projectId, p.version); void loadProjects();
          break;
        case 'answer': push({ kind: 'agent', id: uid(), text: p.text, tone: /^(Échec|Non certifiée)/.test(p.text) ? 'error' : undefined }); voiceRef.current?.speak(p.text); break;
        case 'error': patchBuild((b) => ({ ...b, logs: [...b.logs, `Erreur : ${p.message}`] })); break;
        case 'job.done':
          src.close(); es.current = null; setJob(null);
          setItems((x) => x.filter((i) => i.kind !== 'working').map((i) => (i.id === buildId && i.kind === 'build' ? { ...i, endedAt: Date.now(), step: null, state: p.state } : i)));
          void loadProjects();
          if (curRef.current) void loadVersions(curRef.current);
          break;
      }
    };
    for (const t of EVENT_TYPES) src.addEventListener(t, handle as EventListener);
    src.onerror = () => { /* le navigateur reconnecte avec Last-Event-ID : reprise, jamais un second job */ };
  }, [loadProjects, loadVersions, push]);
  useEffect(() => () => es.current?.close(), []);

  // ---------- envoi ----------
  const send = useCallback(async (raw: string, opts: { via?: 'voice' } = {}) => {
    const message = raw.trim();
    if (!message || job) return;
    setText(''); setErr(null);
    push({ kind: 'user', id: uid(), text: message });
    try {
      const r = await api<any>('/api/chat', { body: { projectId: currentId, mode, message, fileIds: files.map((f) => f.id), version: selN ?? undefined } });
      setFiles([]);
      if (r.kind === 'job') {
        setJob({ id: r.jobId });
        push({ kind: 'working', id: uid(), text: 'Analyse des données…' });
        follow(r.jobId, !!currentId);
      } else if (r.kind === 'confirm') {
        push({ kind: 'agent', id: uid(), text: r.text }, { kind: 'card', id: uid(), card: r.card });
        voiceRef.current?.speak(`${r.text} Dis oui ou non.`);
      } else {
        push({ kind: 'agent', id: uid(), text: r.text });
        voiceRef.current?.speak(r.text);
        for (const c of r.commands ?? []) iframe.current?.contentWindow?.postMessage({ type: 'formule:view', command: c }, '*');
      }
    } catch (e) { push({ kind: 'agent', id: uid(), text: (e as Error).message, tone: 'error' }); }
    void opts;
  }, [job, currentId, mode, files, selN, push, follow]);

  const decideSourcing = async (jobId: string, ok: boolean) => {
    setItems((x) => x.map((i) => (i.kind === 'sourcing' && i.jobId === jobId ? { ...i, decision: ok ? 'validé' : 'rejeté' } : i)));
    await api(`/api/jobs/${jobId}/${ok ? 'approve' : 'reject'}`, { body: {} }).catch((e) => setErr(e.message));
  };
  const decideCard = useCallback(async (card: ActionCard, ok: boolean, via: 'click' | 'voice' = 'click') => {
    const set = (status: ActionCard['status'], result?: string) => setItems((x) => x.map((i) => (i.kind === 'card' && i.card.opId === card.opId ? { ...i, card: { ...i.card, status }, result } : i)));
    if (!ok) { set('declined', 'Refusée. Rien n’est parti.'); await api(`/api/actions/${card.opId}/decline`, { body: { projectId: currentId } }).catch(() => {}); return; }
    set('running');
    try { const r = await api<{ text: string }>(`/api/actions/${card.opId}/execute`, { body: { args: card.args, projectId: currentId, via } }); set('done', r.text); iframe.current?.contentWindow?.postMessage({ type: 'formule:refresh' }, '*'); }
    catch (e) { set('error', (e as Error).message); }
  }, [currentId]);
  const cancel = async () => { if (job) await api(`/api/jobs/${job.id}/cancel`, { body: {} }).catch(() => {}); };

  // ---------- voix ----------
  const pendingCard = useMemo(() => [...items].reverse().find((i) => i.kind === 'card' && i.card.status === 'pending') as Extract<Item, { kind: 'card' }> | undefined, [items]);
  const voice = useVoice({
    onFinal: async (t, confidence, auto) => {
      if (pendingCard) {
        const { decision } = await api<{ decision: string }>('/api/voice/confirmation', { body: { transcript: t, confidence } });
        if (decision === 'yes') return decideCard(pendingCard.card, true, 'voice');
        if (decision === 'no') return decideCard(pendingCard.card, false, 'voice');
        push({ kind: 'agent', id: uid(), text: `J’ai entendu « ${t} » : ce n’est pas une confirmation claire. Rien n’est parti ; réponds « oui » ou « non », ou utilise les boutons.`, tone: 'muted' });
        return;
      }
      if (auto) { const { command } = await api<{ command: string | null }>('/api/voice/wake', { body: { transcript: t } }); if (command) void send(command, { via: 'voice' }); return; }
      void send(t, { via: 'voice' });
    },
  });
  voiceRef.current = voice;

  // ---------- pont avec l'app (event.source = cette iframe uniquement) ----------
  const activeLabel = labelOf(versions.find((v) => v.n === selN) ?? null);
  useEffect(() => {
    const onMsg = async (e: MessageEvent) => {
      const win = iframe.current?.contentWindow;
      if (!win || e.source !== win) return;
      const m = e.data as Record<string, any>;
      const reply = (ok: boolean, result?: unknown, error?: string) => win.postMessage({ type: 'formule:reply', id: m.id, ok, result, error }, '*');
      if (m.type === 'formule:ready') {
        setTabs((m.views as { id: string; kind: string; title: string }[]).filter((v) => v.kind === 'table').map((v) => ({ id: v.id, title: v.title })));
        if (verFull) win.postMessage({ type: 'formule:meta', meta: { certification: { certified: activeLabel === 'certifiée', message: verFull.certification?.message ?? '', label: activeLabel }, requirements: verFull.spec.requirements } }, '*');
      } else if (m.type === 'formule:error') setAppError(String(m.message ?? 'erreur inconnue'));
      else if (m.type === 'formule:open-link') {
        // lien vers une source originale : HTTPS uniquement, nouvel onglet isolé
        try { const u = new URL(String(m.url)); if (u.protocol === 'https:') window.open(u.href, '_blank', 'noopener,noreferrer'); } catch { /* lien invalide ignoré */ }
      }
      else if (m.type === 'formule:mcp') {
        try { reply(true, await api(`/api/bridge/${currentId}/${selN}`, { body: { method: m.method, name: m.name, args: m.args ?? {} } })); }
        catch (err) { reply(false, undefined, (err as Error).message); }
      } else if (m.type === 'formule:action') {
        try {
          const r = await api<{ card: ActionCard }>('/api/actions/prepare', { body: { projectId: currentId, version: selN, actionId: m.actionId, args: m.args } });
          push({ kind: 'agent', id: uid(), text: `Action préparée : ${r.card.label}. Rien ne part sans ton « Oui, exécuter ».` }, { kind: 'card', id: uid(), card: r.card });
          reply(true, { message: 'Confirmation demandée dans le fil de Formule Agent.' });
        } catch (err) { reply(false, undefined, (err as Error).message); }
      }
    };
    addEventListener('message', onMsg);
    return () => removeEventListener('message', onMsg);
  }, [currentId, selN, verFull, activeLabel, push]);
  useEffect(() => {
    if (verFull) iframe.current?.contentWindow?.postMessage({ type: 'formule:meta', meta: { certification: { certified: activeLabel === 'certifiée', message: verFull.certification?.message ?? '', label: activeLabel }, requirements: verFull.spec.requirements } }, '*');
  }, [verFull, activeLabel]);
  useEffect(() => {
    iframe.current?.contentWindow?.postMessage({ type: 'formule:view', command: tab === 'interface' ? { op: 'reset' } : { op: 'focus', viewId: tab } }, '*');
  }, [tab]);

  // ---------- raccourcis & redimensionnement ----------
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === '.') { e.preventDefault(); setCollapsed((c) => { if (c) setUnread(false); return !c; }); } };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, []);
  const drag = (e: React.PointerEvent) => {
    const x0 = e.clientX, w0 = panelW; let moved = false;
    const mv = (ev: PointerEvent) => { const d = x0 - ev.clientX; if (Math.abs(d) > 3) moved = true; if (w0 + d < 260) { setCollapsed(true); return; } setCollapsed(false); setUnread(false); setPanelW(Math.min(720, Math.max(320, w0 + d))); };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); if (!moved) setCollapsed((c) => { if (c) setUnread(false); return !c; }); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  };

  const attach = async (list: FileList | null) => {
    if (!list) return;
    for (const f of [...list].slice(0, 3 - files.length)) {
      try { const r = await api<{ id: string; name: string; rows: number }>('/api/files', { body: { name: f.name, content: await f.text() } }); setFiles((x) => [...x, r].slice(0, 3)); }
      catch (e) { setErr((e as Error).message); }
    }
  };

  const project = projects.find((p) => p.id === currentId) ?? null;
  const src = currentId && selN && verFull?.hasHtml !== false ? `/apps/${currentId}/${selN}/index.html` : null;
  const activeN = project?.active_version ?? null;
  const commands = verFull?.spec.commands ?? [];

  return (
    <div className="flex h-full">
      <Sidebar projects={projects} currentId={currentId} onNew={newInterface} onOpen={openProject} onJournal={() => go('/journal')}
        onDelete={async (id) => { await api(`/api/projects/${id}`, { method: 'DELETE', body: { confirm: true } }); if (id === currentId) newInterface(); await loadProjects(); }}
        onRename={async (id, t) => { await api(`/api/projects/${id}`, { method: 'PATCH', body: { title: t } }); await loadProjects(); }}
        onDuplicate={async (id) => { await api(`/api/projects/${id}/duplicate`, { body: {} }); await loadProjects(); }}
        onArchive={async (id, a) => { await api(`/api/projects/${id}`, { method: 'PATCH', body: { archived: a } }); await loadProjects(); }} />

      <Preview ref={iframe} src={src} building={!!job} fullscreen={fullscreen} setFullscreen={setFullscreen} tabs={tabs} tab={tab} setTab={setTab}
        appError={appError} label={src ? activeLabel : null} onFix={() => { setMode('agent'); void send(`Diagnostic : l’interface affiche l’erreur « ${appError} ». Que faut-il corriger ?`); }} />

      {/* poignée */}
      <div onPointerDown={drag} role="separator" aria-orientation="vertical" title="Tirer pour redimensionner · clic ou Ctrl/⌘ + . pour replier" className="group relative w-1.5 shrink-0 cursor-col-resize border-l border-edge bg-panel hover:bg-raised">
        {collapsed && unread && <span className="absolute left-1/2 top-4 h-2.5 w-2.5 -translate-x-1/2 rounded-full bg-petrol" aria-label="Nouveau message" />}
      </div>

      {!collapsed && (
        <aside style={{ width: panelW }} className="glass flex shrink-0 flex-col" aria-label="Formule Agent">
          <header className="border-b border-edge px-4 py-3">
            <div className="flex items-center gap-2">
              <span className={cn('diamond', job && 'pulse')} style={job ? undefined : { opacity: .35 }} />
              <span className="text-[14px] font-semibold text-ink">Formule Agent</span>
              {voice.supported && meta?.voice ? (
                <div className="ml-auto flex items-center gap-1">
                  <button aria-label="Maintenir pour parler" onPointerDown={voice.pressStart} onPointerUp={voice.pressEnd} onPointerLeave={voice.pressEnd}
                    className={cn('rounded-xl border p-1', voice.listening && !voice.auto ? 'border-petrol text-petrol' : 'border-edge text-mute hover:text-ink')}><Mic size={13} /></button>
                  <button onClick={voice.toggleAuto} className={cn('label-f rounded-xl border px-1.5 py-0.5', voice.auto ? 'border-petrol text-petrol' : 'border-edge text-mute')}>auto</button>
                </div>
              ) : <span className="ml-auto" />}
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[13px] text-mute">{project?.title ?? 'Nouvelle interface'}</span>
              {versions.length > 0 && (
                <select aria-label="Version" value={selN ?? ''} onChange={(e) => setSelN(Number(e.target.value))} className="num rounded-xl border border-edge bg-bg px-1.5 py-0.5 text-[12px]">
                  {versions.map((v) => <option key={v.n} value={v.n}>v{v.n}{v.n === activeN ? ' · active' : ''} · {labelOf(v)}</option>)}
                </select>
              )}
              {selN && activeN && selN !== activeN && ['SUPERSEDED', 'PARTIAL'].includes(versions.find((v) => v.n === selN)?.status ?? '') && (
                <button title="Restaurer cette version" className="text-mute hover:text-ink" onClick={async () => { await api(`/api/projects/${currentId}/versions/${selN}/restore`, { body: {} }); await loadVersions(currentId!, selN); await loadProjects(); }}><RotateCcw size={13} /></button>
              )}
              <div role="radiogroup" aria-label="Mode" className="flex rounded-full border border-edge p-0.5">
                {(['ask', 'agent'] as const).map((m) => (
                  <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cn('rounded-full px-3 py-1 text-[12px] font-medium', mode === m ? 'bg-white text-black' : 'text-mute hover:text-ink')}>{m === 'ask' ? 'Ask' : 'Agent'}</button>
                ))}
              </div>
            </div>
            {voice.subtitle && (
              <div className="mt-2 flex items-center gap-2 text-[12px] text-mute">
                <span>{voice.subtitle}</span>
                <span className="h-1 flex-1 overflow-hidden rounded bg-edge"><span className="block h-full bg-petrol transition-[width]" style={{ width: `${Math.round(voice.level * 100)}%` }} /></span>
                {voice.speaking && <button onClick={voice.interrupt} className="text-faint hover:text-ink" aria-label="Couper la parole"><Square size={11} /></button>}
              </div>
            )}
          </header>
          <div className={cn('border-b border-edge px-4 py-1.5 text-[12px]', mode === 'ask' ? 'text-mute' : 'text-ink')}>
            {mode === 'ask' ? 'Ask · lecture de l’interface et des données' : 'Agent · écriture, actions et évolutions'}
          </div>

          <Thread items={items} onApprove={decideSourcing} onCard={(c, ok) => decideCard(c, ok)} commands={currentId && !job ? commands : []} onCommand={(c) => setText(c)} />

          <form className="border-t border-edge p-3" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
            {err && <p className="mb-2 text-[12px] text-danger">{err}</p>}
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text); } }}
              placeholder="Décris l’interface à construire…" aria-label="Message pour Formule Agent"
              className="w-full resize-none rounded-2xl border border-edge bg-raised px-4 py-3 text-[14px] placeholder:text-faint focus:border-edge-strong focus:outline-none" />
            {!currentId && (
              <div className="relative mt-2 overflow-hidden" aria-label="Suggestions">
                <div className="marquee flex w-max gap-1.5">
                  {[...SUGGESTIONS, ...SUGGESTIONS].map((s, i) => (
                    <button type="button" key={i} tabIndex={i < SUGGESTIONS.length ? 0 : -1} onClick={() => setText(s.prompt)} className="whitespace-nowrap rounded-xl border border-edge px-2 py-1 text-xs text-mute hover:border-petrol/60 hover:text-ink">{s.label}</button>
                  ))}
                </div>
              </div>
            )}
            {files.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {files.map((f) => <span key={f.id} className="flex items-center gap-1 rounded-xl border border-edge px-1.5 py-0.5 text-[11px]">{f.name} <span className="num text-faint">{f.rows} l.</span><button type="button" aria-label="Retirer" onClick={() => setFiles((x) => x.filter((y) => y.id !== f.id))}><X size={11} /></button></span>)}
              </div>
            )}
            <div className="mt-2 flex items-center gap-1.5">
              <label className={cn('cursor-pointer rounded-xl border border-edge p-1.5 text-mute hover:text-ink', files.length >= 3 && 'pointer-events-none opacity-40')} title="Joindre CSV ou JSON (3 max, restent sur la machine)">
                <Paperclip size={13} /><input type="file" accept=".csv,.json" multiple className="hidden" onChange={(e) => { void attach(e.target.files); e.target.value = ''; }} />
              </label>
              <button type="button" onClick={() => setMcpOpen(true)} className="flex items-center gap-1 rounded-xl border border-edge px-1.5 py-1 text-[11px] text-mute hover:text-ink"><Plug size={12} /><span className="label-f">MCP</span><span className="num">{toolCount ?? '—'}</span></button>
              {meta?.demo && <span className="label-f rounded-xl border border-warn/50 px-1.5 py-0.5 text-warn" title="Sans clé : moteur de démonstration déterministe">Démo</span>}
              {meta?.engine && (
                <span
                  className="label-f max-w-[11rem] truncate rounded-xl border border-edge px-1.5 py-0.5 text-[10px] text-mute"
                  title={`Moteur exécuté : ${meta.engine}`}
                >
                  {meta.semanticEngine ?? 'moteur'}·{(meta.git?.commit ?? meta.engine.split('/').pop())?.slice(0, 7)}
                </span>
              )}
              <span className="flex-1" />
              {job && <Button type="button" variant="danger" size="sm" onClick={cancel}><Square size={11} />Arrêter</Button>}
              <Button type="submit" variant="primary" size="sm" disabled={!text.trim() || !!job}>{currentId ? 'Envoyer' : 'Générer'}</Button>
            </div>
          </form>
        </aside>
      )}
      <McpDialog open={mcpOpen} onOpenChange={setMcpOpen} onChanged={loadTools} />
    </div>
  );
}
