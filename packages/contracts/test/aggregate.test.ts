import { describe, expect, it } from 'vitest';
import { aggregate, filterRows } from '../src/aggregate.js';

const rows = [
  { nom: 'Alpha', montant: 30, variation: 1.2 },
  { nom: 'Beta', montant: 10, variation: -0.4 },
  { nom: 'Gamma', montant: 20, variation: 0 },
];

describe('filtres et agrégations', () => {
  it('compare, inclut et borne', () => {
    expect(filterRows(rows, [{ path: 'variation', op: 'gt', value: 0 }], 0)).toHaveLength(1);
    expect(filterRows(rows, [{ path: 'variation', op: 'gte', value: 0 }], 0)).toHaveLength(2);
    expect(filterRows(rows, [{ path: 'montant', op: 'between', value: [10, 20] }], 0)).toHaveLength(2);
    expect(filterRows(rows, [{ path: 'nom', op: 'in', value: ['Alpha', 'Gamma'] }], 0)).toHaveLength(2);
    expect(filterRows(rows, [{ path: 'montant', op: 'lte', value: 10 }], 0)).toHaveLength(1);
    expect(filterRows(rows, [{ path: 'variation', op: 'lt', value: 0 }], 0)).toHaveLength(1);
  });

  it('rapporte une population filtrée à la population entière', () => {
    const r = aggregate({ rows }, { collection: 'rows', agg: 'ratio', where: [{ path: 'nom', op: 'eq', value: 'Alpha' }], denWhere: [], percent: true }, null, 0);
    expect(r.value).toBeCloseTo(33.33, 1);
  });

  it('identité : mesure brute d’une seule entité, refus si ambiguë', () => {
    const one = aggregate({ rows }, { collection: 'rows', agg: 'identity', measure: 'montant', where: [{ path: 'nom', op: 'eq', value: 'Alpha' }], percent: false }, null, 0);
    expect(one).toMatchObject({ state: 'available', value: 30 });
    const many = aggregate({ rows }, { collection: 'rows', agg: 'identity', measure: 'montant', where: [], percent: false }, null, 0);
    expect(many.state).toBe('invalid');
  });
});
