import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate, rank, type AppSpec, type GateResult, type ViewSpec } from '@formule/contracts';
import { call } from '@formule/service-kit';
import type { Dataset } from '../semantic/resolve.js';
import { expectations, type Expectation } from './oracle.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface DomReport { results: { viewId: string; ok: boolean; diag?: string }[]; errors: string[]; alerts: string[]; blank: boolean; interacted: boolean }

export function runDomCheck(html: string, exps: Expectation[]): Promise<DomReport> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'dom-check.ts')], {
      env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production' }, stdio: ['pipe', 'pipe', 'pipe'], timeout: 45_000,
    });
    let out = '', err = '';
    child.stdout.on('data', (c) => (out += c)); child.stderr.on('data', (c) => (err += c));
    child.on('close', () => {
      try { resolve(JSON.parse(out)); } catch { resolve({ results: [], errors: [`contrôle navigateur en échec : ${err.slice(-300)}`], alerts: [], blank: true, interacted: false }); }
    });
    child.stdin.end(JSON.stringify({ html, expectations: exps }));
  });
}

/** G4 : le calcul embarqué dans l'app (aggregate/rank) doit égaler l'oracle indépendant. */
export function backendVsOracle(views: ViewSpec[], raws: Record<string, unknown>, refTimes: Record<string, number>): GateResult {
  const exps = expectations(views, raws, refTimes);
  const details: string[] = [];
  for (const e of exps) {
    const v = views.find((x) => x.id === e.viewId)!;
    if (e.kind === 'kpi' && v.kind === 'kpi' && v.bindings.aggregate) {
      const r = aggregate(raws[v.queryId], v.bindings.aggregate, v.bindings.unit, refTimes[v.queryId]);
      const got = v.bindings.aggregate.agg === 'top' ? (r.label ?? '') : r.state === 'available' || r.state === 'partial' ? String(r.value) : '';
      if (got !== e.value) details.push(`${v.title} : runtime ${got || '∅'} ≠ oracle ${e.value || '∅'}`);
    }
    if (e.kind === 'ranking' && v.kind === 'ranking') {
      const r = rank(raws[v.queryId], v.bindings);
      const got = r.rows[0] ? `${r.rows[0].label}=${r.rows[0].value}` : '';
      if (got !== e.first) details.push(`${v.title} : runtime ${got} ≠ oracle ${e.first}`);
    }
  }
  return { gate: 'G4', passed: details.length === 0, details: details.length ? details : [`${exps.length} vérification(s) concordantes avec l’oracle`] };
}

export async function staticGates(spec: AppSpec, html: string | null, buildOk: boolean, buildLog: string, catalog: unknown[], raws: Record<string, unknown> = {}): Promise<GateResult[]> {
  // hôtes cités dans les données lues (liens vers les sources) : ce sont des données, pas des appels
  const dataHosts = [...new Set([...JSON.stringify(raws).matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()))];
  const vs = await call<{ ok: boolean; findings: { rule: string; detail: string }[] }>('validator', '/validate/spec', { body: { spec, catalog } });
  const vh = html ? await call<{ ok: boolean; findings: { rule: string; severity: string; detail: string }[] }>('validator', '/validate/html', { body: { html, dataHosts } }) : { ok: false, findings: [] };
  return [
    { gate: 'G0', passed: vs.findings.filter((f) => /outil-invente|requete-non-lecture|action-non-autorisee/.test(f.rule)).length === 0, details: (() => { const bad = vs.findings.filter((f) => /outil|requete|action/.test(f.rule)).map((f) => `${f.rule} : ${f.detail}`); return bad.length ? bad : [`${spec.queries.length} lecture(s) autorisée(s), ${spec.actions.length} action(s) d’écriture autorisée(s) sous confirmation`]; })() },
    { gate: 'G3', passed: buildOk && vh.ok, details: [...(buildOk ? ['build vite OK'] : [`build en échec : ${buildLog.slice(-300)}`]), ...vh.findings.map((f) => `${f.severity} ${f.rule} : ${f.detail}`)] },
    { gate: 'G2', passed: vs.ok, details: vs.findings.map((f) => `${f.rule} : ${f.detail}`) },
  ];
}

export function contractGate(spec: AppSpec, datasets: Map<string, Dataset>, base: GateResult): GateResult {
  const details = [...base.details];
  for (const v of spec.views) {
    if (!('queryId' in v)) continue;
    const ds = datasets.get(v.queryId);
    if (!ds) { details.push(`${v.id} : requête sans contrat`); continue; }
    const paths: string[] = [];
    if (v.kind === 'kpi') { if (v.bindings.value) paths.push(v.bindings.value); const a = v.bindings.aggregate; if (a) { if (a.measure) paths.push(`${a.collection}[].${a.measure}`); if (a.den) paths.push(`${a.collection}[].${a.den}`); } }
    if (v.kind === 'line') v.bindings.series.forEach((s) => paths.push(`${v.bindings.collection}[].${s.path}`));
    if (v.kind === 'ranking') paths.push(`${v.bindings.collection}[].${v.bindings.metric}`);
    for (const p of paths) {
      const f = ds.contract.fields.find((x) => x.path === p);
      if (!f) details.push(`${v.id} : chemin ${p} absent du contrat`);
      else if (f.type !== 'number') details.push(`${v.id} : ${p} de type ${f.type}, mesure numérique attendue`);
      else if ((f.units?.length ?? 0) > 1 && !(v.kind === 'kpi' && v.bindings.aggregate?.unitPath)) details.push(`${v.id} : ${p} porte plusieurs unités (${f.units!.join(', ')}) sans contrôle`);
    }
  }
  const failed = details.filter((d) => / : /.test(d) && !/^schema|^id-/.test(d));
  return { gate: 'G2', passed: base.passed && failed.length === 0, details: details.length ? details : ['contrat, types, unités et provenance cohérents'] };
}

export function sourceGate(datasets: Map<string, Dataset>, spec: AppSpec): GateResult {
  const details: string[] = [];
  let ok = spec.queries.length > 0;
  if (!ok) details.push('aucune requête : aucune source réelle lue');
  for (const q of spec.queries) {
    const ds = datasets.get(q.id);
    if (!ds || ds.acq.envelope.status === 'error') { ok = false; details.push(`${q.tool} : lecture en échec`); continue; }
    if (!ds.acq.envelope.hash) { ok = false; details.push(`${q.tool} : brut sans empreinte`); }
    if (ds.docOnly) { ok = false; details.push(`${q.tool} : documentation seule, aucune mesure`); }
    details.push(`${ds.acq.ref.serverName} · ${q.tool} : ${ds.acq.envelope.status}${ds.acq.envelope.coverage.complete ? '' : ` (${ds.acq.envelope.coverage.note})`}${ds.acq.ref.demo ? ' · source de démonstration' : ''}`);
  }
  return { gate: 'G1', passed: ok, details };
}
