import { call } from '@formule/service-kit';
import {
  AppSpecSchema, certify, type AppSpec, type AppDataBundle, type GateResult, type RequirementStatus, type ViewSpec, type AcquisitionEnvelope,
} from '@formule/contracts';
import { acquire, getCatalog, namedServerIds, resolveArgs, type Acquired, type CatalogServer, type ToolRef } from '../discovery/catalog.js';
import { understand, type ReqTemplate, type Understanding } from '../semantic/lexicon.js';
import { datasetOf, resolveRequirement, type Dataset } from '../semantic/resolve.js';
import { assembleSpec, bindTools, planActions, planRequirements, queryIdFor, type PlannedReq } from '../semantic/plan.js';
import { draftAnalytical } from '../semantic/analytical.js';
import { acquisitionKey, planAcquisitions, type PlannedAcquisition } from '../semantic/acquire-plan.js';
import { bindClauses } from '../semantic/points.js';
import { applyCorrection, bindAndCompose, coverageGaps, createRuntimeBudgets, diagnoseCorrection, sealContract } from '../semantic/hybrid.js';
import {
  assertIntentIntact, fidelityAgainstPrompt, independentPromptAudit, intentKey,
  type ContractConstraints, type SealedContract,
} from '../semantic/contract-guard.js';
import { isDerivedDataset, recomputeDerivedDatasets } from '../semantic/fusion.js';
import { isMultiSection } from '../semantic/sections.js';
import { buildWorkspace, cleanupWorkspace, createWorkspace, shadcnAdd, writeWorkspaceFile } from './workspace.js';
import { emit, setState, type JobRef } from './events.js';
import { matchView, parseDelta, untouchedEqual, type DeltaOp } from './delta.js';
import { backendVsOracle, contractGate, runDomCheck, sourceGate, staticGates } from '../evaluation/gates.js';
import { contradicts, expectations } from '../evaluation/oracle.js';
import { isDemoMode } from '../llm.js';
import { engineBanner } from '../semantic/engine-meta.js';

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

async function acquireFromPlan(
  job: JobRef,
  planned: PlannedAcquisition[],
  projectId: string | null,
  usedIds = new Set<string>(),
  limitedServers = new Set<string>(),
  maxPages?: number,
) {
  const acqs: Acquired[] = [];
  for (const p of planned) {
    check(job);
    const { ref, args } = p;
    if (limitedServers.has(ref.serverId)) continue;
    const suffix = 'code' in args ? `_${String(args.intent ?? 'gabarit').replace(/^Formule : /, '')}` : Object.keys(args).length ? `_${Object.values(args).map(String).join('_').split('/').pop()}` : '';
    const baseId = (queryIdFor(ref.serverId, ref.tool.name) + suffix).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 40);
    let qid = baseId; let n = 2;
    while (usedIds.has(qid)) qid = baseId.slice(0, 32) + '_' + n++;
    usedIds.add(qid);
    await emit(job, 'log', { text: `Lecture ${ref.serverName} · ${ref.tool.name}${'code' in args ? ` (gabarit relu : ${args.intent})` : Object.keys(args).length ? ` ${JSON.stringify(args)}` : ''}${p.forReqIds[0] !== '*' ? ` ← ${p.forReqIds.join(',')}` : ''}` });
    const a = await acquire(ref, qid, { jobId: job.id, projectId, maxPages }, args);
    acqs.push(a);
    if (a.envelope.error?.kind === 'quota' || a.envelope.error?.kind === 'rate_limited') limitedServers.add(ref.serverId);
    await emit(job, 'log', { text: `${ref.tool.name} : ${a.envelope.status}${a.envelope.error ? ` (${a.envelope.error.kind}) — ${a.envelope.error.message}` : ''}${a.envelope.coverage.note ? ` — ${a.envelope.coverage.note}` : ''}`, retryAfterMs: a.envelope.error?.retryAfterMs });
  }
  return acqs;
}

async function acquireAll(job: JobRef, refs: ToolRef[], projectId: string | null, prompt = '', catalog: CatalogServer[] = []) {
  const acqs: Acquired[] = [];
  for (const ref of refs) {
    check(job);
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

function uniqueRefs(catalog: CatalogServer[], tools: { serverId: string; tool: string }[]): ToolRef[] {
  const seen = new Set<string>(); const out: ToolRef[] = [];
  for (const t of tools) {
    const k = `${t.serverId}__${t.tool}`; if (seen.has(k)) continue; seen.add(k);
    const srv = catalog.find((s) => s.serverId === t.serverId)!;
    out.push({ serverId: srv.serverId, serverName: srv.name, demo: srv.demo, tool: srv.tools.find((x) => x.name === t.tool)! });
  }
  return out;
}

// ------------------------------------------------------------------ création
async function create(job: JobRef, input: { prompt: string; fileIds: string[] }) {
  await setState(job, 'DISCOVERY');
  const catalog = await getCatalog();
  for (const s of catalog) if (s.status === 'error') await emit(job, 'log', { text: `Source ${s.name} indisponible : ${s.error?.kind}` });
  // Sections ou non : un seul contrat analytique, un seul planificateur d'acquisitions.
  return runContractBuild(job, { prompt: input.prompt, fileIds: input.fileIds, catalog });
}

async function createFromSections(job: JobRef, input: { prompt: string }, catalog: CatalogServer[]) {
  return runContractBuild(job, { prompt: input.prompt, fileIds: [], catalog });
}

/** Pipeline unique : contrat → plan d'acquisitions → liaison → certification. */
async function runContractBuild(job: JobRef, input: { prompt: string; fileIds: string[]; catalog: CatalogServer[] }) {
  const { prompt, fileIds, catalog } = input;
  await emit(job, 'log', { text: engineBanner() });
  if (isMultiSection(prompt)) await emit(job, 'log', { text: 'Demande structurée : contrat analytique unique (sections conservées comme parenté)' });
  const named = namedServerIds(prompt, catalog);
  const scoped = named.length ? catalog.filter((s) => named.includes(s.serverId)) : catalog;
  if (named.length) await emit(job, 'log', { text: `Périmètre : ${scoped.map((s) => s.name).join(', ')}` });

  let u: Understanding = understand(prompt, scoped);
  const budgets = createRuntimeBudgets();
  const { llm: budget, mcp } = budgets;
  budget.take(); // appel 1 consommé dans draftAnalytical / interpretAndPlan
  const draft = await draftAnalytical(prompt, u, scoped, { budget });
  if (!draft.ok) {
    await setState(job, 'BLOCKED');
    await emit(job, 'answer', { text: `${draft.reason ?? 'Interprétation sémantique échouée.'} Vérifie le diagnostic LLM et les champs signalés ; aucune acquisition MCP n’a été lancée.` });
    return;
  }
  if (draft.source === 'demo_pack') {
    await emit(job, 'log', { text: `Contrat démo (pack) — ${draft.reason ?? 'sans LLM'}` });
  }
  let constraints: ContractConstraints = { ...draft.constraints };
  let sealed: SealedContract = draft.sealed ?? sealContract(prompt, draft.u.reqs, draft.coverage, constraints);
  let reqs = [...sealed.reqs];
  u = { ...draft.u, reqs };
  constraints = sealed.constraints;
  const coverage = [...sealed.coverage];
  await emit(job, 'log', { text: `Contrat analytique scellé (${draft.source} · ${sealed.fingerprint}) : ${reqs.map((r) => `${r.label} [${r.visualization ?? r.view}${r.operation ?? r.agg ? ` ${r.operation ?? r.agg}` : ''}]`).join(' · ')}` });
  if (constraints.design.length || constraints.interactions.length || constraints.reliability.length) {
    await emit(job, 'log', { text: `Contraintes conservées : ${[...constraints.design, ...constraints.interactions, ...constraints.reliability, ...constraints.global].slice(0, 8).join(' · ')}` });
  }
  check(job);
  if (!reqs.length) return blocked(job, prompt, named.length ? scoped : catalog);

  // Couverture structurée + audit structurel AVANT toute acquisition (pas de matching lexical).
  let gapsBefore = [
    ...coverageGaps(coverage, reqs, constraints),
    ...independentPromptAudit(prompt, reqs, constraints),
  ];
  if (gapsBefore.length) {
    await emit(job, 'log', { text: `Couverture incomplète avant lecture : ${gapsBefore.slice(0, 4).join(' ; ')}` });
    const preFix = await diagnoseCorrection(
      prompt,
      reqs.map((r) => ({ tpl: r, status: 'missing' as const, reason: 'hors coverage' })),
      gapsBefore,
      { budget },
    );
    if (preFix?.patchRequirements?.length || preFix?.dropRequirementIds?.length) {
      reqs = applyCorrection(reqs, preFix, new Set());
      const intact = assertIntentIntact(sealed, reqs);
      if (intact.length) {
        await emit(job, 'log', { text: `Correction refusée (contrat scellé) : ${intact.slice(0, 3).join(' ; ')}` });
        reqs = [...sealed.reqs];
      } else {
        u = { ...u, reqs };
        gapsBefore = [...coverageGaps(coverage, reqs, constraints), ...independentPromptAudit(prompt, reqs, constraints)];
        await emit(job, 'log', { text: `Contrat corrigé avant acquisition${preFix.note ? ` : ${preFix.note}` : ''}` });
      }
    }
    if (gapsBefore.length) {
      await setState(job, 'BLOCKED');
      await emit(job, 'answer', { text: `Le contrat ne couvre pas le prompt : ${gapsBefore.join(' ; ')}. Corrige l’interprétation avant toute lecture MCP.` });
      return;
    }
  }

  const acqHints = { toolHints: draft.toolHints, argHints: draft.argHints, groups: draft.acquisitions };
  const { planned: acqPlan, unresolved } = await planAcquisitions(reqs, scoped, prompt, fileIds, new Set(), acqHints, mcp);
  if (!acqPlan.length) {
    if (unresolved.length) {
      await setState(job, 'BLOCKED');
      await emit(job, 'answer', { text: `Aucune lecture autorisée ne couvre le contrat : ${unresolved.join(' ; ')}. Précise les arguments obligatoires (fichier, devise, période…).` });
      return;
    }
    return blocked(job, prompt, named.length ? scoped : catalog);
  }
  await emit(job, 'log', { text: `Acquisitions mutualisées : ${acqPlan.length} lecture(s) pour ${reqs.filter((r) => r.view !== 'note').length} exigence(s) · budget MCP ${mcp.usedReads}/${mcp.maxReads}` });

  const usedIds = new Set<string>();
  const limitedServers = new Set<string>();
  const acqs = await acquireFromPlan(job, acqPlan, null, usedIds, limitedServers, mcp.maxPages);
  const datasets = new Map<string, Dataset>();
  for (const a of acqs) datasets.set(a.queryId, datasetOf(a));

  // Appel 2 : liaison sémantique proposée ; le moteur valide (intentions scellées).
  const composed = await bindAndCompose(prompt, reqs, datasets, { budget, sealed });
  if (composed.source === 'llm') {
    const intact = assertIntentIntact(sealed, composed.reqs);
    if (intact.length) {
      await emit(job, 'log', { text: `Liaison IA partiellement refusée (intentions figées) : ${intact.slice(0, 3).join(' ; ')}` });
      // Conserve mesures/outils proposés seulement si l'intention reste intacte (intentKey intégral).
      reqs = composed.reqs.map((r) => {
        const lock = sealed.intentLock.get(r.id);
        const orig = sealed.reqs.find((x) => x.id === r.id);
        if (!orig || !lock) return orig ?? r;
        return intentKey(r) === lock ? r : orig;
      });
    } else {
      reqs = composed.reqs;
    }
    u = { ...u, reqs };
    await emit(job, 'log', { text: 'Liaison sémantique proposée par l’IA (vérification déterministe)' });
  } else if (composed.reason) {
    await emit(job, 'log', { text: composed.reason });
  }

  let planned: PlannedReq[] = bindClauses(reqs, datasets);
  const attempted = new Set(acqPlan.map((p) => acquisitionKey(p.ref, p.args)));

  // Correction de contrat AVANT de multiplier les acquisitions (1 tour LLM max restant).
  const earlyGaps = planned.filter((p) => p.tpl.mandatory && p.status !== 'covered' && p.tpl.view !== 'note');
  if (earlyGaps.length) {
    const correction = await diagnoseCorrection(prompt, planned, earlyGaps.map((g) => `${g.tpl.id}: ${g.reason ?? g.status}`), { budget });
    if (correction) {
      const allowedQ = new Set([...datasets.keys()].filter((qid) => {
        const ds = datasets.get(qid);
        return ds && ds.acq.envelope.status !== 'error' && !limitedServers.has(ds.acq.ref.serverId) && !isDerivedDataset(ds);
      }));
      const candidate = applyCorrection(reqs, correction, allowedQ);
      const intact = assertIntentIntact(sealed, candidate);
      if (intact.length) {
        await emit(job, 'log', { text: `Correction refusée (exigences obligatoires protégées) : ${intact.slice(0, 3).join(' ; ')}` });
      } else {
        reqs = candidate;
        u = { ...u, reqs };
        planned = bindClauses(reqs, datasets);
        await emit(job, 'log', { text: `Correction de contrat avant nouvelles lectures${correction.note ? ` : ${correction.note}` : ''}` });
      }
    }
  }

  // Un seul tour d'acquisition supplémentaire, borné par le budget MCP retry.
  {
    check(job);
    const missing = planned.filter((p) => p.status !== 'covered' && p.tpl.view !== 'note').map((p) => p.tpl);
    const available = scoped.filter((s) => !limitedServers.has(s.serverId));
    if (missing.length && available.length && mcp.takeRetry()) {
      const next = await planAcquisitions(missing, available, prompt, fileIds, attempted, acqHints, mcp);
      const candidates = next.planned.slice(0, Math.min(8, mcp.remainingReads || 8));
      if (candidates.length) {
        for (const p of candidates) attempted.add(acquisitionKey(p.ref, p.args));
        const retry = await acquireFromPlan(job, candidates, null, usedIds, limitedServers, mcp.maxPages);
        for (const a of retry) { acqs.push(a); datasets.set(a.queryId, datasetOf(a)); }
        planned = bindClauses(reqs, datasets);
      }
    }
  }

  // Fidélité vs prompt original + couverture (jamais adapter l'intention aux données).
  // Couverture structurée sur le contrat entier (pas seulement les covered — sinon checklist → faux positifs).
  const afterGaps = [
    ...coverageGaps(coverage, planned.map((p) => p.tpl), constraints),
    ...fidelityAgainstPrompt(sealed, planned),
    ...assertIntentIntact(sealed, planned.map((p) => p.tpl)),
  ];
  if (afterGaps.length) {
    await emit(job, 'log', { text: `Fidélité partielle après liaison : ${afterGaps.slice(0, 4).join(' ; ')}` });
  }
  for (const p of planned) await emit(job, 'log', { text: `Lien · ${p.tpl.label} → ${p.status}${p.reason ? ` (${p.reason})` : ''} [${p.tpl.visualization ?? p.tpl.view}${p.tpl.operation ?? p.tpl.agg ? ` ${p.tpl.operation ?? p.tpl.agg}` : ''}]` });

  const covered = planned.filter((p) => p.tpl.mandatory && p.status === 'covered');
  const summary = {
    sources: sourceSummary(acqs),
    requirements: planned.map((p) => ({
      id: p.tpl.id, label: p.tpl.label, mandatory: p.tpl.mandatory, status: p.status, reason: p.reason ?? null,
      visualization: p.tpl.visualization ?? p.tpl.view, operation: p.tpl.operation ?? p.tpl.agg ?? null,
      entities: p.tpl.entities ?? null, population: p.tpl.population ?? null, period: p.tpl.period ?? null,
    })),
    canApprove: covered.length > 0,
    demo: acqs.some((a) => a.ref.demo),
    engine: engineBanner(),
    contractFingerprint: sealed.fingerprint,
    llmBudgetUsed: budget.used,
    mcpBudget: mcp.snapshot(),
  };
  await emit(job, 'source', summary);
  if (!summary.canApprove) {
    await setState(job, 'BLOCKED');
    await say(job, `Je n’ai lu aucune donnée compatible avec le contrat. ${planned.map((p) => `${p.tpl.label} : ${p.reason ?? p.status}`).join(' ; ')}.`);
    return;
  }

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
  await call('storage', `/projects/${project.id}/messages`, { body: { role: 'user', content: { text: prompt } } });
  await call('storage', `/projects/${project.id}/messages`, { body: { role: 'agent', content: { kind: 'sourcing', ...summary, decision: 'validé' } } });
  await emit(job, 'log', { text: 'Sources validées par l’utilisateur', projectId: project.id });

  await setState(job, 'CONTRACT');
  const usedServers = new Set(acqs.filter((a) => a.envelope.status !== 'error').map((a) => a.ref.serverId));
  // Certification fonctionnelle : assembler contre le prompt/contrat scellé (constraints conservées).
  const fidelity = fidelityAgainstPrompt(sealed, planned);
  if (fidelity.filter((g) => /intention dérivée|non couverte/.test(g)).length) {
    await emit(job, 'log', { text: `Avertissement fidélité avant build : ${fidelity.slice(0, 3).join(' ; ')}` });
  }
  const spec = assembleSpec({
    u, planned, datasets,
    actions: planActions(catalog, usedServers, datasets),
    demo: summary.demo, prompt, pointsLocked: true, constraints,
  });
  await buildAndCertify(job, { spec, datasets, catalog, base: null, touched: new Set() });
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
  // Les datasets dérivés (fuse_*) ne sont jamais relus via MCP : on les recalcule après.
  const budgets = createRuntimeBudgets();
  if (!styleOnly && Date.now() - oldest > FRESH_MS) {
    await emit(job, 'log', { text: 'Données de plus de 24 h : nouvelle lecture des sources MCP (hors dérivés)' });
    const mcpQueries = base.queries.filter((q) => {
      const ds = datasets.get(q.id);
      return !ds || !isDerivedDataset(ds);
    });
    const refs = uniqueRefs(catalog, mcpQueries.map((q) => ({ serverId: q.serverId, tool: q.tool })).filter((t) => catalog.some((s) => s.serverId === t.serverId && s.tools.some((x) => x.name === t.tool))));
    for (const q of mcpQueries) {
      if (!budgets.mcp.takeRead()) {
        await emit(job, 'log', { text: 'Budget MCP lectures épuisé pendant le rafraîchissement' });
        break;
      }
      const ref = refs.find((r) => r.serverId === q.serverId && r.tool.name === q.tool); if (!ref) continue;
      const a = await acquire(ref, q.id, { jobId: job.id, projectId, maxPages: budgets.mcp.maxPages }, q.args);
      if (a.envelope.status !== 'error') datasets.set(q.id, datasetOf(a));
    }
    // Recalcul déterministe des fusions : reprendre les props analytiques scellées (entities/period…),
    // avec repli sur les séries multi-colonnes de la vue line liée.
    const reqsFromSpec: ReqTemplate[] = base.requirements.map((r) => {
      const linked = base.views.find((v) =>
        (r.evidence?.viewId && v.id === r.evidence.viewId)
        || ('requirementIds' in v && Array.isArray(v.requirementIds) && v.requirementIds.includes(r.id)),
      );
      const fromSeries = linked && linked.kind === 'line' && linked.bindings.series.length > 1
        ? linked.bindings.series.map((s) => s.label)
        : undefined;
      const view = (r.visualization ?? (linked && 'kind' in linked ? linked.kind : 'kpi')) as ReqTemplate['view'];
      return {
        id: r.id, label: r.label, mandatory: r.mandatory, tool: ['*'], title: r.label,
        view, visualization: view,
        entities: r.entities?.length ? [...r.entities] : fromSeries,
        period: r.period, population: r.population, unit: r.unit ?? r.inputUnit,
        limit: r.limit, order: r.order,
        operation: r.operation as ReqTemplate['operation'],
        agg: r.operation as ReqTemplate['agg'],
      };
    });
    const recomputed = recomputeDerivedDatasets(reqsFromSpec, datasets);
    for (const [qid, ds] of recomputed) datasets.set(qid, ds);
    await emit(job, 'log', { text: `Dérivés recalculés : ${[...recomputed.keys()].filter((k) => k.startsWith('fuse_')).length}` });
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
    if (r.visualization) {
      const clash = contradicts({ ...r, view: r.visualization }, spec.views.find((v) => v.id === vid));
      if (clash) return { id: r.id, label: r.label, mandatory: r.mandatory, status: 'missing', reason: clash };
    }
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

  // Réparation bornée (1 tentative) : diagnostic IA optionnel puis retrait déterministe des vues cassées.
  // Pas de nouvel appel MCP ici — les serveurs limités (PR#5) restent hors reprise.
  if (report.outcome === 'REPAIR' && attempt === 0) {
    const broken = new Set(dom?.results.filter((r) => !r.ok).map((r) => r.viewId) ?? []);
    const fixable = broken.size > 0 && report.blockingGates.every((g) => g === 'G5' || g === 'G6');
    if (fixable) {
      await setState(job, 'REPAIR');
      const divergences = [
        ...reqs.filter((r) => r.status !== 'covered').map((r) => `${r.id}: ${r.reason ?? r.status}`),
        ...[...broken].map((id) => `vue ${id}: liaison DOM échouée`),
      ];
      const plannedLike: PlannedReq[] = reqs.map((r) => ({
        tpl: { id: r.id, label: r.label, mandatory: r.mandatory, tool: ['*'], view: r.visualization ?? 'kpi', title: r.label, visualization: r.visualization ?? 'kpi' },
        status: r.status,
        reason: r.reason,
      }));
      const correction = await diagnoseCorrection(spec.mission, plannedLike, divergences);
      if (correction?.dropRequirementIds?.length) {
        await emit(job, 'log', { text: `Correction : retrait proposé de ${correction.dropRequirementIds.length} exigence(s)` });
      }
      await emit(job, 'log', { text: `Réparation : retrait de ${broken.size} vue(s) mal liée(s)` });
      const drop = new Set(correction?.dropRequirementIds ?? []);
      const repaired: AppSpec = {
        ...spec,
        views: spec.views.filter((v) => !broken.has(v.id)),
        requirements: spec.requirements.map((r) => {
          if (drop.has(r.id) || (r.evidence && broken.has(r.evidence.viewId))) {
            return { ...r, status: 'missing' as const, reason: reqs.find((q) => q.id === r.id)?.reason ?? correction?.note, evidence: null };
          }
          return r;
        }),
      };
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
