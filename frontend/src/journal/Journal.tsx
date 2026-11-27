import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { api, type JobEvent } from '../lib/api';
import { Logo } from '../studio/Sidebar';
import { cn, fmtTime } from '../lib/utils';

interface Job { id: string; project_id: string | null; kind: string; state: string; mode: string; prompt: string; created_at: string; updated_at: string }
const RUNNING = ['DRAFT', 'DISCOVERY', 'CONTRACT', 'BUILD', 'CERTIFICATION', 'REPAIR', 'READY'];

/** Journal : déroulé réel des générations (événements persistés). Pas de chaîne de pensée simulée. */
export function Journal({ go }: { go: (p: string) => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  useEffect(() => {
    const load = () => api<Job[]>('/api/jobs').then((j) => { setJobs(j); setSel((s) => s ?? j[0]?.id ?? null); }).catch(() => {});
    void load(); const t = setInterval(load, 2500); return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!sel) return;
    const load = () => api<JobEvent[]>(`/api/jobs/${sel}/log`).then(setEvents).catch(() => {});
    void load(); const t = setInterval(load, 1500); return () => clearInterval(t);
  }, [sel]);
  const job = jobs.find((j) => j.id === sel);
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-6 border-b border-edge bg-panel px-5 py-3">
        <Logo />
        <button onClick={() => go('/')} className="flex items-center gap-1.5 text-mute hover:text-ink"><ArrowLeft size={14} /><span className="label-f">Studio</span></button>
        <span className="label-f ml-auto text-faint">Journal</span>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav className="w-80 shrink-0 overflow-y-auto border-r border-edge" aria-label="Générations">
          {jobs.length === 0 && <p className="p-4 text-sm text-faint">Aucune génération.</p>}
          {jobs.map((j) => (
            <button key={j.id} onClick={() => setSel(j.id)} className={cn('block w-full border-b border-edge px-4 py-2.5 text-left', sel === j.id && 'bg-raised')}>
              <div className="flex items-center gap-2">
                <span className={cn('h-1.5 w-1.5 rounded-full', RUNNING.includes(j.state) ? 'bg-petrol' : j.state === 'ACTIVE' || j.state === 'DONE' ? 'bg-ink' : j.state === 'DEGRADED' ? 'bg-warn' : 'bg-danger')} />
                <span className="num text-[11px] text-mute">{j.state}</span>
                <span className="ml-auto num text-[11px] text-faint">{new Date(j.created_at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
              <div className="mt-1 line-clamp-2 text-[13px]">{j.prompt}</div>
            </button>
          ))}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto p-5">
          {job && (
            <>
              <h1 className="text-[15px]">{job.prompt}</h1>
              <p className="num mt-1 text-[11px] text-faint">{job.id} · {job.kind} · mode {job.mode} · état {job.state}</p>
              <ol className="mt-4 space-y-1">
                {events.map((e) => (
                  <li key={e.eventId} className="grid grid-cols-[4.5rem_8rem_1fr] gap-3 text-[12.5px]">
                    <span className="num text-faint">{fmtTime(e.timestamp)}</span>
                    <span className={cn('num', e.type === 'error' ? 'text-danger' : e.type === 'certification' ? 'text-petrol' : 'text-mute')}>{e.type}</span>
                    <span className="min-w-0 break-words text-ink/90">{describe(e)}</span>
                  </li>
                ))}
              </ol>
              {events.filter((e) => e.type === 'certification').map((e) => (
                <section key={e.eventId} className="mt-5 rounded-xl border border-edge">
                  <div className="label-f border-b border-edge px-3 py-2">Certification v{e.payload.version} · {e.payload.certified ? 'certifiée' : 'non certifiée'}</div>
                  <ul className="divide-y divide-edge">
                    {(e.payload.gates as { gate: string; passed: boolean; details: string[] }[]).map((g) => (
                      <li key={g.gate} className="flex gap-3 px-3 py-1.5 text-[12.5px]"><span className={cn('num w-8', g.passed ? 'text-petrol' : 'text-danger')}>{g.gate}</span><span className="text-mute">{g.details.join(' · ')}</span></li>
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function describe(e: JobEvent): string {
  const p = e.payload;
  switch (e.type) {
    case 'job.state': return `${p.from} → ${p.to}${p.step ? ` (${p.step})` : ''}`;
    case 'source': return `${p.sources.map((s: any) => `${s.server} · ${s.tool} : ${s.status}${s.rows != null ? `, ${s.rows} lignes` : ''}`).join(' ; ')} — ${p.requirements.filter((r: any) => r.status === 'covered').length}/${p.requirements.length} exigences lisibles`;
    case 'certification': return p.message;
    case 'published': return `version v${p.version} publiée${p.partial ? ' (partielle)' : ''}`;
    case 'job.created': return p.prompt;
    default: return p.text ?? p.message ?? JSON.stringify(p);
  }
}
