import { describe, expect, it } from 'vitest';
import { aggregate } from '@formule/contracts';
import { datasetOf } from '../src/semantic/resolve.js';
import { readContract } from '../src/semantic/analytical.js';
import { bindClauses } from '../src/semantic/points.js';
import { contradicts, expectations } from '../src/evaluation/oracle.js';

const acq = (raw: unknown) => ({ raw, queryId: 'q', ref: { serverId: 'src', serverName: 'Source', demo: false, tool: { name: 'lire', description: '', permission: 'read', hint: '' } }, envelope: { id: 'env1', status: 'ok' }, args: {} }) as never;

const raw = { rows: [
  { nom: 'Alpha', montant: 30, prix_eur: 10, variation: 1.2, rang: 1, date: '2026-01-01T00:00:00.000Z' },
  { nom: 'Beta', montant: 10, prix_eur: 4, variation: -0.3, rang: 2, date: '2026-01-02T00:00:00.000Z' },
  { nom: 'Gamma', montant: 20, prix_eur: 8, variation: 0.4, rang: 3, date: '2026-01-03T00:00:00.000Z' },
] };

const prompt = [
  '- Nombre d’éléments',
  '- Nombre d’éléments en hausse',
  '- Part de Alpha sur le montant',
  '- Courbe du montant',
  '- Graphique circulaire des montants',
  '- Classement par montant',
  '- Somme des prix',
].join('\n');

describe('contrat analytique', () => {
  const contract = readContract(prompt);
  const planned = bindClauses(contract, new Map([['q', datasetOf(acq(raw))]]));
  const by = (fragment: string) => {
    const i = contract.findIndex((r) => r.label.toLowerCase().includes(fragment));
    return { req: contract[i], plan: planned[i] };
  };

  it('fige la vue et l’opération avant les données, même si la collection est une série', () => {
    expect(by('circulaire').req.view).toBe('donut');
    expect(by('circulaire').plan.view?.kind).toBe('donut');
    expect(contradicts(by('circulaire').req, by('circulaire').plan.view)).toBeNull();
    expect(by('courbe').plan.view?.kind).toBe('line');
    expect(by('classement').plan.view?.kind).toBe('ranking');
  });

  it('compte, filtre et rapporte une part au lieu de sommer', () => {
    const count = by('nombre d’éléments');
    expect(count.req.agg).toBe('count');
    expect(count.plan.view?.kind).toBe('kpi');
    const hausse = planned.find((p) => p.tpl.label.toLowerCase().includes('hausse'))!;
    expect(hausse.tpl.agg).toBe('count');
    expect(hausse.tpl.where?.[0]).toMatchObject({ op: 'gt', value: 0 });
    expect(hausse.status).toBe('covered');
    const part = by('part de alpha');
    expect(part.req.agg).toBe('ratio');
    expect(part.req.denWhere).toEqual([]);
    expect(part.plan.status).toBe('covered');
    const somme = by('somme des prix');
    expect(somme.req.agg).toBe('sum');
    expect(somme.plan.status).not.toBe('covered');
    expect(somme.plan.reason).toMatch(/non additive/);
  });

  it('l’oracle recalcule le contrat, pas une somme de substitution', () => {
    const hausse = planned.find((p) => p.tpl.label.toLowerCase().includes('hausse'))!;
    const part = planned.find((p) => p.tpl.agg === 'ratio')!;
    expect(part.view?.kind).toBe('kpi');
    expect(part.tpl.where?.[0]).toMatchObject({ op: 'eq', value: 'Alpha' });
    const exp = expectations([hausse.view!, part.view!], { q: raw }, { q: Date.now() });
    expect(exp.find((e) => e.viewId === hausse.view!.id)).toMatchObject({ value: '2' });
    expect(exp.find((e) => e.viewId === part.view!.id)).toMatchObject({ value: '50' });
    expect(aggregate(raw, { collection: 'rows', agg: 'sum', measure: 'prix_eur', where: [], percent: false }, null, 0).state).toBe('invalid');
    expect(aggregate(raw, { collection: 'rows', agg: 'count', where: [{ path: 'variation', op: 'gt', value: 0 }], percent: false }, null, 0).value).toBe(2);
    expect(aggregate(raw, { collection: 'rows', agg: 'ratio', measure: 'montant', where: [{ path: 'nom', op: 'eq', value: 'Alpha' }], denWhere: [], percent: true }, null, 0).value).toBe(50);
  });

  it('signale un dépassement de capacité au lieu de couper en silence', () => {
    const many = Array.from({ length: 41 }, (_, i) => `- Nombre d’éléments ${i}`).join('\n');
    const reqs = readContract(many);
    expect(reqs).toHaveLength(40);
    expect(reqs.at(-1)?.id).toBe('capacite_depassee');
    expect(reqs.at(-1)?.acceptance).toMatch(/2 exigences/);
  });
});
