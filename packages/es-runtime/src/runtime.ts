// es-runtime : exécute dans l'iframe sandboxée les mini-apps écrites en JSX + shadcn/ui.
// <script src="/runtime/es-runtime.js"></script> puis <script type="text/jsx"> … export default function App() {…} </script>
import '@tailwindcss/browser';
import { transform } from 'sucrase';
import themeCss from './theme.css?raw';
import animateCss from 'es-css/tw-animate.css?raw';
import shadcnCss from 'es-css/shadcn.css?raw';
import { MODULES, UI, React, ReactDOMClient, Sonner } from './modules';

const VERSION = '1.0.0';

function report(message: string) {
  console.error('[es-runtime]', message);
  try { window.dispatchEvent(new ErrorEvent('error', { message })); } catch { /* ignore */ }
}

function injectStyles() {
  const style = document.createElement('style');
  style.setAttribute('type', 'text/tailwindcss');
  style.setAttribute('data-es-runtime', VERSION);
  style.textContent = [animateCss, shadcnCss, themeCss].join('\n');
  document.head.prepend(style);
}

function requireModule(name: string): unknown {
  if (name in MODULES) return MODULES[name];
  throw new Error(`Module non disponible dans le runtime : « ${name} ». Modules autorisés : react, lucide-react, sonner, @/lib/utils, @/components/ui/<composant>.`);
}

class Boundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { report(error.message); }
  render() {
    if (this.state.error) return React.createElement('pre', { style: { color: '#f87171', padding: 16, whiteSpace: 'pre-wrap', fontSize: 12 } }, 'Erreur dans la mini-app : ' + this.state.error.message);
    return this.props.children;
  }
}

export function compile(source: string): string {
  return transform(source, { transforms: ['jsx', 'typescript', 'imports'], jsxRuntime: 'automatic', production: true, filePath: 'app.tsx' }).code;
}

export function run(source: string) {
  let code: string;
  try { code = compile(source); } catch (e) { report('Erreur de syntaxe JSX : ' + (e as Error).message); return; }
  const module = { exports: {} as Record<string, unknown> };
  try {
    // eslint-disable-next-line no-new-func
    new Function('require', 'module', 'exports', 'React', code)(requireModule, module, module.exports, React);
  } catch (e) { report((e as Error).message); return; }
  const App = (module.exports.default ?? module.exports.App) as React.ComponentType | undefined;
  if (!App) { if (!document.getElementById('root')?.childElementCount) report('Aucun « export default » de composant App trouvé.'); return; }
  let rootEl = document.getElementById('root');
  if (!rootEl) { rootEl = document.createElement('div'); rootEl.id = 'root'; document.body.appendChild(rootEl); }
  const { Toaster } = UI.sonner as { Toaster: React.ComponentType<Record<string, unknown>> };
  const { TooltipProvider } = UI.tooltip as { TooltipProvider: React.ComponentType<{ children: React.ReactNode }> };
  const dark = document.documentElement.classList.contains('dark');
  ReactDOMClient.createRoot(rootEl).render(
    React.createElement(Boundary, null,
      React.createElement(TooltipProvider, null, React.createElement(App), React.createElement(Toaster, { theme: dark ? 'dark' : 'light', position: 'bottom-right' }))),
  );
}

function boot() {
  const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="text/jsx"], script[type="text/babel"]'));
  for (const s of scripts) run(s.textContent ?? '');
}

injectStyles();
(window as unknown as Record<string, unknown>).ESRuntime = { version: VERSION, run, compile, modules: Object.keys(MODULES), components: Object.keys(UI), toast: Sonner.toast };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
