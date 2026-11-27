/**
 * Pont d'exécution contrôlé. L'app est dans une iframe sandbox sans allow-same-origin :
 * elle ne parle qu'au parent, par postMessage. Le parent vérifie event.source et applique la liste blanche.
 */
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
const pending = new Map<string, Pending>();
let seq = 0;
const inFrame = typeof window !== 'undefined' && window.parent !== window;

export type ViewCommand = { op: 'show' | 'hide' | 'focus' | 'reset'; viewId?: string };
const viewListeners = new Set<(c: ViewCommand) => void>();
const refreshListeners = new Set<() => void>();
export type Meta = { certification: { certified: boolean; message: string; label: 'certifiée' | 'partielle' | 'non certifiée' | 'aperçu' }; requirements?: { id: string; status: 'covered' | 'missing' | 'unavailable'; reason?: string }[] };
const metaListeners = new Set<(m: Meta) => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data as { type?: string; id?: string; ok?: boolean; result?: unknown; error?: string; command?: ViewCommand };
    if (m?.type === 'formule:reply' && m.id && pending.has(m.id)) {
      const p = pending.get(m.id)!; pending.delete(m.id); clearTimeout(p.timer);
      if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error ?? 'erreur du pont'));
    } else if (m?.type === 'formule:view' && m.command) viewListeners.forEach((l) => l(m.command!));
    else if (m?.type === 'formule:refresh') refreshListeners.forEach((l) => l());
    else if (m?.type === 'formule:meta' && (m as { meta?: Meta }).meta) metaListeners.forEach((l) => l((m as { meta: Meta }).meta));
  });
}

function request(payload: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
  if (!inFrame) return Promise.reject(new Error('pont indisponible (hors Studio)'));
  const id = `m${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('délai du pont dépassé')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    window.parent.postMessage({ ...payload, id }, '*');
  });
}

export const mcp = {
  call: (name: string, args: Record<string, unknown> = {}) => request({ type: 'formule:mcp', method: 'call', name, args }),
  tools: () => request({ type: 'formule:mcp', method: 'tools' }),
};
export const prepareAction = (actionId: string, args: Record<string, unknown>) => request({ type: 'formule:action', actionId, args }, 600_000);
export const notify = (type: string, payload: Record<string, unknown>) => { if (inFrame) window.parent.postMessage({ type, ...payload }, '*'); };
export const onViewCommand = (l: (c: ViewCommand) => void) => { viewListeners.add(l); return () => { viewListeners.delete(l); }; };
export const onMeta = (l: (m: Meta) => void) => { metaListeners.add(l); return () => { metaListeners.delete(l); }; };
export const onRefresh = (l: () => void) => { refreshListeners.add(l); return () => { refreshListeners.delete(l); }; };

declare global { interface Window { mcp: typeof mcp } }
if (typeof window !== 'undefined') window.mcp = mcp;
