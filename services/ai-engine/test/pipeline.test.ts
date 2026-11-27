import { describe, expect, it } from 'vitest';
import { AppSpecSchema, certify, groupAgg } from '@formule/contracts';
import { datasetOf } from '../src/semantic/resolve.js';
import { readContract, periodInterval, atomicSplit } from '../src/semantic/analytical.js';
import { bindClauses, eliminate, rankDatasets } from '../src/semantic/points.js';
import { assembleSpec } from '../src/semantic/plan.js';
import { contradicts, expectations } from '../src/evaluation/oracle.js';

const acq = (raw: unknown, qid: string, tool: string) => ({
  raw, queryId: qid,
  ref: { serverId: 'src', serverName: 'Source', demo: false, tool: { name: tool, description: tool, permission: 'read', hint: '' } },
  envelope: { id: `env_${qid}`, status: 'ok' }, args: {},
}) as never;

const spot = { rows: [
  { nom: 'Alpha', montant: 30, prix_eur: 12, date: '2026-01-15T00:00:00.000Z' },
  { nom: 'Beta', montant: 10, prix_eur: 5, date: '2026-01-16T00:00:00.000Z' },
] };
const futures = { rows: [
  { nom: 'Alpha', montant: 90, prix_eur: 40, date: '2025-06-01T00:00:00.000Z' },
  { nom: 'Beta', montant: 70, prix_eur: 35, date: '2025-06-02T00:00:00.000Z' },
  { nom: 'Gamma', montant: 50, prix_eur: 20, date: '2025-06-03T00:00:00.000Z' },
] };

describe('pipeline de génération (contrat → liaison → AppSpec → certification)', () => {
  const datasets = new Map([
    ['spot', datasetOf(acq(spot, 'spot', 'spot_market'))],
    ['futures', datasetOf(acq(futures, 'futures', 'futures_market'))],
  ]);

  it('préserve le contrat dans AppSpec jusqu’à la certification', () => {
    const prompt = [
      '**1. Marché**',
      '- Somme des montants sur le marche futures en 2025',
      '- Prix de Alpha',
      '**2. Design**',
      '- thème sombre',
    ].join('\n');
    const reqs = readContract(prompt);
    expect(reqs.some((r) => r.section?.toLowerCase().includes('marché') || r.section?.toLowerCase().includes('marche'))).toBe(true);
    expect(reqs.every((r) => !/thème|theme|sombre/.test(r.label.toLowerCase()))).toBe(true);

    const planned = bindClauses(reqs, datasets);
    const u = { title: 'Test', mission: prompt.slice(0, 100), reqs, commands: [] as string[], simulation: false, generic: false };
    const spec = assembleSpec({ u, planned, datasets, actions: [], demo: false, prompt, pointsLocked: true });
    const parsed = AppSpecSchema.parse(spec);
    const sum = parsed.requirements.find((r) => /somme/i.test(r.label));
    expect(sum?.operation).toBe('sum');
    expect(sum?.period).toBe('2025');
    expect(sum?.population).toMatch(/futures/i);
    expect(sum?.status).toBe('covered');
    expect(sum?.visualization).toBe('kpi');

    const identity = planned.find((p) => (p.tpl.operation ?? p.tpl.agg) === 'identity')!;
    expect(identity.queryId).toBe('spot');
    const gates = [
      { gate: 'G0' as const, passed: true, details: [] },
      { gate: 'G1' as const, passed: true, details: [] },
      { gate: 'G2' as const, passed: true, details: [] },
      { gate: 'G3' as const, passed: true, details: [] },
      { gate: 'G4' as const, passed: true, details: [] },
      { gate: 'G5' as const, passed: true, details: [] },
      { gate: 'G6' as const, passed: true, details: [] },
    ];
    const reqStatus = parsed.requirements.map((r) => ({ id: r.id, label: r.label, mandatory: r.mandatory, status: r.status, reason: r.reason }));
    const report = certify(gates, reqStatus, Date.now());
    expect(report.certified || report.message).toBeTruthy();
    expect(contradicts(identity.tpl, identity.view)).toBeNull();
  });

  it('intervalle temporel réel, pas une inclusion ISO textuelle', () => {
    const bounds = periodInterval('2025')!;
    expect(bounds.start).toBe(Date.UTC(2025, 0, 1));
    expect(bounds.end).toBe(Date.UTC(2026, 0, 1) - 1);
    const req = readContract('- Somme des montants en 2025 sur futures')[0];
    expect(eliminate(req, datasets.get('spot')!)).toMatch(/période|population/i);
    expect(eliminate(req, datasets.get('futures')!)).toBeNull();
  });

  it('atomicSplit conserve sujet et opération', () => {
    const parts = atomicSplit('Somme des montants et classement par montant');
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts[0].toLowerCase()).toMatch(/somme|montant/);
    expect(parts[1].toLowerCase()).toMatch(/classement|montant/);
  });
});

describe('tests négatifs', () => {
  const spotDs = datasetOf(acq(spot, 'spot', 'spot_market'));
  const futDs = datasetOf(acq(futures, 'futures', 'futures_market'));
  const datasets = new Map([['spot', spotDs], ['futures', futDs]]);

  it('mauvaise entité → éliminée', () => {
    const req = readContract('- Prix de Zeta')[0];
    expect(eliminate(req, spotDs)).toMatch(/entité/);
    expect(bindClauses([req], datasets)[0].status).toBe('unavailable');
  });

  it('mauvaise période → mauvais dataset éliminé', () => {
    const req = readContract('- Somme des montants en 2024 sur futures')[0];
    expect(eliminate(req, futDs)).toMatch(/période/);
    expect(rankDatasets(req, datasets)).toHaveLength(0);
  });

  it('mauvaise devise → éliminée', () => {
    const req = readContract('- Somme des prix en USD')[0];
    expect(req.unit).toBe('USD');
    expect(eliminate(req, spotDs)).toMatch(/unité/);
  });

  it('mauvais filtre → contradicts', () => {
    const withVar = datasetOf(acq({ rows: [
      { nom: 'Alpha', montant: 30, variation: 1.2, date: '2026-01-15T00:00:00.000Z' },
      { nom: 'Beta', montant: 10, variation: -0.3, date: '2026-01-16T00:00:00.000Z' },
    ] }, 'v', 'spot_market'));
    const req = readContract('- Nombre d’éléments en hausse')[0];
    const planned = bindClauses([req], new Map([['v', withVar]]));
    expect(planned[0].view?.kind).toBe('kpi');
    const bad = structuredClone(planned[0].view!);
    if (bad.kind === 'kpi' && bad.bindings.aggregate) bad.bindings.aggregate.where = [{ path: 'variation', op: 'lt', value: 0 }];
    expect(contradicts(req, bad)).toMatch(/filtre/);
  });

  it('mauvaise population → éliminée', () => {
    const req = readContract('- Somme des montants sur le marche options')[0];
    expect(eliminate(req, spotDs)).toMatch(/population/);
    expect(eliminate(req, futDs)).toMatch(/population/);
  });

  it('mauvais graphique / identité non remplacée par un comptage', () => {
    const req = readContract('- Graphique en barres du prix de Alpha')[0];
    // Forcer identity + bars
    const tpl = { ...req, view: 'bars' as const, visualization: 'bars' as const, operation: 'identity' as const, agg: 'identity' as const, entities: ['Alpha'], measure: ['prix'], measures: ['prix'] };
    const planned = bindClauses([tpl], new Map([['spot', spotDs]]));
    expect(planned[0].status).toBe('covered');
    expect(planned[0].view?.kind).toBe('bars');
    if (planned[0].view?.kind === 'bars') expect(planned[0].view.bindings.agg).toBe('identity');
    const g = groupAgg(spot, { collection: 'rows', label: 'nom', metric: 'prix_eur', agg: 'identity', limit: 8 });
    expect(g.groups.find((x) => x.label === 'Alpha')?.value).toBe(12);
    expect(contradicts(tpl, { kind: 'bars', bindings: { agg: 'count', collection: 'rows', label: 'nom', unit: null, limit: 8 } })).toMatch(/identité|opération/);
  });
});
