import { useEffect, useState } from 'react';
import { RefreshCw, Trash2, Plus, Server, KeyRound, ChevronDown, Lock, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api';
import { isAuthError, parseHeaderLines } from '../lib/mcpAuth';
import { Textarea } from '@/components/ui/textarea';
import type { McpServer } from '../types';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardAction } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { shortDescription } from '../lib/text';

type Props = { open: boolean; onOpenChange: (o: boolean) => void; onChanged: () => void };

/** Édition du jeton d'un serveur existant (remplacer / supprimer) : la valeur ne revient jamais du serveur. */
function TokenEditor({ s, busy, onSave, open: openInit }: { s: McpServer; busy: boolean; open?: boolean; onSave: (patch: { token?: string | null; headers?: Record<string, string> | null }) => void }) {
  const [open, setOpen] = useState(!!openInit);
  const [token, setToken] = useState('');
  const [adv, setAdv] = useState(false);
  const [hdrs, setHdrs] = useState('');
  const a = s.auth;
  useEffect(() => { if (openInit) setOpen(true); }, [openInit]);
  if (s.transport === 'stdio') return null;
  return (
    <div className="mt-2 rounded-lg border border-dashed px-2 py-1.5 text-xs" data-testid={`mcp-auth-${s.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="size-3.5 text-muted-foreground" />
        {a?.bearer
          ? <Badge variant="secondary" className="font-mono"><Lock /> jeton enregistré {a.tokenHint ?? '••••'}{a.source === 'env' ? ' · .env' : ''}</Badge>
          : <span className="text-muted-foreground">aucun jeton</span>}
        {a?.headerNames.length ? <Badge variant="outline" className="font-mono">en-têtes : {a.headerNames.join(', ')}</Badge> : null}
        <Button variant="ghost" size="xs" className="ml-auto" onClick={() => setOpen((o) => !o)} data-testid={`mcp-auth-edit-${s.id}`}>{a?.bearer ? 'Remplacer le jeton' : 'Ajouter un jeton'}</Button>
        {(a?.bearer || a?.headerNames.length) && a?.source !== 'env' ? <Button variant="ghost" size="xs" className="text-destructive" disabled={busy} onClick={() => onSave({ token: null, headers: null })}>Supprimer</Button> : null}
      </div>
      {open && (
        <div className="mt-2 grid gap-2">
          <Input type="password" autoComplete="off" spellCheck={false} placeholder="Jeton (Bearer) — collé ici, jamais dans le chat" value={token} onChange={(e) => setToken(e.target.value)} data-testid={`mcp-token-${s.id}`} />
          <button type="button" className="flex items-center gap-1 text-left text-muted-foreground hover:text-foreground" onClick={() => setAdv((x) => !x)}><ChevronDown className={adv ? 'size-3' : 'size-3 -rotate-90'} /> En-têtes personnalisés (avancé)</button>
          {adv && <Textarea rows={2} spellCheck={false} placeholder={'X-Api-Key: …\nX-Org: …'} value={hdrs} onChange={(e) => setHdrs(e.target.value)} className="font-mono text-xs" />}
          <div className="flex justify-end gap-2">
            <Button size="sm" disabled={busy || (!token.trim() && !hdrs.trim())} onClick={() => {
              try {
                const patch: { token?: string; headers?: Record<string, string> } = {};
                if (token.trim()) patch.token = token.trim();
                if (hdrs.trim()) patch.headers = parseHeaderLines(hdrs);
                onSave(patch); setToken(''); setHdrs(''); setOpen(false);
              } catch (e) { toast.error((e as Error).message); }
            }} data-testid={`mcp-token-save-${s.id}`}>Enregistrer et reconnecter</Button>
          </div>
        </div>
      )}
    </div>
  );
}

const STATUS_FR: Record<string, string> = { connected: 'connecté', connecting: 'connexion…', error: 'erreur', disabled: 'désactivé' };
const PHASE_FR: Record<string, string> = { degraded: 'dégradé', disconnected: 'coupé', reconnecting: 'reconnexion…', verifying: 'vérification…', failed: 'interrompu' };

export function McpPanel({ open, onOpenChange, onChanged }: Props) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [busy, setBusy] = useState(false);
  const EMPTY = { id: '', name: '', transport: 'http', url: '', command: '', args: '', token: '', headers: '' };
  const [form, setForm] = useState(EMPTY);
  const [advanced, setAdvanced] = useState(false);

  const load = () => api.mcpServers().then(setServers).catch((e) => toast.error(e.message));
  useEffect(() => { if (open) load(); }, [open]);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); await load(); onChanged(); if (ok) toast.success(ok); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };

  const toggleTool = (s: McpServer, tool: string, on: boolean) => {
    const current = s.allowedTools === '*' || s.allowedTools === undefined ? s.tools.map((t) => t.name) : s.allowedTools ?? [];
    const next = on ? [...new Set([...current, tool])] : current.filter((t) => t !== tool);
    // Tous cochés → "*" (défaut ouvert) ; liste partielle ou vide = restriction explicite.
    const allowedTools: string[] | '*' = next.length > 0 && next.length === s.tools.length ? '*' : next;
    run(() => api.mcpPatch(s.id, { allowedTools }));
  };

  const add = () => run(async () => {
    const cfg: Record<string, unknown> = { id: form.id.trim(), name: form.name.trim() || form.id.trim(), transport: form.transport, enabled: true, allowedTools: '*' };
    if (form.transport === 'stdio') { cfg.command = form.command.trim(); cfg.args = form.args.trim() ? form.args.trim().split(/\s+/) : []; }
    else {
      cfg.url = form.url.trim();
      if (form.token.trim()) cfg.token = form.token.trim(); // envoyé une fois au mcp-hub, stocké côté serveur (chmod 600), jamais renvoyé
      if (form.headers.trim()) cfg.headers = parseHeaderLines(form.headers);
    }
    const r = await api.mcpAdd(cfg);
    setForm(EMPTY); setAdvanced(false);
    if (r?.status === 'error' && r?.error) toast.error(r.error);
  }, 'Serveur ajouté');

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl" data-testid="mcp-panel">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2"><Server className="size-4" /> Serveurs MCP</SheetTitle>
          <SheetDescription>Outils exposés au moteur IA et aux mini-apps. À l’ajout, tous les outils sont autorisés ; les écritures demandent toujours confirmation.</SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1 px-4 pb-4">
          <div className="space-y-3">
            {servers.map((s) => (
              <Card key={s.id} size="sm">
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2">
                    {s.name ?? s.id}
                    <Badge variant={s.phase === 'failed' || s.status === 'error' ? 'destructive' : s.status === 'connected' ? 'secondary' : 'outline'} className={s.status === 'connected' && s.phase !== 'degraded' ? 'text-emerald-400' : ''} data-testid={`mcp-phase-${s.id}`}>{PHASE_FR[s.phase ?? ''] ?? STATUS_FR[s.status] ?? s.status}</Badge>
                  </CardTitle>
                  <CardDescription className="font-mono text-[11px]">{s.id} · {s.transport} · {s.transport === 'stdio' ? `${s.command} ${(s.args ?? []).join(' ')}` : s.url}</CardDescription>
                  <CardAction className="flex items-center gap-2">
                    <Label className="text-xs text-muted-foreground">
                      <Switch checked={s.enabled} disabled={busy} onCheckedChange={(v) => run(() => api.mcpPatch(s.id, { enabled: v }))} /> activé
                    </Label>
                    <Button variant="outline" size="icon-sm" disabled={busy} onClick={() => run(() => api.mcpReconnect(s.id), 'Reconnecté')} title="Reconnecter"><RefreshCw /></Button>
                    <Button variant="destructive" size="icon-sm" disabled={busy} onClick={() => run(() => api.mcpDelete(s.id), 'Serveur retiré')} title="Retirer"><Trash2 /></Button>
                  </CardAction>
                </CardHeader>
                {s.transport !== 'stdio' && (
                  <CardContent className={s.error || s.tools.length ? 'pb-0' : ''}>
                    <TokenEditor s={s} busy={busy} open={isAuthError(s.error)} onSave={(patch) => run(async () => { const r = await api.mcpPatch(s.id, patch); if (r?.status === 'error') throw new Error(r.error); }, 'Authentification enregistrée · reconnecté')} />
                  </CardContent>
                )}
                {(s.error || s.tools.length > 0) && (
                  <CardContent>
                    {s.error && (isAuthError(s.error)
                      ? <div className="mb-2 flex items-start gap-1.5 rounded-md border border-zinc-700 bg-white/5 p-2 text-xs text-zinc-300" data-testid="mcp-auth-error"><ShieldAlert className="mt-0.5 size-3.5 shrink-0" /><span>{s.error}</span></div>
                      : <div className="mb-2 text-xs text-destructive">{s.error}</div>)}
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2" data-testid="mcp-tools">
                      {s.tools.map((t) => (
                        <label key={t.name} title={`${t.name}\n\n${t.description ?? ''}`} data-testid="mcp-tool"
                          className="flex h-[60px] min-w-0 items-start gap-2 overflow-hidden rounded-lg bg-muted/50 px-2 py-1.5 text-xs">
                          <Checkbox checked={t.allowed} disabled={busy} onCheckedChange={(v) => toggleTool(s, t.name, v === true)} className="mt-0.5 shrink-0" />
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="min-w-0 truncate font-mono text-zinc-300">{t.name}</span>
                              {t.write ? <Badge className="h-4 shrink-0 bg-zinc-900/60 px-1 text-[10px] text-zinc-300">écriture</Badge> : <Badge variant="secondary" className="h-4 shrink-0 px-1 text-[10px]">lecture</Badge>}
                            </span>
                            <span className="line-clamp-2 break-words text-[11px] leading-snug text-muted-foreground">{shortDescription(t.description)}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </CardContent>
                )}
              </Card>
            ))}

            <Card size="sm" className="border border-dashed ring-0">
              <CardHeader><CardTitle>Ajouter un serveur</CardTitle>
                <CardDescription>Tous les outils sont autorisés par défaut ; décochez ceux à restreindre.</CardDescription></CardHeader>
              <CardContent className="grid grid-cols-2 gap-2">
                <Input placeholder="id (ex. github)" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
                <Input placeholder="Nom affiché" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                <Select value={form.transport} onValueChange={(v) => setForm({ ...form, transport: v })}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">HTTP streamable</SelectItem>
                    <SelectItem value="sse">SSE (ancien)</SelectItem>
                    <SelectItem value="stdio">stdio (commande locale)</SelectItem>
                  </SelectContent>
                </Select>
                {form.transport === 'stdio' ? (
                  <div className="flex gap-2">
                    <Input className="w-1/3" placeholder="npx" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
                    <Input placeholder="arguments" value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
                  </div>
                ) : (
                  <Input placeholder="https://…/mcp" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} data-testid="mcp-url" />
                )}
                {form.transport !== 'stdio' && (
                  <>
                    <div className="col-span-2 grid gap-1">
                      <Label className="text-xs text-muted-foreground"><KeyRound className="size-3.5" /> Jeton (Bearer) — optionnel</Label>
                      <Input type="password" autoComplete="off" spellCheck={false} placeholder="ex. jeton n8n (Settings › Instance-level MCP › Connect)" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} data-testid="mcp-token" />
                      <span className="text-[11px] text-muted-foreground">Envoyé en <span className="font-mono">Authorization: Bearer …</span> sur chaque requête. Stocké uniquement sur cette machine (fichier chmod 600), jamais réaffiché ni écrit dans mcp.config.json.</span>
                    </div>
                    <button type="button" className="col-span-2 flex items-center gap-1 text-left text-xs text-muted-foreground hover:text-foreground" onClick={() => setAdvanced((x) => !x)} data-testid="mcp-advanced"><ChevronDown className={advanced ? 'size-3' : 'size-3 -rotate-90'} /> En-têtes personnalisés (avancé)</button>
                    {advanced && <Textarea rows={2} spellCheck={false} className="col-span-2 font-mono text-xs" placeholder={'X-Api-Key: …\nX-Org: …'} value={form.headers} onChange={(e) => setForm({ ...form, headers: e.target.value })} data-testid="mcp-headers" />}
                  </>
                )}
                <div className="col-span-2 flex justify-end"><Button disabled={busy || !form.id} onClick={add}><Plus /> Ajouter</Button></div>
              </CardContent>
            </Card>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
