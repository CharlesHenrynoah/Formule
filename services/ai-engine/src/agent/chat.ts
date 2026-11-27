import { call, ServiceError } from '@formule/service-kit';
import { aggregate, classifyIntent, getCollection, getPath, isSimpleQuestion, type AppSpec, type AppDataBundle } from '@formule/contracts';
import { getCatalog, rankTools, resolveArgs, type CatalogServer } from '../discovery/catalog.js';
import { understand, norm } from '../semantic/lexicon.js';
import { bindTools, planRequirements, queryIdFor } from '../semantic/plan.js';
import { acquire } from '../discovery/catalog.js';
import { datasetOf, type Dataset } from '../semantic/resolve.js';
import { startBuild } from './orchestrator.js';

export interface ChatInput { projectId: string | null; mode: 'ask' | 'agent'; message: string; fileIds?: string[]; version?: number }
type Out = { kind: 'answer'; text: string; commands?: unknown[] } | { kind: 'job'; jobId: string } | { kind: 'confirm'; text: string; card: Record<string, unknown> };

const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: process.env.FORMULE_TZ ?? 'Europe/Paris' }) : 'heure inconnue');

async function log(projectId: string | null, role: string, content: Record<string, unknown>) {
  if (projectId) await call('storage', `/projects/${projectId}/messages`, { body: { role, content } }).catch(() => {});
}

export async function chat(input: ChatInput): Promise<Out> {
  const msg = input.message.trim().slice(0, 4000);
  if (!msg) throw new ServiceError(400, 'empty', 'message vide');
  const projectOpen = !!input.projectId;
  const intent = classifyIntent(msg, { projectOpen, mode: input.mode });
  const wouldBe = classifyIntent(msg, { projectOpen, mode: 'agent' });

  // Ask = lecture seule. Une demande d'écriture est refusée avec l'invitation à passer en Agent.
  if (input.mode === 'ask' && (wouldBe === 'Act' || (wouldBe === 'Build' && !isSimpleQuestion(msg)))) {
    const text = `Ask est en lecture seule : aucune modification ni action. Passe en Agent pour « ${msg.slice(0, 80)} ».`;
    await log(input.projectId, 'user', { text: msg }); await log(input.projectId, 'agent', { text });
    return { kind: 'answer', text };
  }
  if (intent === 'Diagnose') return diagnose(input, msg);
  if (intent === 'Build' && !(isSimpleQuestion(msg) && !/^(ajoute|retire|cree|construis|renomme|simule)/.test(norm(msg)))) {
    const job = await startBuild({ prompt: msg, projectId: input.projectId, fileIds: input.fileIds ?? [], mode: 'agent' });
    return { kind: 'job', jobId: job.id };
  }
  if (intent === 'Act' && projectOpen) return act(input, msg);
  if (projectOpen) {
    await log(input.projectId, 'user', { text: msg });
    const r = await call<{ text: string; commands?: unknown[] }>('app-agents', `/apps/${input.projectId}/agent`, { body: { message: msg, mode: input.mode, version: input.version } });
    await log(input.projectId, 'agent', { text: r.text });
    return { kind: 'answer', ...r };
  }
  return askWithoutProject(msg);
}

/** Question ponctuelle sans interface : lecture réelle, réponse factuelle, aucune app créée. */
async function askWithoutProject(msg: string): Promise<Out> {
  const catalog = await getCatalog();
  const u = understand(msg, catalog);
  if (!u.reqs.length) {
    const generic = await askGeneric(msg, catalog);
    if (generic) return { kind: 'answer', text: generic };
    const tools = catalog.flatMap((s) => s.tools.filter((t) => t.permission === 'read').map((t) => `${s.name} · ${t.name}`));
    return { kind: 'answer', text: `Je n’ai pas trouvé de mesure correspondante dans les sources autorisées. Disponible : ${tools.slice(0, 8).join(', ') || 'aucune lecture autorisée'}. Pour une interface, passe en Agent et décris-la.` };
  }
  
  const kpiReqs = u.reqs.filter((r) => r.view === 'kpi' || r.view === 'ranking');
  const target = { ...u, reqs: kpiReqs.length ? kpiReqs.slice(0, 1) : u.reqs.slice(0, 1) };
  const { toolFor, unavailable } = bindTools(target, catalog);
  const datasets = new Map<string, Dataset>();
  for (const t of new Set([...toolFor.values()].map((x) => JSON.stringify(x)))) {
    const x = JSON.parse(t);
    const srv = catalog.find((s) => s.serverId === x.serverId)!;
    const a = await acquire({ serverId: srv.serverId, serverName: srv.name, demo: srv.demo, tool: srv.tools.find((y) => y.name === x.tool)! }, queryIdFor(x.serverId, x.tool), { jobId: 'ask', projectId: null });
    datasets.set(a.queryId, datasetOf(a));
  }
  const [p] = planRequirements(target, datasets, toolFor, unavailable);
  if (!p || p.status !== 'covered' || !p.view) return { kind: 'answer', text: `« ${target.reqs[0].label} » : ${p?.reason ?? 'indisponible'}.` };
  const ds = datasets.get(p.queryId!)!;
  const env = ds.acq.envelope;
  const prov = `observé à ${hhmm(env.observedAt ?? env.fetchedAt)}, source ${env.source.serverName}${env.source.demo ? ' (démo)' : ''}`;
  const v = p.view;
  if (v.kind === 'kpi' && v.bindings.aggregate) {
    const r = aggregate(ds.acq.raw, v.bindings.aggregate, v.bindings.unit, Date.parse(env.observedAt ?? env.fetchedAt));
    if (r.value === null) return { kind: 'answer', text: `${v.title} : ${r.state === 'empty' ? 'vide sur le périmètre' : r.reason}, ${prov}.` };
    return { kind: 'answer', text: `${nf.format(r.value)}${r.unit ? ` ${r.unit}` : ''}, ${prov}. ${v.title} sur ${r.count} ligne(s)${env.coverage.complete ? '' : ` — couverture partielle : ${env.coverage.note}`}.` };
  }
  const rows = getCollection(ds.acq.raw, (v as { bindings: { collection: string } }).bindings.collection) ?? [];
  return { kind: 'answer', text: `${rows.length} ligne(s) lue(s) pour « ${p.tpl.label} », ${prov}. Pour la voir en interface, passe en Agent.` };
}

/** Action : préparer → la carte de confirmation part dans le fil. Rien n'est exécuté ici. */
async function act(input: ChatInput, msg: string): Promise<Out> {
  const ver = await call<{ n: number; spec: AppSpec; bundle: AppDataBundle } | null>('storage', `/projects/${input.projectId}/versions/active`);
  await log(input.projectId, 'user', { text: msg });
  if (!ver) return { kind: 'answer', text: 'Aucune version publiée : aucune action possible.' };
  const t = norm(msg);
  const scored = ver.spec.actions.map((a) => ({ a, s: norm(`${a.label} ${a.tool}`).split(/[^a-z0-9]+/).filter((w) => w.length > 3).reduce((x, w) => x + (t.includes(w.slice(0, 5)) ? 1 : 0), 0) })).sort((x, y) => y.s - x.s);
  const action = scored[0]?.s ? scored[0].a : null;
  if (!action) {
    const text = `Aucune action autorisée ne correspond. Actions disponibles : ${ver.spec.actions.map((a) => a.label).join(', ') || 'aucune'}.`;
    await log(input.projectId, 'agent', { text }); return { kind: 'answer', text };
  }
  const args: Record<string, unknown> = { ...action.fixedArgs };
  const missing: string[] = [];
  for (const f of action.fields) {
    let val: unknown;
    if (f.type === 'enum') val = f.options?.find((o) => t.includes(norm(o)));
    else if (/_id$|^id$/.test(f.name)) val = resolveId(f.name, msg, ver);
    else if (f.type === 'number') { const m = msg.match(/(-?\d+(?:[.,]\d+)?)/); if (m) val = Number(m[1].replace(',', '.')); }
    if (val !== undefined) args[f.name] = val; else if (f.required) missing.push(f.label);
  }
  if (missing.length) {
    const text = `Pour « ${action.label} », précise : ${missing.join(', ')}.`;
    await log(input.projectId, 'agent', { text }); return { kind: 'answer', text };
  }
  const op = await call<Record<string, unknown>>('mcp-hub', '/ops/prepare', { body: { serverId: action.serverId, tool: action.tool, args, projectId: input.projectId } });
  const card = { opId: op.opId, label: action.label, effect: action.effect, server: op.serverName, tool: action.tool, args, demo: op.demo, status: 'pending' };
  const text = `Action préparée : ${action.label}. Rien ne part sans ton « Oui, exécuter ».`;
  await log(input.projectId, 'agent', { text, card });
  return { kind: 'confirm', text, card };
}

/** Résout un identifiant à partir du message (ID explicite, ou superlatif sur un classement). */
function resolveId(field: string, msg: string, ver: { spec: AppSpec; bundle: AppDataBundle }): string | undefined {
  const entity = norm(field.replace(/_id$/, ''));
  const q = ver.spec.queries.find((x) => norm(x.tool).includes(entity.slice(0, 6)));
  if (!q) return undefined;
  const raw = ver.bundle.queries[q.id]?.raw;
  const rows = (raw && typeof raw === 'object' ? Object.values(raw).find(Array.isArray) : []) as Record<string, unknown>[];
  const explicit = rows.find((r) => typeof r.id === 'string' && msg.toLowerCase().includes(String(r.id).toLowerCase()));
  if (explicit) return String(explicit.id);
  const t = norm(msg);
  const rk = ver.spec.views.find((v) => v.kind === 'ranking' && v.queryId === q.id);
  if (rk && rk.kind === 'ranking' && /(moins|plus|meilleur|pire)/.test(t)) {
    const b = rk.bindings;
    const scoredRows = rows.map((r) => { const m = getPath(r, b.metric), d = b.den ? getPath(r, b.den) : 1; return { r, v: typeof m === 'number' && typeof d === 'number' && d ? m / d : null }; }).filter((x) => x.v !== null);
    scoredRows.sort((a, c) => (a.v! - c.v!));
    const pick = /(moins|pire)/.test(t) ? scoredRows[0] : scoredRows[scoredRows.length - 1];
    return pick ? String(pick.r.id) : undefined;
  }
  return undefined;
}

async function diagnose(input: ChatInput, msg: string): Promise<Out> {
  const lines: string[] = [];
  const catalog = await getCatalog().catch(() => []);
  for (const s of catalog) lines.push(`${s.name} : ${s.status === 'connected' ? `connecté, ${s.tools.filter((t) => t.permission === 'read').length} lecture(s), ${s.tools.filter((t) => t.permission === 'write').length} écriture(s), ${s.tools.filter((t) => t.permission === 'unclassified').length} non classé(s)` : `erreur ${s.error?.kind} — ${s.error?.message}`}`);
  if (input.projectId) {
    const jobs = await call<{ id: string; state: string; prompt: string }[]>('storage', `/jobs?projectId=${input.projectId}`);
    const last = jobs[0];
    if (last) {
      lines.push(`Dernière génération : ${last.state} (« ${last.prompt.slice(0, 60)} »)`);
      const evs = await call<{ type: string; payload: Record<string, unknown> }[]>('storage', `/jobs/${last.id}/events`);
      const cert = [...evs].reverse().find((e) => e.type === 'certification');
      if (cert) for (const g of (cert.payload.gates as { gate: string; passed: boolean; details: string[] }[]).filter((g) => !g.passed)) lines.push(`${g.gate} en échec : ${g.details.slice(0, 2).join(' ; ')}`);
      for (const e of evs.filter((x) => x.type === 'error')) lines.push(`Erreur : ${e.payload.message}`);
    }
    const ver = await call<{ spec: AppSpec } | null>('storage', `/projects/${input.projectId}/versions/active`);
    for (const r of ver?.spec.requirements.filter((x) => x.status !== 'covered') ?? []) lines.push(`Exigence « ${r.label} » : ${r.reason ?? r.status}`);
  }
  const text = `Diagnostic. ${lines.join('. ')}.`;
  await log(input.projectId, 'user', { text: msg }); await log(input.projectId, 'agent', { text });
  return { kind: 'answer', text };
}

/** Question sur une source sans recette : meilleur outil dont les arguments sont connus, puis le fait demandé. */
async function askGeneric(msg: string, catalog: CatalogServer[]): Promise<string | null> {
  for (const ref of rankTools(catalog, msg).slice(0, 3)) {
    const { args, missing } = (ref.tool.inputSchema?.required ?? []).length ? await resolveArgs(ref, msg, catalog) : { args: {}, missing: [] as string[] };
    if (missing.length) continue;
    const a = await acquire(ref, queryIdFor(ref.serverId, ref.tool.name), { jobId: 'ask', projectId: null }, args);
    const env = a.envelope;
    const prov = `observé à ${hhmm(env.observedAt ?? env.fetchedAt)}, source ${env.source.serverName}${env.source.demo ? ' (démo)' : ''}`;
    if (env.status === 'error') return `Lecture impossible : ${env.source.serverName} · ${ref.tool.name} (${env.error?.kind}). ${env.error?.message.slice(0, 160)}`;
    const ds = datasetOf(a);
    if (ds.docOnly) continue;
    const words = norm(msg).split(/[^a-z0-9-]+/).filter((w) => w.length > 2);
    const rows = ds.collection ? (getCollection(a.raw, ds.collection) ?? []) as Record<string, unknown>[] : [a.raw as Record<string, unknown>];
    const row = rows.find((r) => Object.values(r).some((v) => typeof v === 'string' && words.includes(norm(v)))) ?? (rows.length === 1 ? rows[0] : null);
    if (!row) return `${rows.length} ligne(s) lue(s) dans ${env.source.serverName} · ${ref.tool.name}, ${prov}. Précise l’élément voulu ou passe en Agent pour une interface.`;
    const measures = ds.fields.filter((f) => f.role === 'measure').slice(0, 3);
    const parts = measures.map((f) => { const v = getPath(row, f.rel); return `${f.rel.replace(/_(eur|usd|gbp|chf|jpy|pct)$/, '').replace(/_/g, ' ')} : ${typeof v === 'number' ? nf.format(v) : 'manquant'}${f.unit ? ` ${f.unit}` : ''}`; });
    const label = ['nom', 'name', 'id', 'symbole'].map((k) => row[k]).find((v) => typeof v === 'string');
    return `${parts[0] ?? 'valeur indisponible'}${label ? ` (${label})` : ''}, ${prov}.${parts.length > 1 ? ` ${parts.slice(1).join(' ; ')}.` : ''}`;
  }
  return null;
}
