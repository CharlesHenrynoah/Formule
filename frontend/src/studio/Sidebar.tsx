import { useState } from 'react';
import { BookText, Copy, Download, Archive, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import type { Project } from '../lib/api';
import { cn, fmtDate } from '../lib/utils';

export function Logo({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2 select-none', className)}>
      <svg viewBox="0 0 32 32" className="h-6 w-6"><circle cx="16" cy="16" r="15" fill="#fff" /><path d="M11 23 14 9h9l-.8 3.5H17l-.7 3.2h4.6l-.7 3.3h-4.6L14.6 23z" fill="#000" /></svg>
      <span className="text-[17px] font-semibold tracking-tight">FORMULE</span>
    </div>
  );
}

export function Sidebar(p: {
  projects: Project[]; currentId: string | null; onNew: () => void; onOpen: (id: string) => void; onJournal: () => void;
  onDelete: (id: string) => Promise<void>; onRename: (id: string, t: string) => Promise<void>; onDuplicate: (id: string) => Promise<void>; onArchive: (id: string, a: boolean) => Promise<void>;
}) {
  const [confirm, setConfirm] = useState<Project | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const list = p.projects.filter((x) => !!x.archived === showArchived);
  return (
    <aside className="glass flex w-64 shrink-0 flex-col border-r border-edge">
      <div className="px-4 pb-3 pt-4"><Logo /></div>
      <div className="px-4"><Button variant="metal" size="lg" className="w-full h-10" onClick={p.onNew}><Plus size={15} /><span className="text-[13px] font-medium">New Interface</span></Button></div>
      <button onClick={p.onJournal} className="mx-4 mt-3 flex items-center gap-2 rounded-xl px-2 py-1.5 text-mute hover:text-ink"><BookText size={14} /><span className="label-f">Journal</span></button>
      <div className="mx-4 mt-3 flex items-center justify-between border-t border-edge pt-3">
        <span className="label-f text-faint">{showArchived ? 'Archives' : 'Historique'}</span>
        <button className="text-[11px] text-faint hover:text-mute" onClick={() => setShowArchived(!showArchived)}>{showArchived ? 'Actifs' : 'Archives'}</button>
      </div>
      <nav className="mt-1 flex-1 overflow-y-auto px-2 pb-4" aria-label="Projets">
        {list.length === 0 && <p className="px-2 py-3 text-sm text-faint">{showArchived ? 'Aucune archive.' : 'Aucune app pour l’instant.'}</p>}
        {list.map((x) => (
          <div key={x.id} className={cn('group relative rounded-xl border border-transparent', p.currentId === x.id && 'border-edge bg-raised')}>
            <button onClick={() => p.onOpen(x.id)} className="block w-full px-2 py-2 text-left">
              <div className="flex items-center gap-1.5 truncate pr-12 text-[13px]">{p.currentId === x.id && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-petrol" />}<span className="truncate">{x.title}</span></div>
              <div className="mt-0.5 flex gap-2 text-[11px] text-faint"><span className="num">{x.version_count} v.</span><span>{fmtDate(x.updated_at)}</span>{x.demo ? <span className="text-warn/80">démo</span> : null}</div>
            </button>
            <div className="absolute right-1 top-1.5 hidden gap-0.5 group-hover:flex">
              <button aria-label="Plus d’actions" onClick={() => setMenu(menu === x.id ? null : x.id)} className="rounded p-1 text-faint hover:text-ink"><MoreHorizontal size={14} /></button>
              <button aria-label="Supprimer" onClick={() => setConfirm(x)} className="rounded p-1 text-faint hover:text-danger"><Trash2 size={14} /></button>
            </div>
            {menu === x.id && (
              <div className="absolute right-1 top-8 z-20 w-40 rounded-xl border border-edge bg-raised py-1 text-[13px]" onMouseLeave={() => setMenu(null)}>
                <MenuItem icon={<Pencil size={13} />} onClick={async () => { const t = prompt('Nouveau titre', x.title); setMenu(null); if (t?.trim()) await p.onRename(x.id, t.trim()); }}>Renommer</MenuItem>
                <MenuItem icon={<Copy size={13} />} onClick={async () => { setMenu(null); await p.onDuplicate(x.id); }}>Dupliquer</MenuItem>
                <MenuItem icon={<Download size={13} />} onClick={() => { setMenu(null); location.href = `/api/projects/${x.id}/export`; }}>Exporter</MenuItem>
                <MenuItem icon={<Archive size={13} />} onClick={async () => { setMenu(null); await p.onArchive(x.id, !x.archived); }}>{x.archived ? 'Désarchiver' : 'Archiver'}</MenuItem>
              </div>
            )}
          </div>
        ))}
      </nav>
      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)} title="Supprimer l’interface" description={confirm ? `« ${confirm.title} », ses ${confirm.version_count} version(s), sa conversation et ses données lues seront supprimées.` : ''}>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(null)}>Annuler</Button>
          <Button variant="danger" onClick={async () => { const id = confirm!.id; setConfirm(null); await p.onDelete(id); }}>Supprimer</Button>
        </div>
      </Dialog>
    </aside>
  );
}

function MenuItem({ icon, children, onClick }: { icon: React.ReactNode; children: React.ReactNode; onClick: () => void }) {
  return <button onClick={onClick} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-mute hover:bg-panel hover:text-ink">{icon}{children}</button>;
}
