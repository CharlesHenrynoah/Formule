import { describe, expect, it } from 'vitest';
import { NON_ADDITIVE } from '../src/aggregate.js';
import { executeTransformPlan, planFromIntent, validateTransformPlan } from '../src/transform.js';

const raw = {
  rows: [
    { nom: 'Alpha', variation: 12, montant: 30, population: 'spot' },
    { nom: 'Beta', variation: -4, montant: 10, population: 'spot' },
    { nom: 'Gamma', variation: 8, montant: 20, population: 'spot' },
    { nom: 'Delta', variation: 1, montant: 5, population: 'futures' },
  ],
};

describe('TransformPlan', () => {
  it('valide SORT+LIMIT et refuse SUM sur non-additif', () => {
    const ok = validateTransformPlan({
      source: { collection: 'rows' },
      steps: [
        { op: 'SORT', by: 'variation', order: 'desc' },
        { op: 'LIMIT', n: 2 },
      ],
    });
    expect(ok.ok).toBe(true);
    const bad = validateTransformPlan({
      source: { collection: 'rows' },
      steps: [{ op: 'SUM', measure: 'price_usd' }, { op: 'LIMIT', n: 5 }],
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.some((e) => /SUM|LIMIT|SORT|additive/i.test(e))).toBe(true);
  });

  it('RATIO à partir d’un comptage conditionnel (parts hausse)', () => {
    const plan = planFromIntent({
      collection: 'rows',
      operation: 'ratio',
      where: [{ path: 'variation', op: 'gt', value: 0 }],
      percent: true,
    });
    expect(plan.steps.some((s) => s.op === 'FILTER')).toBe(true);
    expect(plan.steps.some((s) => s.op === 'RATIO')).toBe(true);
    const filtered = executeTransformPlan(raw, {
      source: { collection: 'rows' },
      steps: [
        { op: 'FILTER', where: [{ path: 'variation', op: 'gt', value: 0 }] },
        { op: 'RATIO', percent: true },
      ],
    });
    expect(filtered.kind).toBe('scalar');
    if (filtered.kind === 'scalar') {
      expect(filtered.unit).toBe('%');
      // 3/4 = 75 %
      expect(filtered.value).toBe(75);
    }
  });

  it('classement = SORT + LIMIT, pas une somme implicite', () => {
    const plan = planFromIntent({
      collection: 'rows',
      measure: 'variation',
      ranking: true,
      order: 'desc',
      limit: 2,
      operation: 'identity',
    });
    const ops = plan.steps.map((s) => s.op);
    expect(ops).toContain('SORT');
    expect(ops).toContain('LIMIT');
    expect(ops).not.toContain('SUM');
    const out = executeTransformPlan(raw, plan);
    expect(out.kind).toBe('rows');
    if (out.kind === 'rows') {
      expect(out.rows).toHaveLength(2);
      expect((out.rows[0] as { nom: string }).nom).toBe('Alpha');
      expect((out.rows[1] as { nom: string }).nom).toBe('Gamma');
    }
  });

  it('NORMALIZE base100 sur une série', () => {
    const series = {
      points: [
        { t: '2024-01-01', __value: 50 },
        { t: '2024-01-02', __value: 75 },
        { t: '2024-01-03', __value: 100 },
      ],
    };
    const out = executeTransformPlan(series, {
      source: { collection: 'points' },
      steps: [{ op: 'NORMALIZE', mode: 'base100' }],
    });
    expect(out.kind).toBe('series');
    if (out.kind === 'series') {
      expect(out.points[0]?.v).toBe(100);
      expect(out.points[1]?.v).toBe(150);
      expect(out.points[2]?.v).toBe(200);
    }
  });

  it('opérateurs exposés et NON_ADDITIVE pour les garde-fous', () => {
    expect(NON_ADDITIVE.test('price')).toBe(true);
    expect(NON_ADDITIVE.test('montant')).toBe(false);
  });
});
