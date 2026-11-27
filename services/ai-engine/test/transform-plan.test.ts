import { describe, expect, it } from 'vitest';
import { executeTransformPlan, planFromIntent, validateTransformPlan } from '@formule/contracts';
import { resolveRequirement, datasetOf } from '../src/semantic/resolve.js';
import type { Acquired } from '../src/discovery/catalog.js';

const raw = {
  coins: [
    { name: 'A', price_change_percentage_24h: 12.5, market_cap: 100 },
    { name: 'B', price_change_percentage_24h: -3, market_cap: 80 },
    { name: 'C', price_change_percentage_24h: 7, market_cap: 50 },
    { name: 'D', price_change_percentage_24h: 1, market_cap: 20 },
  ],
};

function fakeAcq(data: unknown): Acquired {
  return {
    ref: { serverId: 's', serverName: 'demo', tool: { name: 'list', inputSchema: {} } },
    envelope: { id: 'e1', status: 'ok', fetchedAt: new Date().toISOString() },
    raw: data,
  } as Acquired;
}

describe('resolve → TransformPlan', () => {
  it('classement non-additif → pipeline SORT+LIMIT, agg identity', () => {
    const ds = datasetOf(fakeAcq(raw));
    const r = resolveRequirement(
      {
        id: 'r1', label: 'top hausses', title: 'Top', view: 'ranking',
        measure: ['price_change_percentage_24h'], label_: ['name'],
        limit: 2, order: 'desc', mandatory: true,
      },
      ds, 'v1', 'q1',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.view.bindings).toMatchObject({ agg: 'identity', limit: 2 });
    expect(r.pipeline).toBeDefined();
    const ops = r.pipeline!.steps.map((s) => s.op);
    expect(ops).toEqual(expect.arrayContaining(['SORT', 'LIMIT']));
    expect(ops).not.toContain('SUM');
    const v = validateTransformPlan(r.pipeline);
    expect(v.ok).toBe(true);
  });

  it('parts = FILTER + RATIO (comptage)', () => {
    const plan = planFromIntent({
      collection: 'coins',
      operation: 'ratio',
      where: [{ path: 'price_change_percentage_24h', op: 'gt', value: 0 }],
      percent: true,
    });
    const out = executeTransformPlan(raw, plan);
    expect(out.kind).toBe('scalar');
    if (out.kind === 'scalar') {
      expect(out.value).toBe(75);
      expect(out.unit).toBe('%');
    }
  });
});
