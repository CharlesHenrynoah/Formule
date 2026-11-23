/**
 * Error boundary par panneau : une erreur de rendu (ex. React #130, composant undefined) n'éteint plus toute l'app.
 * Le panneau fautif affiche « Ce panneau a une erreur » + un bouton qui envoie l'erreur (dé-minifiée) au contremaître
 * pour qu'il lance une correction par l'équipe (evolve_app). L'erreur est aussi remontée au studio (postMessage)
 * et au smoke render (window.__ES_ERRORS).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

const MSG: Record<string, string> = {
  '130': 'un composant utilisé dans le JSX vaut undefined (icône lucide inexistante, export nommé/par défaut inversé, sous-composant non exporté ou propriété mal nommée comme <p.Icon /> au lieu de <p.icon />)',
  '31': 'un objet est rendu directement dans le JSX (affiche un champ ou JSON.stringify)',
  '185': 'boucle infinie de mises à jour (setState dans un effet sans condition)',
  '301': 'trop de rendus (setState appelé pendant le rendu)',
  '300': 'hooks appelés conditionnellement', '310': 'hooks appelés conditionnellement',
};
/** « Minified React error #130; visit …?args[]=undefined » → message lisible. */
export function explainReactError(message: string): string {
  const m = /Minified React error #(\d+)(?:;\s*visit\s+(\S+))?/.exec(String(message ?? ''));
  if (!m) return String(message ?? '');
  let args: string[] = [];
  try { args = m[2] ? new URL(m[2]).searchParams.getAll('args[]') : []; } catch { /* ignore */ }
  return `React #${m[1]} : ${MSG[m[1]] ?? 'erreur React'}${args.filter(Boolean).length ? ` (reçu : ${args.filter(Boolean).join(', ')})` : ''}`;
}

type Props = { name?: string; children: ReactNode; compact?: boolean; onAsk?: (text: string) => void; fallback?: ReactNode };
type State = { error: Error | null; stack: string; asked: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '', asked: false };
  static getDerivedStateFromError(error: Error): Partial<State> { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    const stack = String(info?.componentStack ?? '').split('\n').map((l) => l.trim().replace(/^at\s+/, '').replace(/\s*\(.*\)$/, '')).filter(Boolean).slice(0, 8).join(' ← ');
    this.setState({ stack });
    const message = explainReactError(error?.message ?? String(error));
    try { ((window as any).__ES_ERRORS ??= []).push({ message: `${this.props.name ? `[${this.props.name}] ` : ''}${error?.message ?? error}`, stack }); } catch { /* ignore */ }
    try { window.parent?.postMessage({ __es: 'app:error', message: error?.message ?? String(error), explained: message, panel: this.props.name ?? '', componentStack: stack }, '*'); } catch { /* ignore */ }
  }
  private ask = () => {
    const ask = this.props.onAsk ?? (window as any).__ES_ASK;
    if (!ask || !this.state.error) return;
    const msg = explainReactError(this.state.error.message);
    ask(`Le panneau « ${this.props.name ?? 'app'} » de l'app plante : ${msg}${this.state.stack ? `\nComposants : ${this.state.stack}` : ''}\nMessage brut : ${this.state.error.message.slice(0, 300)}\nCorrige ce bug dans le code de l'app (evolve_app) sans rien changer d'autre.`);
    this.setState({ asked: true });
  };
  private retry = () => this.setState({ error: null, stack: '', asked: false });
  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    const canAsk = !!(this.props.onAsk ?? (typeof window !== 'undefined' && (window as any).__ES_ASK));
    return (
      <div role="alert" data-testid="panel-error" className={`rounded-md border border-rose-500/40 bg-rose-500/10 text-red-700 ${this.props.compact ? 'p-2 text-[11px]' : 'p-3 text-xs'}`}>
        <div className="font-semibold">⚠️ Ce panneau a une erreur</div>
        <div className="mt-1 text-red-700">{explainReactError(this.state.error.message).slice(0, 280)}</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {canAsk && <button type="button" data-testid="ask-fix" disabled={this.state.asked} onClick={this.ask} className="rounded border border-red-600/50 bg-red-500/10 px-2 py-1 font-medium hover:bg-red-500/10 disabled:opacity-60">{this.state.asked ? 'Demande envoyée au contremaître ✓' : 'Demander au contremaître de corriger'}</button>}
          <button type="button" onClick={this.retry} className="rounded border border-border px-2 py-1 text-foreground/80 hover:bg-black/[0.03]">Réessayer</button>
        </div>
      </div>
    );
  }
}
