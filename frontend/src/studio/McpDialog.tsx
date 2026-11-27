import { useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Dialog } from '../components/ui/dialog';
import { Button } from '../components/ui/button';
import { api, type CatalogServer, type ServerInfo } from '../lib/api';
import { cn } from '../lib/utils';

const PERMS: { v: string; l: string }[] = [{ v: 'off', l: 'Refusé' }, { v: 'read', l: 'Lecture' }, { v: 'write', l: 'Écriture' }];

export function McpDialog({ open, onOpenChange, onChanged }: { open: boolean; onOpenChange: (o: boolean) => void; onChanged: () => void }) {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [catalog, setCatalog] = useState<CatalogServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', transport: 'http', url: '', token: '' });

  const load = async () => {
    setLoading(true); setErr(null);
    try { const [s, c] = await Promise.all([api<ServerInfo[]>('/api/mcp/servers'), api<CatalogServer[]>('/api/mcp/catalog')]); setServers(s); setCatalog(c); }
    catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  };
  useEffect(() => { if (open) void load(); }, [open]);
  const act = async (f: () => Promise<unknown>) => { setErr(null); try { await f(); await load(); onChanged(); } catch (e) { setErr((e as Error).message); } };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Connexions MCP" description="Seuls les outils cochés sont utilisables. Un outil non classé est refusé. Les annotations du fournisseur ne sont que des indices." className="max-w-2xl">
      {err && <p className="mb-3 rounded-xl border border-danger/50 px-3 py-2 text-sm text-danger">{err}</p>}
      <div className="space-y-3">
        {servers.map((s) => {
          const cat = catalog.find((c) => c.serverId === s.id);
          return (
            <div key={s.id} className="rounded-xl border border-edge">
              <div className="flex items-center gap-2 border-b border-edge px-3 py-2">
                <span className={cn('h-2 w-2 rounded-full', cat?.status === 'connected' ? 'bg-petrol' : cat?.status === 'error' ? 'bg-danger' : 'bg-faint')} />
                <span className="text-sm">{s.name}</span>
                <span className="num text-[11px] text-faint">{s.id} · {s.transport}</span>
                {s.demo && <span className="text-[11px] text-warn">démo</span>}
                {s.hasToken && <span className="num text-[11px] text-faint">jeton {s.tokenMask}</span>}
                <div className="ml-auto flex items-center gap-1">
                  <label className="flex items-center gap-1.5 text-xs text-mute"><input type="checkbox" checked={s.enabled} onChange={(e) => act(() => api(`/api/mcp/servers/${s.id}`, { method: 'PATCH', body: { enabled: e.target.checked } }))} className="accent-[#00A19C]" />Actif</label>
                  {s.transport !== 'files' && <button aria-label="Reconnecter" className="p-1 text-faint hover:text-ink" onClick={() => act(() => api(`/api/mcp/servers/${s.id}/reconnect`, { body: {} }))}><RefreshCw size={13} /></button>}
                  {s.transport !== 'files' && <button aria-label="Retirer" className="p-1 text-faint hover:text-danger" onClick={() => confirm(`Retirer ${s.name} ?`) && act(() => api(`/api/mcp/servers/${s.id}`, { method: 'DELETE' }))}><Trash2 size={13} /></button>}
                </div>
              </div>
              {cat?.status === 'error' && <p className="px-3 py-2 text-xs text-danger">{cat.error?.kind} : {cat.error?.message}</p>}
              {cat && cat.tools.length > 0 && (
                <ul className="divide-y divide-edge">
                  {cat.tools.map((t) => (
                    <li key={t.name} className="flex items-center gap-3 px-3 py-1.5">
                      <div className="min-w-0 flex-1"><div className="num truncate text-[12px]">{t.name}</div><div className="truncate text-[11px] text-faint">{t.description} · {t.hint}</div></div>
                      {s.transport === 'files' ? <span className="text-[11px] text-mute">Lecture</span> : (
                        <select aria-label={`Permission ${t.name}`} value={t.permission === 'unclassified' ? 'off' : t.permission} onChange={(e) => act(() => api(`/api/mcp/servers/${s.id}`, { method: 'PATCH', body: { tools: { [t.name]: e.target.value } } }))}
                          className={cn('rounded-xl border border-edge bg-bg px-1.5 py-0.5 text-xs', t.permission === 'write' && 'text-warn', t.permission === 'read' && 'text-petrol')}>
                          {PERMS.map((p) => <option key={p.v} value={p.v}>{p.l}</option>)}
                        </select>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {cat && cat.resources.length > 0 && <p className="border-t border-edge px-3 py-1.5 text-[11px] text-faint">Ressources (documentation, jamais des mesures) : {cat.resources.map((r) => r.name).join(', ')}</p>}
            </div>
          );
        })}
        {loading && <p className="text-sm text-mute">Lecture du catalogue…</p>}
      </div>
      <form className="mt-4 grid grid-cols-2 gap-2 border-t border-edge pt-4" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api('/api/mcp/servers', { body: form }); setForm({ name: '', transport: 'http', url: '', token: '' }); }); }}>
        <span className="label-f col-span-2 text-mute">Ajouter une connexion distante</span>
        <input required placeholder="Nom" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="rounded-xl border border-edge bg-bg px-2 py-1.5 text-sm" />
        <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value })} className="rounded-xl border border-edge bg-bg px-2 py-1.5 text-sm"><option value="http">HTTP streamable</option><option value="sse">SSE</option></select>
        <input required type="url" placeholder="https://serveur/mcp" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="col-span-2 rounded-xl border border-edge bg-bg px-2 py-1.5 text-sm" />
        <input type="password" autoComplete="off" placeholder="Jeton Bearer (facultatif)" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} className="col-span-2 rounded-xl border border-edge bg-bg px-2 py-1.5 text-sm" />
        <div className="col-span-2 flex justify-end"><Button type="submit" variant="primary" size="sm"><Plus size={13} />Ajouter</Button></div>
      </form>
    </Dialog>
  );
}
