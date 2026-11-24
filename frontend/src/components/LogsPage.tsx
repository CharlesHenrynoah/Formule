import { useEffect, useState } from 'react';
import { api } from '../api';

export type GenLog = { at: string; component: string; step: string; level: 'info' | 'ok' | 'error'; text: string };
export type GenSummary = { id: string; prompt: string; status: string; started_at: string; ended_at: string; count: number; components: string[] };

type Props = { live: { prompt: string; lines: GenLog[] } | null; stamp: string };

const clock = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.${ms}`;
};

const day = (iso: string) => new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function groupsOf(lines: GenLog[]) {
  const groups: Array<{ component: string; lines: GenLog[] }> = [];
  for (const line of lines) {
    const found = groups.find((group) => group.component === line.component);
    if (found) found.lines.push(line);
    else groups.push({ component: line.component, lines: [line] });
  }
  return groups;
}

function Lines({ lines }: { lines: GenLog[] }) {
  const groups = groupsOf(lines);
  if (!groups.length) return <p className="px-4 py-8 text-sm text-muted-foreground">Aucune ligne pour cette génération.</p>;
  return (
    <div className="space-y-6 px-4 py-4">
      {groups.map((group) => (
        <section key={group.component} data-testid="log-component">
          <h3 className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">{group.component}</h3>
          <ol className="space-y-1">
            {group.lines.map((line, index) => (
              <li key={`${line.at}-${index}`} className="grid grid-cols-[7.5rem_8rem_1fr] gap-2 font-mono text-[12px] leading-5">
                <time className="text-muted-foreground">{clock(line.at)}</time>
                <span>{line.step}</span>
                <span className={line.level === 'error' ? 'text-destructive' : ''}>{line.text || '—'}</span>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

export function LogsPage({ live, stamp }: Props) {
  const [list, setList] = useState<GenSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [lines, setLines] = useState<GenLog[]>([]);
  const [title, setTitle] = useState('');

  useEffect(() => {
    let stop = false;
    api.logs().then((rows) => { if (!stop) setList(rows as GenSummary[]); }).catch(() => { if (!stop) setList([]); });
    return () => { stop = true; };
  }, [stamp]);

  useEffect(() => {
    if (!selected) return;
    let stop = false;
    api.log(selected).then((row) => {
      if (stop) return;
      setTitle(String(row.prompt ?? ''));
      setLines(Array.isArray(row.lines) ? row.lines as GenLog[] : []);
    }).catch(() => { if (!stop) setLines([]); });
    return () => { stop = true; };
  }, [selected]);

  const showingLive = !!live && !selected;

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-md border bg-background" data-testid="logs-page">
      <aside className="flex w-72 shrink-0 flex-col border-r">
        <div className="px-4 py-3 text-[11px] uppercase tracking-wider text-muted-foreground">Générations</div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {live && (
            <button type="button" onClick={() => setSelected(null)} className={`mb-1 w-full rounded-md border px-3 py-2 text-left ${showingLive ? 'border-border bg-accent' : 'border-transparent'}`}>
              <div className="truncate text-sm">{live.prompt || 'Génération en cours'}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">en cours · {live.lines.length} lignes</div>
            </button>
          )}
          {list.length === 0 && !live && <p className="px-2 py-6 text-xs text-muted-foreground">Aucune génération journalisée.</p>}
          {list.map((row) => (
            <button key={row.id} type="button" data-testid="log-run" onClick={() => setSelected(row.id)}
              className={`mb-1 w-full rounded-md border px-3 py-2 text-left ${selected === row.id ? 'border-border bg-accent' : 'border-transparent hover:bg-accent/50'}`}>
              <div className="truncate text-sm">{row.prompt}</div>
              <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
                <span>{row.status} · {row.count}</span>
                <span>{day(row.started_at)}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="border-b px-4 py-3">
          <div className="truncate text-sm">{showingLive ? (live?.prompt || 'Génération en cours') : (title || 'Choisis une génération')}</div>
        </div>
        {showingLive ? <Lines lines={live.lines} /> : selected ? <Lines lines={lines} /> : <p className="px-4 py-8 text-sm text-muted-foreground">Chaque génération laisse une trace par composant, horodatée.</p>}
      </div>
    </div>
  );
}
