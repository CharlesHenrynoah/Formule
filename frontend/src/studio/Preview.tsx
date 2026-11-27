import { forwardRef, useEffect } from 'react';
import { AlertTriangle, Maximize2, Minimize2 } from 'lucide-react';
import { Logo } from './Sidebar';
import { cn } from '../lib/utils';

export interface PreviewProps {
  src: string | null; building: boolean; fullscreen: boolean; setFullscreen: (f: boolean) => void;
  tabs: { id: string; title: string }[]; tab: string; setTab: (t: string) => void;
  appError: string | null; onFix: () => void; label: string | null;
}

/** Iframe sandbox SANS allow-same-origin : l'app n'a ni cookies, ni accès au Studio, ni réseau (CSP). */
export const Preview = forwardRef<HTMLIFrameElement, PreviewProps>(function Preview(p, ref) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === 'Escape' && p.fullscreen) p.setFullscreen(false); };
    addEventListener('keydown', f); return () => removeEventListener('keydown', f);
  }, [p.fullscreen, p.setFullscreen]);

  return (
    <section className={cn('relative flex min-w-0 flex-1 flex-col bg-bg', p.fullscreen && 'fixed inset-0 z-30')}>
      {p.src && p.tabs.length > 1 && (
        <div role="tablist" className="flex gap-1 border-b border-edge bg-panel px-3 pt-2">
          {[{ id: 'interface', title: 'Interface' }, ...p.tabs].map((t) => (
            <button key={t.id} role="tab" aria-selected={p.tab === t.id} onClick={() => p.setTab(t.id)}
              className={cn('label-f rounded-t-xl border border-b-0 px-3 py-1.5', p.tab === t.id ? 'border-edge bg-bg text-ink' : 'border-transparent text-faint hover:text-mute')}>{t.title}</button>
          ))}
        </div>
      )}
      <div className="relative flex-1">
        {p.src ? (
          <iframe ref={ref} key={p.src} title="Interface générée" src={p.src} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" className="absolute inset-0 h-full w-full border-0 bg-[#111111]" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <Logo className="opacity-80" />
            {p.building ? (
              <div className="flex items-center gap-3 text-mute"><span className="diamond pulse" /> L’interface se construit…</div>
            ) : (
              <p className="max-w-sm text-mute">Décris l’interface. Les agents la construisent et l’enregistrent.</p>
            )}
          </div>
        )}
        {p.src && p.building && (
          <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-xl border border-edge bg-panel/90 px-2.5 py-1 text-xs text-mute"><span className="diamond pulse" /> Nouvelle version en construction — celle-ci reste en place</div>
        )}
        {p.src && p.label && p.label !== 'certifiée' && (
          <div className="pointer-events-none absolute right-3 top-3 rounded-xl border border-warn/50 bg-panel/90 px-2 py-0.5 text-[11px] text-warn">{p.label === 'aperçu' ? 'Aperçu non certifié · aucune action externe' : p.label === 'partielle' ? 'Livraison partielle' : 'Non certifiée'}</div>
        )}
        {p.src && (
          <button aria-label={p.fullscreen ? 'Quitter le plein écran' : 'Plein écran'} onClick={() => p.setFullscreen(!p.fullscreen)}
            className="absolute bottom-3 right-3 rounded-xl border border-edge bg-panel/90 p-1.5 text-mute hover:text-ink">{p.fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
        )}
      </div>
      {p.appError && (
        <div role="alert" className="flex items-center gap-3 border-t border-danger/60 bg-danger/10 px-4 py-2 text-sm text-danger">
          <AlertTriangle size={15} /><span className="flex-1 truncate">L’interface a rencontré une erreur : {p.appError}</span>
          <button onClick={p.onFix} className="text-ink underline-offset-2 hover:underline">Demander à Formule Agent de corriger</button>
        </div>
      )}
    </section>
  );
});
