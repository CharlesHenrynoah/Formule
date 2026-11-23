/**
 * COMPOSANTS D'ACTION pilotés par le contremaître (équivalents shadcn/ui des 27 composants « Apps SDK UI »).
 * Le contremaître les affiche / met à jour / retire via ses outils ui_render_action, ui_update_action, ui_remove_action ;
 * chaque interaction utilisateur lui est renvoyée comme un événement (message du chat). Toute action à effet réel
 * passe par lui + confirmation. Les noms du registre sont fixes : Alert, Avatar, AvatarGroup, Badge, Button, ButtonLink,
 * Checkbox, CodeBlock, DatePicker, DateRangePicker, EmptyMessage, Indicators, Input, Markdown, Menu, Popover,
 * RadioGroup, SegmentedControl, Select, SelectControl, Slider, Switch, TagInput, TextLink, Textarea, CopyTooltip, Tooltip.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ErrorBoundary } from './boundary';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Alert as UiAlert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar as UiAvatar, AvatarFallback, AvatarGroup as UiAvatarGroup, AvatarGroupCount, AvatarImage } from '@/components/ui/avatar';
import { Badge as UiBadge } from '@/components/ui/badge';
import { Button as UiButton } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Checkbox as UiCheckbox } from '@/components/ui/checkbox';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input as UiInput } from '@/components/ui/input';
import { Popover as UiPopover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import { RadioGroup as UiRadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select as UiSelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider as UiSlider } from '@/components/ui/slider';
import { Spinner } from '@/components/ui/spinner';
import { Switch as UiSwitch } from '@/components/ui/switch';
import { Textarea as UiTextarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip as UiTooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export const ACTION_COMPONENTS = ['Alert', 'Avatar', 'AvatarGroup', 'Badge', 'Button', 'ButtonLink', 'Checkbox', 'CodeBlock', 'DatePicker', 'DateRangePicker', 'EmptyMessage', 'Indicators', 'Input', 'Markdown', 'Menu', 'Popover', 'RadioGroup', 'SegmentedControl', 'Select', 'SelectControl', 'Slider', 'Switch', 'TagInput', 'TextLink', 'Textarea', 'CopyTooltip', 'Tooltip'] as const;
export type ActionName = typeof ACTION_COMPONENTS[number];
export type ActionSpec = { id: string; component: ActionName; props?: Record<string, any>; zone?: 'dashboard' | 'chat' };
export type ActionEvent = { id: string; component: ActionName; event: string; value?: unknown; label?: string };
type Emit = (event: string, value?: unknown) => void;
type Opt = { label: string; value: string };
const opts = (o: unknown): Opt[] => (Array.isArray(o) ? o : []).map((x) => (typeof x === 'object' && x ? { label: String((x as Opt).label ?? (x as Opt).value), value: String((x as Opt).value ?? (x as Opt).label) } : { label: String(x), value: String(x) }));
const initials = (n = '?') => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const day = (d?: Date) => (d ? d.toISOString().slice(0, 10) : undefined);
const Label = ({ children }: { children?: ReactNode }) => (children ? <div className="mb-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{children}</div> : null);

/** Coloration légère (sans dépendance) : chaînes, nombres, mots-clés, commentaires. */
function highlight(code: string) {
  const re = /(\/\/.*$|#.*$|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`)|\b(\d+(?:\.\d+)?)\b|\b(const|let|var|function|return|if|else|for|while|import|from|export|async|await|new|class|true|false|null|undefined|SELECT|FROM|WHERE|GROUP BY|ORDER BY)\b/gm;
  const out: ReactNode[] = []; let last = 0; let m: RegExpExecArray | null; let k = 0;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const cls = m[1] ? 'text-muted-foreground italic' : m[2] ? 'text-emerald-700' : m[3] ? 'text-amber-700' : 'text-foreground/80';
    out.push(<span key={k++} className={cls}>{m[0]}</span>); last = m.index + m[0].length;
  }
  out.push(code.slice(last));
  return out;
}

function CopyBtn({ text, label = 'Copier' }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <TooltipProvider><UiTooltip open={ok || undefined}>
      <TooltipTrigger asChild><UiButton size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(text).catch(() => {}); setOk(true); setTimeout(() => setOk(false), 1200); }}>{label}</UiButton></TooltipTrigger>
      <TooltipContent>{ok ? 'Copié ✓' : 'Copier dans le presse-papiers'}</TooltipContent>
    </UiTooltip></TooltipProvider>
  );
}

function TagInputView({ p, emit }: { p: Record<string, any>; emit: Emit }) {
  const [tags, setTags] = useState<string[]>(Array.isArray(p.tags) ? p.tags.map(String) : []);
  const [v, setV] = useState('');
  useEffect(() => { if (Array.isArray(p.tags)) setTags(p.tags.map(String)); }, [JSON.stringify(p.tags)]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (next: string[]) => { setTags(next); emit('change', next); };
  return (
    <div className="flex flex-wrap items-center gap-1 rounded-md border border-input px-2 py-1">
      {tags.map((t) => <UiBadge key={t} variant="secondary" className="gap-1">{t}<button aria-label={`Retirer ${t}`} onClick={() => commit(tags.filter((x) => x !== t))}>×</button></UiBadge>)}
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder={p.placeholder ?? 'Ajouter…'} className="min-w-[80px] flex-1 bg-transparent text-sm outline-none"
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ',') && v.trim()) { e.preventDefault(); if (!tags.includes(v.trim())) commit([...tags, v.trim()]); setV(''); } }} />
    </div>
  );
}

function SelectControlView({ p, emit }: { p: Record<string, any>; emit: Emit }) {
  const [open, setOpen] = useState(false); const [val, setVal] = useState<string | undefined>(p.value);
  const o = opts(p.options);
  return (
    <UiPopover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><UiButton variant="outline" className="w-full justify-between">{o.find((x) => x.value === val)?.label ?? p.placeholder ?? 'Choisir…'}<span className="opacity-50">⌄</span></UiButton></PopoverTrigger>
      <PopoverContent className="p-0"><Command>
        <CommandInput placeholder={p.searchPlaceholder ?? 'Rechercher…'} />
        <CommandList><CommandEmpty>Aucun résultat.</CommandEmpty><CommandGroup>
          {o.map((x) => <CommandItem key={x.value} value={x.label} onSelect={() => { setVal(x.value); setOpen(false); emit('change', x.value); }}>{x.value === val ? '✓ ' : ''}{x.label}</CommandItem>)}
        </CommandGroup></CommandList>
      </Command></PopoverContent>
    </UiPopover>
  );
}

function DateView({ p, emit, range }: { p: Record<string, any>; emit: Emit; range?: boolean }) {
  const [one, setOne] = useState<Date | undefined>(p.value ? new Date(p.value) : undefined);
  const [r, setR] = useState<{ from?: Date; to?: Date } | undefined>(p.from ? { from: new Date(p.from), to: p.to ? new Date(p.to) : undefined } : undefined);
  const label = range ? (r?.from ? `${day(r.from)} → ${day(r.to) ?? '…'}` : p.placeholder ?? 'Choisir une période') : one ? day(one) : p.placeholder ?? 'Choisir une date';
  return (
    <UiPopover>
      <PopoverTrigger asChild><UiButton variant="outline" className="w-full justify-start font-mono">📅 {label}</UiButton></PopoverTrigger>
      <PopoverContent className="w-auto p-0">
        {range
          ? <Calendar mode="range" numberOfMonths={2} selected={r as any} onSelect={(v: any) => { setR(v); if (v?.from && v?.to) emit('change', { from: day(v.from), to: day(v.to) }); }} />
          : <Calendar mode="single" selected={one} onSelect={(d: any) => { setOne(d); if (d) emit('change', day(d)); }} />}
      </PopoverContent>
    </UiPopover>
  );
}

function SliderView({ p, emit }: { p: Record<string, any>; emit: Emit }) {
  const [v, setV] = useState<number>(Number(p.value ?? p.min ?? 0));
  useEffect(() => { if (p.value !== undefined) setV(Number(p.value)); }, [p.value]);
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs"><span className="text-muted-foreground">{p.label}</span><span className="font-mono text-foreground/80">{v}{p.unit ?? ''}</span></div>
      <UiSlider min={Number(p.min ?? 0)} max={Number(p.max ?? 100)} step={Number(p.step ?? 1)} value={[v]} onValueChange={(x) => setV(x[0])} onValueCommit={(x) => emit('change', x[0])} />
    </div>
  );
}

function FieldView({ p, emit, area }: { p: Record<string, any>; emit: Emit; area?: boolean }) {
  const [v, setV] = useState(String(p.value ?? ''));
  const submit = () => v.trim() && emit('submit', v.trim());
  return (
    <div className="flex gap-2">
      {area
        ? <UiTextarea value={v} onChange={(e) => setV(e.target.value)} placeholder={p.placeholder} rows={p.rows ?? 3} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }} />
        : <UiInput value={v} type={p.type ?? 'text'} onChange={(e) => setV(e.target.value)} placeholder={p.placeholder} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />}
      <UiButton size="sm" variant="secondary" onClick={submit} disabled={!v.trim()}>{p.submitLabel ?? 'Envoyer'}</UiButton>
    </div>
  );
}

function render(spec: ActionSpec, emit: Emit): ReactNode {
  const p = spec.props ?? {};
  switch (spec.component) {
    case 'Alert': return <UiAlert variant={p.variant === 'destructive' || p.variant === 'danger' ? 'destructive' : 'default'}>{p.title && <AlertTitle>{p.title}</AlertTitle>}{p.description && <AlertDescription>{p.description}</AlertDescription>}</UiAlert>;
    case 'Avatar': return <div className="flex items-center gap-2"><UiAvatar><AvatarImage src={p.src} alt={p.name} /><AvatarFallback>{initials(p.name)}</AvatarFallback></UiAvatar>{p.showName !== false && p.name && <span className="text-sm">{p.name}</span>}</div>;
    case 'AvatarGroup': { const ppl = (Array.isArray(p.people) ? p.people : []) as Array<{ name?: string; src?: string }>; const max = Number(p.max ?? 4);
      return <UiAvatarGroup>{ppl.slice(0, max).map((x, i) => <UiAvatar key={i}><AvatarImage src={x.src} alt={x.name} /><AvatarFallback>{initials(x.name)}</AvatarFallback></UiAvatar>)}{ppl.length > max && <AvatarGroupCount>+{ppl.length - max}</AvatarGroupCount>}</UiAvatarGroup>; }
    case 'Badge': return <UiBadge variant={p.variant ?? 'default'}>{p.label}</UiBadge>;
    case 'Button': return <UiButton variant={p.variant ?? 'default'} size={p.size ?? 'default'} disabled={p.disabled} onClick={() => emit('click', p.value ?? p.label)}>{p.label ?? 'OK'}</UiButton>;
    case 'ButtonLink': return <UiButton asChild variant={p.variant ?? 'outline'}><a href={p.href} target="_blank" rel="noreferrer noopener" onClick={() => emit('click', p.href)}>{p.label ?? p.href} ↗</a></UiButton>;
    case 'Checkbox': return <label className="flex items-center gap-2 text-sm"><UiCheckbox defaultChecked={!!p.checked} onCheckedChange={(c) => emit('change', c === true)} />{p.label}</label>;
    case 'CodeBlock': return <div className="relative"><pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 font-mono text-xs text-foreground/80">{highlight(String(p.code ?? ''))}</pre><div className="absolute right-2 top-2"><CopyBtn text={String(p.code ?? '')} /></div></div>;
    case 'DatePicker': return <DateView p={p} emit={emit} />;
    case 'DateRangePicker': return <DateView p={p} emit={emit} range />;
    case 'EmptyMessage': return <Empty><EmptyHeader><EmptyTitle>{p.title ?? 'Rien à afficher'}</EmptyTitle>{p.description && <EmptyDescription>{p.description}</EmptyDescription>}</EmptyHeader></Empty>;
    case 'Indicators': {
      if (p.kind === 'progress') return <div><div className="mb-1 flex justify-between text-xs"><span className="text-muted-foreground">{p.label}</span><span className="font-mono">{Math.round(Number(p.value ?? 0))} %</span></div><Progress value={Number(p.value ?? 0)} /></div>;
      if (p.kind === 'status') { const c = p.status === 'error' ? 'bg-rose-500' : p.status === 'warn' ? 'bg-amber-400' : 'bg-emerald-400'; return <span className="inline-flex items-center gap-2 text-sm"><span className={cn('size-2.5 rounded-full shadow-[0_0_8px_currentColor]', c)} />{p.label}</span>; }
      return <span className="inline-flex items-center gap-2 text-sm"><Spinner />{p.label ?? 'En cours…'}</span>;
    }
    case 'Input': return <FieldView p={p} emit={emit} />;
    case 'Textarea': return <FieldView p={p} emit={emit} area />;
    case 'Markdown': return <div className="prose prose-sm max-w-none"><ReactMarkdown remarkPlugins={[remarkGfm]}>{String(p.content ?? '')}</ReactMarkdown></div>;
    case 'Menu': return (
      <DropdownMenu><DropdownMenuTrigger asChild><UiButton variant="outline">{p.label ?? 'Actions'} ⌄</UiButton></DropdownMenuTrigger>
        <DropdownMenuContent>{opts(p.items).map((x) => <DropdownMenuItem key={x.value} onSelect={() => emit('select', x.value)}>{x.label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>);
    case 'Popover': return <UiPopover><PopoverTrigger asChild><UiButton variant="outline" size="sm">{p.label ?? 'Détails'}</UiButton></PopoverTrigger><PopoverContent className="prose prose-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{String(p.content ?? '')}</ReactMarkdown></PopoverContent></UiPopover>;
    case 'RadioGroup': return <UiRadioGroup defaultValue={p.value} onValueChange={(v) => emit('change', v)}>{opts(p.options).map((x) => <label key={x.value} className="flex items-center gap-2 text-sm"><RadioGroupItem value={x.value} />{x.label}</label>)}</UiRadioGroup>;
    case 'SegmentedControl': return <ToggleGroup type="single" variant="outline" defaultValue={p.value} onValueChange={(v) => v && emit('change', v)}>{opts(p.options).map((x) => <ToggleGroupItem key={x.value} value={x.value}>{x.label}</ToggleGroupItem>)}</ToggleGroup>;
    case 'Select': return <UiSelect defaultValue={p.value} onValueChange={(v) => emit('change', v)}><SelectTrigger className="w-full"><SelectValue placeholder={p.placeholder ?? 'Choisir…'} /></SelectTrigger><SelectContent>{opts(p.options).map((x) => <SelectItem key={x.value} value={x.value}>{x.label}</SelectItem>)}</SelectContent></UiSelect>;
    case 'SelectControl': return <SelectControlView p={p} emit={emit} />;
    case 'Slider': return <SliderView p={p} emit={emit} />;
    case 'Switch': return <label className="flex items-center gap-2 text-sm"><UiSwitch defaultChecked={!!p.checked} onCheckedChange={(c) => emit('change', c)} />{p.label}</label>;
    case 'TagInput': return <TagInputView p={p} emit={emit} />;
    case 'TextLink': return <UiButton asChild variant="link" className="h-auto p-0"><a href={p.href} target="_blank" rel="noreferrer noopener">{p.label ?? p.href}</a></UiButton>;
    case 'CopyTooltip': return <div className="flex items-center gap-2"><code className="truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{p.text}</code><CopyBtn text={String(p.text ?? '')} label={p.label ?? 'Copier'} /></div>;
    case 'Tooltip': return <TooltipProvider><UiTooltip><TooltipTrigger asChild><span className="cursor-help border-b border-dotted border-neutral-500 text-sm">{p.label}</span></TooltipTrigger><TooltipContent>{p.content}</TooltipContent></UiTooltip></TooltipProvider>;
    default: return <span className="text-xs text-red-700">Composant non autorisé : {String(spec.component)}</span>;
  }
}

/** Corps rendu comme composant : une exception pendant render() est rattrapée par l'error boundary. */
function ActionBody({ spec, emit }: { spec: ActionSpec; emit: Emit }) { return <>{render(spec, emit)}</>; }

/** Un composant d'action du registre ; ses événements partent vers le contremaître. */
export function ActionView({ spec, onEvent }: { spec: ActionSpec; onEvent: (e: ActionEvent) => void }) {
  const p = (spec?.props && typeof spec.props === 'object' ? spec.props : {}) as Record<string, any>;
  const known = (ACTION_COMPONENTS as readonly string[]).includes(String(spec?.component));
  const body = known
    ? <ErrorBoundary name={`action ${spec.component}`} compact><ActionBody spec={spec} emit={(event, value) => onEvent({ id: spec.id, component: spec.component, event, value, label: p.label ?? p.title })} /></ErrorBoundary>
    : <span className="text-xs text-amber-700" data-testid="action-fallback">Composant d'action inconnu : {String(spec?.component)} (non affiché)</span>;
  const labelled = !['Slider', 'Checkbox', 'Switch', 'Alert', 'EmptyMessage', 'Indicators'].includes(spec.component) && p.label && ['Input', 'Textarea', 'Select', 'SelectControl', 'RadioGroup', 'SegmentedControl', 'DatePicker', 'DateRangePicker', 'TagInput'].includes(spec.component);
  return <div data-action={spec.id} data-component={spec.component} className="min-w-0">{labelled && <Label>{p.label}</Label>}{body}</div>;
}

/** Zone « Actions » du dashboard : composants affichés par le contremaître. */
export function ActionZone({ specs, onEvent, className }: { specs: ActionSpec[]; onEvent: (e: ActionEvent) => void; className?: string }) {
  if (!specs.length) return null;
  return (
    <section className={cn('mb-3 rounded-lg border border-border bg-black/5/[0.06] p-3', className)} data-testid="action-zone">
      <header className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground/80">⚙ Actions · pilotées par le contremaître</header>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{specs.map((s) => <ActionView key={s.id} spec={s} onEvent={onEvent} />)}</div>
    </section>
  );
}
