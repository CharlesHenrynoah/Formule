import logoUrl from '../assets/logo.svg';
import { Plus, Trash2, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import type { ProjectSummary } from '../types';

type Props = {
  projects: ProjectSummary[];
  currentId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onJournal: () => void;
};

const fmt = (iso: string) => new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export function Sidebar({ projects, currentId, onOpen, onNew, onDelete, onJournal }: Props) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r bg-card/40">
      <div className="p-4">
        <div className="flex h-9 items-center">
          <img src={logoUrl} alt="FORMULE" className="h-auto max-h-9 w-full object-contain object-left" data-testid="logo" />
        </div>
        <Button onClick={onNew} className="f1-para f1-metal f1-keep-shadow mx-1 mt-4 h-8 w-[calc(100%-8px)] gap-1.5 px-3 text-[13px] font-medium" data-testid="new-interface"><Plus /><span>New Interface</span></Button>
      </div>
      <Separator />
      <div className="px-4 pt-3">
        <Button variant="ghost" asChild className="h-8 w-full justify-start px-3 text-[13px]">
          <a href="/journal" data-testid="open-journal" onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; e.preventDefault(); onJournal(); }}>Journal</a>
        </Button>
      </div>
      <div className="flex items-center gap-1.5 px-4 pt-3 pb-1 text-[11px] uppercase tracking-wider text-muted-foreground">
        <History className="size-3" /> Historique
      </div>
      <div className="f1-no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4" data-testid="history">
        {projects.length === 0 && <div className="px-2 py-6 text-xs text-muted-foreground">Aucune app pour l'instant.</div>}
        {projects.map((p) => (
          <div
            key={p.id}
            onClick={() => onOpen(p.id)}
            className={cn('group mb-1 cursor-pointer rounded-lg border px-3 py-2 transition-colors',
              p.id === currentId ? 'border-border bg-accent' : 'border-transparent hover:bg-accent/50')}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="truncate text-sm">{p.title}</div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="icon-xs" className="opacity-0 group-hover:opacity-100" onClick={(e) => e.stopPropagation()} title="Supprimer">
                    <Trash2 />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Supprimer « {p.title} » ?</AlertDialogTitle>
                    <AlertDialogDescription>Toutes ses versions seront effacées définitivement.</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Annuler</AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => onDelete(p.id)}>Supprimer</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
              <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">{p.version_count} version{p.version_count > 1 ? 's' : ''}</Badge>
              <span>{fmt(p.updated_at)}</span>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
