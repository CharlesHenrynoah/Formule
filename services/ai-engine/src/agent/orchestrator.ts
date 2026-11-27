import { call } from '@formule/service-kit';
import {
  AppSpecSchema, certify, type AppSpec, type AppDataBundle, type GateResult, type RequirementStatus, type ViewSpec, type AcquisitionEnvelope,
} from '@formule/contracts';
import { acquire, getCatalog, namedServerIds, namesTool, packReads, rankTools, resolveArgs, type Acquired, type CatalogServer, type ToolRef } from '../discovery/catalog.js';
import { understand, type ReqTemplate, type Understanding } from '../semantic/lexicon.js';
import { datasetOf, genericReqs, resolveRequirement, type Dataset } from '../semantic/resolve.js';
import { assembleSpec, bindTools, planActions, planRequirements, queryIdFor, type PlannedReq } from '../semantic/plan.js';
import { refineUnderstanding } from '../semantic/llm-understand.js';
import { linkPrompt } from '../semantic/points.js';
import { isMultiSection, planSections } from '../semantic/sections.js';
import { buildWorkspace, cleanupWorkspace, createWorkspace, shadcnAdd, writeWorkspaceFile } from './workspace.js';
import { emit, setState, type JobRef } from './events.js';
import { matchView, parseDelta, untouchedEqual, type DeltaOp } from './delta.js';
import { backendVsOracle, contractGate, runDomCheck, sourceGate, staticGates } from '../evaluation/gates.js';
import { expectations } from '../evaluation/oracle.js';
import { isDemoMode } from '../llm.js';

interface Ctx { cancelled: boolean; abort: AbortController; approval?: (ok: boolean) => void }
const ctxs = new Map<string, Ctx>();
const FRESH_MS = 24 * 3600_000;

class Cancelled extends Error {}
const check = (job: JobRef) => { if (ctxs.get(job.id)?.cancelled) throw new Cancelled('annulé'); };

export function cancelJob(jobId: string) {
  const c = ctxs.get(jobId); if (!c) return false;
  c.cancelled = true; c.abort.abort(); c.approval?.(false); return true;
}
export function decide(jobId: string, ok: boolean) { const c = ctxs.get(jobId); if (!c?.approval) return false; c.approval(ok); return true; }

async function say(job: JobRef, text: string, extra: Record<string, unknown> = {}) {
  await emit(job, 'answer', { text, ...extra });
  if (job.projectId) await call('storage', `/projects/${job.projectId}/messages`, { body: { role: 'agent', content: { text, ...extra } } });
}

export async function startBuild(input: { prompt: string; projectId: string | null; fileIds: string[]; mode: 'agent' }) {
  const j = await call<{ id: string; state: 'DRAFT' }>('storage', '/jobs', { body: { projectId: input.projectId, kind: 'build', mode: 'agent', prompt: input.prompt } });
  const job: JobRef = { id: j.id, projectId: input.projectId, version: null, kind: 'build', state: 'DRAFT' };
  ctxs.set(job.id, { cancelled: false, abort: new AbortController() });
  await emit(job, 'job.created', { prompt: input.prompt, projectId: input.projectId });
  const run = input.projectId ? evolve(job, input) : create(job, input);
  run.catch(async (e) => {
    if (e instanceof Cancelled || ctxs.get(job.id)?.cancelled) {
      try { await setState(job, 'CANCELLED'); } catch { /* déjà terminal */ }
      await say(job, 'Arrêté. L’interface déjà enregistrée n’a pas bougé.');
    } else {
      console.error('[ai-engine]', e);
      try { await setState(job, 'FAILED'); } catch { /* déjà terminal */ }
      await emit(job, 'error', { message: (e as Error).message });
      await say(job, `Échec : ${(e as Error).message}. La dernière version enregistrée reste disponible.`);
    }
  }).finally(async () => { ctxs.delete(job.id); await emit(job, 'job.done', { state: job.state }).catch(() => {}); });
  return job;
}

function sourceSummary(acqs: Acquired[]) {
  return acqs.map((a) => {
    const raw = a.raw as Record<string, unknown> | null;
    const firstArray = raw && typeof raw === 'object' ? Object.values(raw).find(Array.isArray) as unknown[] | undefined : undefined;
    return {
      server: a.ref.serverName, tool: a.ref.tool.name, status: a.envelope.status, demo: a.ref.demo,
      rows: firstArray?.length ?? null, observedAt: a.envelope.observedAt, fetchedAt: a.envelope.fetchedAt,
      coverage: a.envelope.coverage, error: a.envelope.error ?? null, hash: a.envelope.hash?.slice(0, 12) ?? null,
    };
  });
}

async function acquireAll(job: JobRef, refs: ToolRef[], projectId: string | null, prompt = '', catalog: CatalogServer[] = []) {
  const acqs: Acquired[] = [];
  for (const ref of refs) {
    check(job);
    // arguments synthétisés dès que l'outil en déclare (même facultatifs : tri, limite, type…)
    const needs = Object.keys(ref.tool.inputSchema?.properties ?? {}).length > 0;
    const { args, missing } = needs ? await resolveArgs(ref, prompt, catalog) : { args: {}, missing: [] as string[] };
    if (missing.length) { await emit(job, 'log', { text: `${ref.tool.name} : argument(s) obligatoire(s) inconnu(s) — ${missing.join(', ')} ; lecture non tentée` }); continue; }
    const suffix = 'code' in args ? `_${String(args.intent ?? 'gabarit').replace(/^Formule : /, '')}` : Object.keys(args).length ? `_${Object.values(args).map(String).join('_').split('/').pop()}` : '';
    const qid = (queryIdFor(ref.serverId, ref.tool.name) + suffix).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 40);
    await emit(job, 'log', { text: `Lecture ${ref.serverName} · ${ref.tool.name}${'code' in args ? ` (gabarit relu : ${args.intent})` : Object.keys(args).length ? ` ${JSON.stringify(args)}` : ''}` });
    const a = await acquire(ref, suffix ? qid : queryIdFor(ref.serverId, ref.tool.name), { jobId: job.id, projectId }, args);
    acqs.push(a);
    await emit(job, 'log', { text: `${ref.tool.name} : ${a.envelope.status}${a.envelope.error ? ` (${a.envelope.error.kind})` : ''}${a.envelope.coverage.note ? ` — ${a.envelope.coverage.note}` : ''}` });
  }
  return acqs;
}

// ------------------------------------------------------------------ création
async function create(job: JobRef, input: { prompt: string; fileIds: string[] }) {
  await setState(job, 'DISCOVERY');
  const catalog = await getCatalog();
  for (const s of catalog) if (s.status === 'error') await emit(job, 'log', { text: `Source ${s.name} indisponible : ${s.error?.kind}` });
  // Demande structurée en sections : une requête par section, livraison de tout ce qui est disponible.
  if (isMultiSection(input.prompt) && !input.fileIds.length) return createFromSections(job, input, catalog);
  // Un serveur nommé dans la demande (« CoinGecko ») borne le catalogue : le modèle ne peut plus
  // accrocher un autre MCP dont la description partage un mot (EUR, montant…).
  const named = namedServerIds(input.prompt, catalog);
  const scoped = named.length ? catalog.filter((s) => named.includes(s.serverId)) : catalog;
  if (named.length) await emit(job, 'log', { text: `Périmètre : ${scoped.map((s) => s.name).join(', ')}` });
  let u: Understanding = understand(input.prompt, scoped);
  u = await refineUnderstanding(input.prompt, u, scoped);
  check(job);

  let datasets = new Map<string, Dataset>();
  let planned: PlannedReq[];
  let acqs: Acquired[];
  const explicit = /[\w.-]+\.(csv|json|tsv)\b/i.test(input.prompt) || scoped.some((srv) => srv.tools.some((t) => t.permission === 'read' && t.name.length > 6 && namesTool(input.prompt, t.name)));
  const packed = await packReads(scoped, input.prompt);
  let bound: ToolRef[] = [];
  const lexical = !input.fileIds.length && !explicit && (!u.generic || u.reqs.length);
  if (lexical) {
    const { toolFor } = bindTools(u, scoped);
    bound = uniqueRefs(scoped, [...toolFor.values()]);
  }
  // Le gabarit relu prime dès qu'il sait lire ce serveur et que l'appariement par mots-clés ne l'a pas choisi.
  const usePack = packed.length > 0 && !packed.every((p) => bound.some((r) => r.serverId === p.serverId && r.tool.name === p.tool.name));
  if (lexical && bound.length && !usePack) {
    const { toolFor, unavailable } = bindTools(u, scoped);
    acqs = await acquireAll(job, bound, null, input.prompt, scoped);
    for (const a of acqs) datasets.set(a.queryId, datasetOf(a));
    planned = planRequirements(u, datasets, toolFor, unavailable);
  } else {
    // MCP inédit, fichier joint, ou serveur « code mode » (execute) : gabarit relu, pas la description.
    const ranked = usePack ? packed : rankTools(scoped, input.prompt, input.fileIds);
    const refs: ToolRef[] = []; const unresolved: string[] = [];
    for (const r of ranked) {
      if (refs.length >= (input.fileIds.length ? Math.min(3, input.fileIds.length) : 1)) break;
      const { missing } = Object.keys(r.tool.inputSchema?.properties ?? {}).length ? await resolveArgs(r, input.prompt, scoped) : { missing: [] };
      if (missing.length) {
        if (unresolved.length < 3) unresolved.push(`${r.serverName} · ${r.tool.name} : ${missing.join(', ')}`);
        // l'outil nommé explicitement n'est jamais remplacé par un autre
        if (namesTool(input.prompt, r.tool.name)) break;
        continue;
      }
      refs.push(r);
    }
    if (!refs.length) {
      if (unresolved.length) { await setState(job, 'BLOCKED'); await emit(job, 'answer', { text: `J’ai trouvé des outils proches, mais il manque des arguments obligatoires que je ne peux pas inventer : ${unresolved.join(' ; ')}. Précise-les dans ta demande (nom de fichier, valeur entre guillemets…).` }); return; }
      return blocked(job, input.prompt, named.length ? scoped : catalog);
    }
    acqs = await acquireAll(job, refs, null, input.prompt, scoped);
    const reqs: ReqTemplate[] = [];
    for (const a of acqs) { const ds = datasetOf(a); datasets.set(a.queryId, ds); reqs.push(...genericReqs(ds).map((r) => ({ ...r, id: `${a.queryId.slice(0, 20)}_${r.id}`.slice(0, 40) }))); }
    u = { ...u, reqs };
    planned = reqs.map((tpl, i) => {
      const ds = [...datasets.values()].find((d) => tpl.tool.includes(d.acq.ref.tool.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''))) ?? [...datasets.values()][0];
      const r = resolveRequirement(tpl, ds, `v${i + 1}_${tpl.view}`, ds.acq.queryId);
      return r.ok ? { tpl, status: 'covered' as const, queryId: ds.acq.queryId, view: r.view, evidencePath: r.evidencePath, envelopeId: ds.acq.envelope.id } : { tpl, status: (ds.acq.envelope.status === 'error' ? 'unavailable' : 'missing') as 'missing', reason: r.reason };
    });
  }
  let pointsLocked = false;
  const linked = await applyPoints(job, input.prompt, datasets);
  if (linked) { u = linked.u; planned = linked.planned; pointsLocked = true; }
  if (!u.reqs.length) return blocked(job, input.prompt, catalog);

  const covered = planned.filter((p) => p.tpl.mandatory && p.status === 'covered');
  const summary = {
    sources: sourceSummary(acqs),
    requirements: planned.map((p) => ({ id: p.tpl.id, label: p.tpl.label, mandatory: p.tpl.mandatory, status: p.status, reason: p.reason ?? null })),
    canApprove: covered.length > 0,
    demo: acqs.some((a) => a.ref.demo),
  };
  await emit(job, 'source', summary);
  if (!summary.canApprove) {
    await setState(job, 'BLOCKED');
    await say(job, `Je n’ai lu aucune donnée portant les mesures demandées. ${planned.map((p) => `${p.tpl.label} : ${p.reason ?? p.status}`).join(' ; ')}. Alternative : joins un fichier CSV/JSON ou connecte une source qui fournit ces mesures.`);
    return;
  }
  // Rien n'est construit sans ce oui.
  await call('storage', `/jobs/${job.id}`, { method: 'PATCH', body: { awaiting: { type: 'sourcing', ...summary } } });
  const ok = await new Promise<boolean>((resolve) => {
    const c = ctxs.get(job.id)!; c.approval = resolve;
    setTimeout(() => resolve(false), 30 * 60_000).unref();
  });
  await call('storage', `/jobs/${job.id}`, { method: 'PATCH', body: { awaiting: null } });
  if (!ok) {
    if (ctxs.get(job.id)?.cancelled) throw new Cancelled('annulé');
    await setState(job, 'CANCELLED');
    await emit(job, 'answer', { text: 'Rejeté. Rien n’a été construit.' });
    return;
  }

  const project = await call<{ id: string }>('storage', '/projects', { body: { title: u.title, demo: summary.demo } });
  job.projectId = project.id;
  await call('storage', `/jobs/${job.id}`, { method: 'PATCH', body: { projectId: project.id } });
  await call('storage', `/jobs/${job.id}/attach`, { body: { projectId: project.id } });
  await call('storage', `/projects/${project.id}/messages`, { body: { role: 'user', content: { text: input.prompt } } });
  await call('storage', `/projects/${project.id}/messages`, { body: { role: 'agent', content: { kind: 'sourcing', ...summary, decision: 'validé' } } });
  await emit(job, 'log', { text: 'Sources validées par l’utilisateur', projectId: project.id });

  await setState(job, 'CONTRACT');
  const usedServers = new Set(acqs.filter((a) => a.envelope.status !== 'error').map((a) => a.ref.serverId));
  const spec = assembleSpec({ u, planned, datasets, actions: planActions(catalog, usedServers, datasets), demo: summary.demo, prompt: input.prompt, pointsLocked });
  await buildAndCertify(job, { spec, datasets, catalog, base: null, touched: new Set() });
}

async function createFromSections(job: JobRef, input: { prompt: string }, catalog: CatalogServer[]) {
  const plan = await planSections(input.prompt, catalog, async (ref, qid, args) => {
    check(job);
    await emit(job, 'log', { text: `Lecture ${ref.serverName} · ${ref.tool.name} ${JSON.stringify(args).slice(0, 160)}` });
    const a = await acquire(ref, qid, { jobId: job.id, projectId: null }, args);
    await emit(job, 'log', { text: `${ref.tool.name} : ${a.envelope.status}${a.envelope.error ? ` (${a.envelope.error.kind})` : ''}${a.envelope.coverage.note ? ` — ${a.envelope.coverage.note}` : ''}` });
    return a;
  });
  for (const l of plan.log) await emit(job, 'log', { text: l });
  const linked = await applyPoints(job, input.prompt, plan.datasets);
  const spec = linked
    ? assembleSpec({ u: linked.u, planned: linked.planned, datasets: plan.datasets, actions: plan.spec.actions, demo: plan.demo, prompt: input.prompt, pointsLocked: true })
    : plan.spec;
  const covered = spec.requirements.filter((r) => r.mandatory && r.status === 'covered');
  const summary = {
    sources: sourceSummary(plan.acqs),
    requirements: spec.requirements.map((r) => ({ id: r.id, label: r.label, mandatory: r.mandatory, status: r.status, reason: r.reason ?? null })),
    canApprove: covered.length > 0, demo: plan.demo,
  };
  await emit(job, 'source', summary);
  if (!summary.canApprove) {
    await setState(job, 'BLOCKED');
    await say(job, `Aucune section n’a pu être lue. ${plan.log.join(' ; ')}. Vérifie les outils autorisés dans MCP ou précise les arguments.`);
    return;
  }
  await call('storage', `/jobs/${job.id}`, { method: 'PATCH', body: { awaiting: { type: 'sourcing', ...summary } } });
  const ok = await new Promise<boolean>((resolve) => { const c = ctxs.get(job.id)!; c.approval = resolve; setTimeout(() => resolve(false), 30 * 60_000).unref(); });
  await call('storage', `/jobs/${job.id}`, { method: 'PATCH', body: { awaiting: null } });
  if (!ok) { if (ctxs.get(job.id)?.cancelled) throw new Cancelled('annulé'); await setState(job, 'CANCELLED'); await emit(job, 'answer', { text: 'Rejeté. Rien n’a été construit.' }); return; }
  const project = await call<{ id: string }>('storage', '/projects', { body: { title: spec.title, demo: plan.demo } });
  job.projectId = project.id;
  await call('storage', `/jobs/${job.id}`, { method: 'PATCH', body: { projectId: project.id } });
  await call('storage', `/jobs/${job.id}/attach`, { body: { projectId: project.id } });
  await call('storage', `/projects/${project.id}/messages`, { body: { role: 'user', content: { text: input.prompt } } });
  await call('storage', `/projects/${project.id}/messages`, { body: { role: 'agent', content: { kind: 'sourcing', ...summary, decision: 'validé' } } });
  await setState(job, 'CONTRACT');
  await buildAndCertify(job, { spec, datasets: plan.datasets, catalog, base: null, touched: new Set() });
}

async function applyPoints(job: JobRef, prompt: string, datasets: Map<string, Dataset>) {
  const linked = await linkPrompt(prompt, datasets);
  if (!linked || !linked.planned.some((p) => p.status === 'covered')) return null;
  await emit(job, 'log', { text: 'Consigne lue en points : chaque point n’est lié que s’il rencontre une donnée MCP' });
  for (const p of linked.planned) await emit(job, 'log', { text: `Point · ${p.tpl.label} → ${p.status}${p.reason ? ` (${p.reason})` : ''}` });
  return linked;
}

function uniqueRefs(catalog: CatalogServer[], tools: { serverId: string; tool: string }[]): ToolRef[] {
  const seen = new Set<string>(); const out: ToolRef[] = [];
  for (const t of tools) {
    const k = `${t.serverId}__${t.tool}`; if (seen.has(k)) continue; seen.add(k);
    const srv = catalog.find((s) => s.serverId === t.serverId)!;
    out.push({ serverId: srv.serverId, serverName: srv.name, demo: srv.demo, tool: srv.tools.find((x) => x.name === t.tool)! });
  }
  return out;
}

async function blocked(job: JobRef, prompt: string, catalog: CatalogServer[]) {
  await setState(job, 'BLOCKED');
  const avail = catalog.flatMap((s) => s.tools.filter((t) => t.permission === 'read').map((t) => `${s.name} · ${t.name}`));
  await emit(job, 'limitation', { prompt });
  await emit(job, 'answer', { text: `Aucune source autorisée ne correspond à « ${prompt.slice(0, 80)} ». ${avail.length ? `Lectures disponibles : ${avail.slice(0, 8).join(', ')}.` : 'Aucun outil de lecture n’est autorisé.'} Alternative : joins un fichier CSV/JSON, coche un outil dans MCP, ou reformule avec une de ces sources.` });
}

// ------------------------------------------------------------------ évolution incrémentale
async function loadDatasets(spec: AppSpec, catalog: CatalogServer[]): Promise<{ datasets: Map<string, Dataset>; oldest: number }> {
  const datasets = new Map<string, Dataset>(); let oldest = Date.now();
  for (const q of spec.queries) {
    if (!q.envelopeId) continue;
    const snap = await call<{ envelope: AcquisitionEnvelope; raw: unknown }>('storage', `/snapshots/${q.envelopeId}`).catch(() => null);
    if (!snap) continue;
    const srv = catalog.find((s) => s.serverId === q.serverId);
    const tool = srv?.tools.find((t) => t.name === q.tool) ?? { name: q.tool, description: '', permission: 'read' as const, hint: '' };
    const acq: Acquired = { queryId: q.id, ref: { serverId: q.serverId, serverName: snap.envelope.source.serverName, demo: snap.envelope.source.demo, tool }, args: q.args, envelope: snap.envelope, raw: snap.raw, paginate: q.paginate };
    datasets.set(q.id, datasetOf(acq));
    oldest = Math.min(oldest, Date.parse(snap.envelope.fetchedAt));
  }
  return { datasets, oldest };
}

async function evolve(job: JobRef, input: { prompt: string; projectId: string | null }) {
  const projectId = input.projectId!;
  await call('storage', `/projects/${projectId}/messages`, { body: { role: 'user', content: { text: input.prompt } } });
  await setState(job, 'DISCOVERY');
  const baseV = await call<{ n: number; spec: AppSpec } | null>('storage', `/projects/${projectId}/versions/active`);
  if (!baseV) throw new Error('aucune version de base');
  job.version = baseV.n;
  const base = AppSpecSchema.parse(baseV.spec);
  const ops = parseDelta(input.prompt);
  const catalog = await getCatalog();
  let { datasets, oldest } = await loadDatasets(base, catalog);
  const styleOnly = ops.length > 0 && ops.every((o) => o.op === 'title' || o.op === 'density' || o.op === 'accent');

  // Un changement de style ne relance pas la collecte. Sinon, rafraîchir seulement si les données sont trop anciennes.
  if (!styleOnly && Date.now() - oldest > FRESH_MS) {
    await emit(job, 'log', { text: 'Données de plus de 24 h : nouvelle lecture des sources existantes' });
    const refs = uniqueRefs(catalog, base.queries.map((q) => ({ serverId: q.serverId, tool: q.tool })).filter((t) => catalog.some((s) => s.serverId === t.serverId && s.tools.some((x) => x.name === t.tool))));
    // relecture avec les arguments déjà déclarés
    for (const q of base.queries) {
      const ref = refs.find((r) => r.serverId === q.serverId && r.tool.name === q.tool); if (!ref) continue;
      const a = await acquire(ref, q.id, { jobId: job.id, projectId }, q.args);
      if (a.envelope.status !== 'error') datasets.set(q.id, datasetOf(a));
    }
  } else await emit(job, 'log', { text: styleOnly ? 'Changement de style : aucune collecte relancée' : 'Données récentes réutilisées (aucune nouvelle collecte)' });

  const spec: AppSpec = JSON.parse(JSON.stringify(base));
  const touched = new Set<string>();
  const notes: string[] = [];
  let newReqs: ReqTemplate[] = [];
  for (const op of ops) applyOp(op, spec, touched, notes, datasets, (r) => newReqs.push(r), catalog);

  // Ajout qui exige une source nouvelle : passe par la compréhension + le sourcing.
  if (newReqs.length) {
    const u: Understanding = { title: spec.title, mission: spec.mission, reqs: newReqs, commands: [], simulation: false, generic: false };
    const { toolFor, unavailable } = bindTools(u, catalog);
    const missingTools = [...toolFor.values()].filter((t) => !datasets.has(queryIdFor(t.serverId, t.tool)));
    if (missingTools.length) {
      const acqs = await acquireAll(job, uniqueRefs(catalog, missingTools), projectId, input.prompt, catalog);
      for (const a of acqs) datasets.set(a.queryId, datasetOf(a));
    }
    const planned = planRequirements(u, datasets, toolFor, unavailable);
    for (const p of planned) {
      const id = uniqueId(spec, p.tpl.id);
      if (p.view) { const v = { ...p.view, id: uniqueId(spec, p.view.id), requirementIds: [id] } as ViewSpec; spec.views.push(v); touched.add(v.id); notes.push(`ajout « ${v.title} »`);
        if (!spec.queries.some((q) => q.id === p.queryId)) { const ds = datasets.get(p.queryId!)!; spec.queries.push({ id: p.queryId!, serverId: ds.acq.ref.serverId, tool: ds.acq.ref.tool.name, args: ds.acq.args, refresh: { mode: 'once' }, envelopeId: ds.acq.envelope.id, ...(ds.acq.paginate ? { paginate: ds.acq.paginate } : {}) }); }
      }
      spec.requirements.push({ id, label: p.tpl.label, mandatory: p.tpl.mandatory, status: p.status, ...(p.reason ? { reason: p.reason } : {}), evidence: p.view ? { envelopeId: p.envelopeId!, path: p.evidencePath!, viewId: p.view.id } : null });
      if (!p.view) notes.push(`« ${p.tpl.label} » indisponible : ${p.reason}`);
    }
  }
  // les requêtes rafraîchies pointent vers leur nouvelle enveloppe
  for (const q of spec.queries) { const ds = datasets.get(q.id); if (ds) q.envelopeId = ds.acq.envelope.id; }

  if (!touched.size && !ops.some((o) => o.op === 'title' || o.op === 'density' || o.op === 'accent')) {
    await setState(job, 'BLOCKED');
    await say(job, `Je n’ai pas identifié de modification applicable${notes.length ? ` (${notes.join(' ; ')})` : ''}. Exemples : « ajoute un graphique », « retire la colonne statut », « simule +5 % », « renomme en Revenu Q4 ». La version v${baseV.n} est inchangée.`);
    return;
  }
  await emit(job, 'log', { text: `Delta : ${notes.join(' ; ') || 'style'}` });
  await setState(job, 'CONTRACT');
  await buildAndCertify(job, { spec, datasets, catalog, base: { spec: base, n: baseV.n }, touched, notes });
}

function uniqueId(spec: AppSpec, id: string) {
  let x = id.slice(0, 36); let i = 2;
  const used = new Set([...spec.views.map((v) => v.id), ...spec.requirements.map((r) => r.id)]);
  while (used.has(x)) x = `${id.slice(0, 34)}_${i++}`;
  return x;
}

function applyOp(op: DeltaOp, spec: AppSpec, touched: Set<string>, notes: string[], datasets: Map<string, Dataset>, needReq: (r: ReqTemplate) => void, catalog: CatalogServer[]) {
  switch (op.op) {
    case 'title': spec.title = op.value; notes.push(`titre → ${op.value}`); return;
    case 'density': spec.style.density = op.value; notes.push(`densité ${op.value}`); return;
    case 'accent': spec.style.accent = op.value; notes.push(`accent ${op.value}`); return;
    case 'removeView': {
      const v = matchView(spec.views, op.target);
      if (!v) { notes.push(`aucune vue ne correspond à « ${op.target} »`); return; }
      spec.views = spec.views.filter((x) => x.id !== v.id); touched.add(v.id);
      for (const r of spec.requirements) if (r.evidence?.viewId === v.id) { r.status = 'missing'; r.reason = 'vue retirée à la demande'; r.evidence = null; }
      notes.push(`vue « ${v.title} » retirée`); return;
    }
    case 'removeColumn': {
      for (const v of spec.views) if (v.kind === 'table') {
        const words = op.target.split(/\s+/).filter((w) => w.length > 2);
        const idx = v.bindings.columns.findIndex((c) => words.some((w) => c.label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(w)));
        if (idx >= 0 && v.bindings.columns.length > 1) { notes.push(`colonne « ${v.bindings.columns[idx].label} » retirée de « ${v.title} »`); v.bindings.columns.splice(idx, 1); touched.add(v.id); return; }
      }
      notes.push(`aucune colonne ne correspond à « ${op.target} »`); return;
    }
    case 'simulate': {
      let sim = spec.views.find((v) => v.kind === 'simulation');
      if (!sim) {
        const line = spec.views.find((v) => v.kind === 'line');
        if (!line || line.kind !== 'line') { notes.push('simulation impossible : aucune série temporelle dans l’interface'); return; }
        sim = { kind: 'simulation', id: uniqueId(spec, 'sim'), title: `Scénario · ${line.bindings.series[0].label}`, queryId: line.queryId, requirementIds: [], bindings: { collection: line.bindings.collection, t: line.bindings.t, v: line.bindings.series[0].path, unit: line.bindings.series[0].unit },
          model: { name: 'derive_lineaire', params: [{ id: 'variation_pct', label: 'Variation par période', min: -20, max: 20, step: 0.5, default: 0, unit: '%' }, { id: 'horizon', label: 'Horizon', min: 1, max: 30, step: 1, default: 7, unit: 'pér.' }], assumptions: ['scénario calculé localement, distinct des données observées'] } };
        spec.views.push(sim);
      }
      if (sim.kind === 'simulation') { const p = sim.model.params.find((x) => x.id === 'variation_pct'); if (p) p.default = Math.max(p.min, Math.min(p.max, op.pct)); }
      touched.add(sim.id); notes.push(`scénario à ${op.pct >= 0 ? '+' : ''}${op.pct} %`); return;
    }
    case 'add': {
      const fromLexicon = understand(op.text, catalog);
      if (!fromLexicon.generic) { for (const r of fromLexicon.reqs.filter((r) => r.view === op.kind || op.kind === 'kpi')) needReq({ ...r, title: r.title }); if (fromLexicon.reqs.length) return; }
      // ajout sur les données déjà lues
      const ds = [...datasets.values()].find((d) => d.collection && d.acq.envelope.status !== 'error');
      if (!ds) { notes.push('aucune donnée lue disponible pour cet ajout'); return; }
      const words = op.text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !['par', 'des', 'les', 'pour', 'avec'].includes(w));
      const label = ds.fields.find((f) => (f.role === 'dimension' || f.role === 'text') && words.some((w) => f.rel.includes(w.slice(0, 5)))) ?? ds.fields.find((f) => f.role === 'dimension');
      const measure = ds.fields.find((f) => f.role === 'measure' && words.some((w) => f.rel.includes(w.slice(0, 5)))) ?? ds.fields.find((f) => f.role === 'measure');
      const time = ds.fields.find((f) => f.role === 'time');
      const tpl: ReqTemplate = {
        id: `ajout_${op.kind}`, label: op.text ? `${op.kind === 'ranking' ? 'classement' : op.kind} ${op.text}` : op.kind, mandatory: false, tool: [ds.acq.ref.tool.name], view: op.kind,
        measure: measure ? [measure.rel.toLowerCase()] : ['__absent__'], label_: label ? [label.rel.toLowerCase()] : undefined, time: time ? [time.rel.toLowerCase()] : undefined,
        series: measure ? [[measure.rel.toLowerCase()]] : undefined, groupBy: true, agg: 'sum',
        title: op.kind === 'ranking' ? `Classement${label ? ` par ${label.rel.split('.')[0]}` : ''}` : op.kind === 'line' ? `Évolution${measure ? ` · ${measure.rel.split('.')[0]}` : ''}` : op.kind === 'table' ? 'Détail' : `${measure?.rel.split('.')[0] ?? 'Indicateur'}`,
      };
      const r = resolveRequirement(tpl, ds, uniqueId(spec, `v_${op.kind}`), ds.acq.queryId);
      if (!r.ok) { notes.push(`ajout impossible : ${r.reason}`); return; }
      const rid = uniqueId(spec, tpl.id);
      spec.views.push({ ...r.view, requirementIds: [rid] } as ViewSpec); touched.add(r.view.id);
      spec.requirements.push({ id: rid, label: tpl.label.slice(0, 120), mandatory: false, status: 'covered', evidence: { envelopeId: ds.acq.envelope.id, path: r.evidencePath, viewId: r.view.id } });
      notes.push(`ajout « ${r.view.title} »`);
    }
  }
}

// ------------------------------------------------------------------ construction + certification
async function buildAndCertify(job: JobRef, x: { spec: AppSpec; datasets: Map<string, Dataset>; catalog: CatalogServer[]; base: { spec: AppSpec; n: number } | null; touched: Set<string>; notes?: string[] }, attempt = 0): Promise<void> {
  const parsed = AppSpecSchema.safeParse(x.spec);
  if (!parsed.success) throw new Error(`contrat d’application invalide : ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} (${i.message})`).join(' ; ')}`);
  let spec = parsed.data;
  const raws: Record<string, unknown> = {}; const refTimes: Record<string, number> = {};
  const bundle: AppDataBundle = { builtAt: new Date().toISOString(), queries: {}, certification: { certified: false, message: 'Aperçu non certifié', label: 'aperçu' } };
  for (const q of spec.queries) {
    const ds = x.datasets.get(q.id); if (!ds) continue;
    raws[q.id] = ds.acq.raw;
    refTimes[q.id] = Date.parse(ds.acq.envelope.observedAt ?? ds.acq.envelope.fetchedAt);
    const e = ds.acq.envelope;
    bundle.queries[q.id] = { envelope: { id: e.id, status: e.status, observedAt: e.observedAt, fetchedAt: e.fetchedAt, coverage: e.coverage, source: { serverName: e.source.serverName, demo: e.source.demo }, hash: e.hash }, raw: ds.acq.raw };
  }
  await emit(job, 'log', { text: `Contrat : ${spec.views.length} vue(s), ${spec.queries.length} requête(s), ${spec.requirements.filter((r) => r.mandatory).length} exigence(s) obligatoire(s)` });

  await setState(job, 'BUILD');
  check(job);
  const ws = createWorkspace(job.id + (attempt ? `_r${attempt}` : ''));
  writeWorkspaceFile(ws, 'src/app.spec.json', JSON.stringify(spec));
  writeWorkspaceFile(ws, 'src/app.data.json', JSON.stringify(bundle));
  const sh = await shadcnAdd(ws, ['chart'], ctxs.get(job.id)?.abort.signal);
  await emit(job, 'log', { text: `shadcn add chart : ${sh.log}` });
  const built = await buildWorkspace(ws, ctxs.get(job.id)?.abort.signal);
  check(job);
  await emit(job, 'log', { text: built.ok ? `Build ${built.ms} ms` : `Build en échec : ${built.log.slice(-300)}` });
  cleanupWorkspace(ws);

  await setState(job, 'CERTIFICATION');
  const gates: GateResult[] = [];
  const st = await staticGates(spec, built.html ?? null, built.ok, built.log, x.catalog, raws);
  gates.push(st.find((g) => g.gate === 'G0')!, st.find((g) => g.gate === 'G3')!);
  gates.push(contractGate(spec, x.datasets, st.find((g) => g.gate === 'G2')!));
  gates.push(sourceGate(x.datasets, spec));
  gates.push(backendVsOracle(spec.views, raws, refTimes));

  let dom: Awaited<ReturnType<typeof runDomCheck>> | null = null;
  if (built.ok && built.html) {
    dom = await runDomCheck(built.html, expectations(spec.views, raws, refTimes));
    const bad = dom.results.filter((r) => !r.ok);
    gates.push({ gate: 'G5', passed: !dom.blank && bad.length === 0 && dom.errors.length === 0 && dom.alerts.length === 0, details: [
      ...(dom.blank ? ['écran blanc'] : []), ...bad.map((b) => `liaison ${b.viewId} : ${b.diag}`), ...dom.errors.map((e) => `erreur JS : ${e}`), ...dom.alerts.map((a) => `alerte : ${a}`),
      ...(bad.length === 0 && !dom.blank ? [`${dom.results.length} vue(s) vérifiée(s) dans le DOM${dom.interacted ? ', tri testé' : ''}`] : []),
    ] });
  } else gates.push({ gate: 'G5', passed: false, details: ['aucun bundle à vérifier'] });

  // G6 : une exigence n'est couverte que si sa vue est vérifiée dans le DOM et la donnée fraîche.
  const domOk = new Set(dom?.results.filter((r) => r.ok).map((r) => r.viewId) ?? []);
  const reqs: RequirementStatus[] = spec.requirements.map((r) => {
    if (r.status !== 'covered') return { id: r.id, label: r.label, mandatory: r.mandatory, status: r.status, reason: r.reason };
    const vid = r.evidence?.viewId;
    if (!vid || !domOk.has(vid)) {
      const diag = dom?.results.find((d) => d.viewId === vid)?.diag;
      return { id: r.id, label: r.label, mandatory: r.mandatory, status: 'missing', reason: `métrique lue mais absente du DOM${diag ? ` (${diag})` : ''}` };
    }
    return { id: r.id, label: r.label, mandatory: r.mandatory, status: 'covered' };
  });
  const lastRead = Object.values(bundle.queries).map((q) => q.envelope.observedAt ?? q.envelope.fetchedAt).sort().pop() ?? null;
  const fresh = !!lastRead && Date.now() - Date.parse(lastRead) < FRESH_MS;
  gates.push({ gate: 'G6', passed: fresh, details: [fresh ? `dernière lecture ${lastRead}` : 'données trop anciennes (> 24 h)'] });

  // G7 : non-régression vs version de base, publication possible, restauration testée
  const g7: string[] = [];
  if (x.base) g7.push(...untouchedEqual(x.base.spec, spec, x.touched));
  if (x.base) {
    const prev = await call<{ html: string | null }>('storage', `/projects/${job.projectId}/versions/${x.base.n}`).catch(() => null);
    if (!prev?.html) g7.push(`restauration : version v${x.base.n} illisible`);
  }
  if (!built.html) g7.push('rien à publier');
  gates.push({ gate: 'G7', passed: g7.length === 0, details: g7.length ? g7 : [x.base ? `vues non demandées inchangées ; v${x.base.n} restaurable` : 'première version'] });

  const report = certify(gates, reqs, lastRead, { repairable: attempt === 0 });
  for (const g of report.gates) await emit(job, 'log', { text: `${g.gate} ${g.passed ? '✓' : '✗'} ${g.details.slice(0, 3).join(' · ')}`, gate: g.gate, passed: g.passed });

  // Réparation bornée (1 tentative) : on retire les vues dont la liaison échoue ; leurs exigences deviennent manquantes.
  if (report.outcome === 'REPAIR' && attempt === 0) {
    const broken = new Set(dom?.results.filter((r) => !r.ok).map((r) => r.viewId) ?? []);
    const fixable = broken.size > 0 && report.blockingGates.every((g) => g === 'G5' || g === 'G6');
    if (fixable) {
      await setState(job, 'REPAIR');
      await emit(job, 'log', { text: `Réparation : retrait de ${broken.size} vue(s) mal liée(s)` });
      const repaired: AppSpec = { ...spec, views: spec.views.filter((v) => !broken.has(v.id)), requirements: spec.requirements.map((r) => (r.evidence && broken.has(r.evidence.viewId) ? { ...r, status: 'missing' as const, reason: reqs.find((q) => q.id === r.id)?.reason, evidence: null } : r)) };
      const touched = new Set([...x.touched, ...broken]);
      return buildAndCertify(job, { ...x, spec: repaired, touched }, 1);
    }
  }

  // enregistrement du candidat avec statuts vérifiés
  spec = { ...spec, requirements: spec.requirements.map((r) => { const s = reqs.find((q) => q.id === r.id)!; return { ...r, status: s.status, ...(s.reason ? { reason: s.reason } : {}) }; }) };
  const label = report.certified ? 'certifiée' : report.outcome === 'DEGRADED' ? 'partielle' : 'non certifiée';
  const certification = { ...report, label, demoLlm: isDemoMode() };
  const n = (await call<{ n: number }>('storage', `/projects/${job.projectId}/versions`, { body: { spec, html: built.html ?? null, bundle: { ...bundle, certification: { certified: report.certified, message: report.message, label } }, certification, jobId: job.id, parentN: x.base?.n ?? null } })).n;
  job.version = n;
  await emit(job, 'certification', { version: n, certified: report.certified, outcome: report.outcome, message: report.message, gates: report.gates, covered: report.covered, total: report.total, missing: report.missing });

  if (report.outcome === 'READY') {
    await setState(job, 'READY');
    await call('storage', `/projects/${job.projectId}/versions/${n}/promote`, { body: { kind: 'certified' } });
    await setState(job, 'ACTIVE');
    await emit(job, 'published', { version: n, projectId: job.projectId });
    await say(job, `${report.message}${x.notes?.length ? ` Modifications : ${x.notes.join(' ; ')}.` : ''}`, { version: n, certified: true });
  } else if (report.outcome === 'DEGRADED') {
    await setState(job, 'DEGRADED');
    const p = await call<{ promoted: boolean; reason?: string; active?: number }>('storage', `/projects/${job.projectId}/versions/${n}/promote`, { body: { kind: 'partial' } });
    if (p.promoted) await emit(job, 'published', { version: n, projectId: job.projectId, partial: true });
    const why = report.missing.map((m) => { const r = reqs.find((q) => q.label === m); return r?.reason ? `${m} (${r.reason})` : m; });
    await say(job, `${report.message} Manque : ${why.join(' ; ')}.${p.promoted ? '' : ` La version certifiée v${p.active} reste active ; v${n} est un aperçu non promu.`}`, { version: n, certified: false, partial: true });
  } else {
    await call('storage', `/projects/${job.projectId}/versions/${n}/reject`, { body: {} });
    await setState(job, 'FAILED');
    await say(job, `${report.message} ${report.gates.filter((g) => !g.passed).map((g) => `${g.gate} : ${g.details.slice(0, 2).join(' ; ')}`).join(' | ')}.${x.base ? ` La version v${x.base.n} reste active.` : ''}`, { version: n, certified: false });
  }
}
