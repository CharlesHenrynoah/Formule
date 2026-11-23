/**
 * Composition d'un tableau de bord, prise sur shadcn-admin
 * (en-tête, quatre mesures, graphique large, liste à côté).
 * Pas de barre latérale : ni Sidebar, ni SidebarTrigger.
 * Les chiffres affichés viennent des outils, jamais d'exemples figés.
 */
import type { ReactNode } from 'react';

export function BoardStack({ children }: { children: ReactNode }) {
  return <div className="space-y-4 px-4 py-6">{children}</div>;
}

export function BoardHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      {children ? <div className="flex items-center gap-2">{children}</div> : null}
    </div>
  );
}

export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}

export function MetricCard({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-xl border bg-card text-card-foreground shadow-sm">
      <div className="flex flex-row items-center justify-between p-6 pb-2">
        <div className="text-sm font-medium">{label}</div>
      </div>
      <div className="px-6 pb-6">
        <div className="text-2xl font-bold">{value}</div>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}

export function BoardSplit({ chart, side }: { chart: ReactNode; side: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-7">
      <div className="col-span-1 rounded-xl border bg-card p-6 lg:col-span-4">{chart}</div>
      <div className="col-span-1 rounded-xl border bg-card p-6 lg:col-span-3">{side}</div>
    </div>
  );
}
