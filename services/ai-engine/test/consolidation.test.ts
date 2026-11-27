/**
 * Régression consolidation post PR#6/#7 — budgets, docs, args, dérivés, couverture structurée.
 */
import { describe, expect, it } from 'vitest';
import { createRuntimeBudgets, McpBudget } from '../src/semantic/budgets.js';
import { wantsDocumentation, planAcquisitions } from '../src/semantic/acquire-plan.js';
import { isDerivedDataset, recomputeDerivedDatasets } from '../src/semantic/fusion.js';
import { freezeReqs } from '../src/semantic/analytical.js';
import { intentKey, sealContract, structuredCoverageGaps } from '../src/semantic/contract-guard.js';
import { validate } from '../src/discovery/args-synth.js';
import { datasetOf, type Dataset } from '../src/semantic/resolve.js';
import type { ReqTemplate } from '../src/semantic/lexicon.js';
import type { Acquired, CatalogServer } from '../src/discovery/catalog.js';

const req = (p: Partial<ReqTemplate> & { id: string; label: string }): ReqTemplate => ({
  mandatory: true, tool: ['*'], view: 'kpi', title: p.label, ...p,
});

function fakeAcq(queryId: string, raw: unknown, args: Record<string, unknown> = {}, tool = 'get_history'): Acquired {
  return {
    queryId,
    ref: {
      serverId: 's1', serverName: 'Test', demo: true,
      tool: { name: tool, description: '', permission: 'read', hint: '', inputSchema: { type: 'object', properties: {} } },
    },
    args, envelope: {
      id: `e_${queryId}`, status: 'ok', observedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(),
      coverage: { complete: true, pages: 1 }, source: { serverId: 's1', serverName: 'Test', demo: true },
      tool, args, requestId: queryId, schemaVersion: '1', rawRef: '', hash: 'h',
    },
    raw,
  };
}

describe('consolidation · budgets centralisés', () => {
  it('createRuntimeBudgets expose LLM + MCP', () => {
    const b = createRuntimeBudgets();
    expect(b.llm.take()).toBe(true);
    expect(b.mcp.takeRead()).toBe(true);
    expect(b.mcp.maxPages).toBeGreaterThan(0);
  });

  it('McpBudget borne lectures et retries', () => {
    const m = new McpBudget(2, 1, 3);
    expect(m.takeRead()).toBe(true);
    expect(m.takeRead()).toBe(true);
    expect(m.takeRead()).toBe(false);
    expect(m.takeRetry()).toBe(true);
    expect(m.takeRetry()).toBe(false);
    expect(m.remainingReads).toBe(0);
  });
});

describe('consolidation · docs inutiles', () => {
  it('wantsDocumentation exige une demande explicite', () => {
    expect(wantsDocumentation('KPI capitalisation Bitcoin', [req({ id: 'a', label: 'Cap' })])).toBe(false);
    expect(wantsDocumentation('Cherche dans la documentation MCP', [])).toBe(true);
  });
});

describe('consolidation · validation args MCP', () => {
  it('validate refuse un type hors schéma', () => {
    const schema = {
      type: 'object' as const,
      properties: { id: { type: 'string' as const }, days: { type: 'number' as const } },
      required: ['id'],
    };
    expect(validate({ id: 'bitcoin', days: 30 }, schema)).toEqual([]);
    expect(validate({ days: 30 }, schema).length).toBeGreaterThan(0);
    expect(validate({ id: 12 }, schema).length).toBeGreaterThan(0);
  });
});

describe('consolidation · propriétés figées + covers', () => {
  it('freezeReqs conserve covers, series, entities', () => {
    const frozen = freezeReqs([req({
      id: 'r1', label: 'Cmp', view: 'line', entities: ['A', 'B'],
      covers: ['Comparaison A/B'], series: [['A'], ['B']], measures: ['price'],
    })]);
    expect(frozen[0].covers).toEqual(['Comparaison A/B']);
    expect(frozen[0].entities).toEqual(['A', 'B']);
    expect(Object.isFrozen(frozen[0])).toBe(true);
    expect(Object.isFrozen(frozen[0].covers)).toBe(true);
  });

  it('intentKey intègre covers et mesures', () => {
    const a = req({ id: 'r1', label: 'X', measures: ['price'], covers: ['X'] });
    const b = { ...a, covers: ['Y'] };
    expect(intentKey(a)).not.toBe(intentKey(b));
  });
});

describe('consolidation · couverture structurée', () => {
  it('refuse le matching par présence de mots', () => {
    const gaps = structuredCoverageGaps(
      ['Classement des meilleures performances'],
      [req({ id: 'a', label: 'Meilleures perfs marché', view: 'ranking' })],
    );
    expect(gaps.length).toBe(1);
  });

  it('accepte covers[] normalisés', () => {
    const gaps = structuredCoverageGaps(
      ['Classement des meilleures performances'],
      [req({ id: 'a', label: 'Ranking', covers: ['Classement des meilleures performances'] })],
    );
    expect(gaps).toEqual([]);
  });
});

describe('consolidation · dérivés ≠ MCP', () => {
  it('recalcule fuse_ depuis sources sans les confondre avec un outil', () => {
    const btc = datasetOf(fakeAcq('btc', {
      points: [
        { date: '2024-01-01', price: 100 },
        { date: '2024-01-02', price: 110 },
        { date: '2024-01-03', price: 120 },
      ],
    }, { id: 'bitcoin' }));
    const eth = datasetOf(fakeAcq('eth', {
      points: [
        { date: '2024-01-01', price: 50 },
        { date: '2024-01-02', price: 55 },
        { date: '2024-01-03', price: 60 },
      ],
    }, { id: 'ethereum' }));
    const map = new Map<string, Dataset>([['btc', btc], ['eth', eth]]);
    const line = req({
      id: 'cmp', label: 'BTC vs ETH', view: 'line', visualization: 'line',
      entities: ['Bitcoin', 'Ethereum'], measures: ['price'],
    });
    const first = recomputeDerivedDatasets([line], map);
    const fuseId = [...first.keys()].find((k) => k.startsWith('fuse_'))!;
    expect(fuseId).toBeTruthy();
    expect(isDerivedDataset(first.get(fuseId)!)).toBe(true);
    expect(first.get(fuseId)!.acq.ref.tool.name).toBe('derived:fuse');

    // Refresh : sources mises à jour, dérivé recalculé sans lecture MCP du fuse.
    const btc2 = datasetOf(fakeAcq('btc', {
      points: [
        { date: '2024-01-01', price: 200 },
        { date: '2024-01-02', price: 220 },
        { date: '2024-01-03', price: 240 },
      ],
    }, { id: 'bitcoin' }));
    const refreshed = new Map([['btc', btc2], ['eth', eth], [fuseId, first.get(fuseId)!]]);
    const again = recomputeDerivedDatasets([], refreshed);
    expect(again.has(fuseId)).toBe(true);
    const pts = (again.get(fuseId)!.acq.raw as { points: { Bitcoin: number }[] }).points;
    expect(pts[0]?.Bitcoin).toBe(200);
  });
});

describe('consolidation · planAcquisitions hors docs', () => {
  it('n’ajoute pas search_docs sans demande explicite', async () => {
    const catalog: CatalogServer[] = [{
      serverId: 'demo', name: 'Demo', demo: true, status: 'connected',
      tools: [
        { name: 'search_docs', description: 'documentation', permission: 'read', hint: '', inputSchema: { properties: {} } },
        { name: 'get_price', description: 'prix spot', permission: 'read', hint: '', inputSchema: { properties: {} } },
      ],
      resources: [], prompts: [],
    }];
    const { planned } = await planAcquisitions(
      [req({ id: 'r1', label: 'Prix', view: 'kpi', measures: ['price'], tool: ['get_price'] })],
      catalog,
      'Montre le prix',
    );
    expect(planned.every((p) => p.ref.tool.name !== 'search_docs')).toBe(true);
  });
});

describe('consolidation · chrome UI hors gaps d’acquisition', () => {
  it('sealContract déplace titre, layout et refresh hors coverage analytique', () => {
    const sealed = sealContract(
      'Dashboard « Crypto Pulse » sombre avec bouton actualiser',
      [
        req({
          id: 't1', label: 'Tableau BTC ETH SOL', view: 'table', visualization: 'table',
          entities: ['Bitcoin', 'Ethereum', 'Solana'], measures: ['price'],
        }),
        req({
          id: 'k1', label: 'Capitalisation cumulée', view: 'kpi', measures: ['market_cap'],
        }),
      ],
      [
        'Créer un dashboard intitulé « Crypto Pulse »',
        'Tableau contenant exclusivement Bitcoin, Ethereum et Solana avec nom, symbole, prix actuel, capitalisation, volume 24 h, variation 24 h et variation 7 j',
        'Indicateurs en haut, graphiques au milieu et tableau en bas',
        'Ajouter un bouton d\'actualisation fonctionnel qui met également à jour le graphique comparatif',
        'Capitalisation cumulée des 20 actifs',
      ],
      { global: [], design: ['thème sombre'], interactions: [], reliability: [] },
    );
    expect(sealed.coverage.some((c) => /intitul|Crypto Pulse/i.test(c))).toBe(false);
    expect(sealed.coverage.some((c) => /bouton|actualisation/i.test(c))).toBe(false);
    expect(sealed.coverage.some((c) => /en haut|au milieu/i.test(c))).toBe(false);
    expect(sealed.constraints.global.length + sealed.constraints.design.length + sealed.constraints.interactions.length).toBeGreaterThan(0);
    const gaps = structuredCoverageGaps(sealed.coverage, sealed.reqs, sealed.constraints);
    expect(gaps.filter((g) => /intitul|bouton|en haut/i.test(g))).toEqual([]);
  });
});

describe('consolidation · seal verrouille les exigences validées', () => {
  it('fingerprint stable et intentLock complet', () => {
    const sealed = sealContract(
      'KPI prix Bitcoin 30 jours',
      [req({ id: 'r1', label: 'Prix', view: 'kpi', entities: ['Bitcoin'], period: '30 jours', covers: ['Prix'] })],
      ['Prix'],
      { global: [], design: [], interactions: [], reliability: [] },
    );
    expect(sealed.intentLock.get('r1')).toBe(intentKey(sealed.reqs[0]!));
    expect(sealed.fingerprint).toHaveLength(16);
  });
});

describe('consolidation · prompt → AppSpec → certification', () => {
  it('assembleSpec conserve measures, transform et covers', async () => {
    const { assembleSpec } = await import('../src/semantic/plan.js');
    const { AppSpecSchema } = await import('@formule/contracts');
    const tpl = req({
      id: 'r1', label: 'BTC vs ETH', view: 'line', visualization: 'line',
      entities: ['Bitcoin', 'Ethereum'], measures: ['price'], transform: 'base100',
      covers: ['Comparaison base 100'], period: '30 jours',
    });
    const ds = datasetOf(fakeAcq('q1', {
      points: [
        { date: '2024-01-01', price: 1 },
        { date: '2024-01-02', price: 2 },
      ],
    }));
    const planned = [{
      tpl, status: 'covered' as const, queryId: 'q1',
      view: {
        kind: 'line' as const, id: 'v1', title: 'BTC vs ETH', queryId: 'q1', requirementIds: ['r1'],
        bindings: { collection: 'points', t: 'date', series: [{ path: 'price', label: 'price', unit: null }] },
      },
      evidencePath: 'price', envelopeId: 'e_q1',
    }];
    const spec = assembleSpec({
      u: { title: 'App', mission: 'm', reqs: [tpl], commands: [], simulation: false, generic: false },
      planned, datasets: new Map([['q1', ds]]), actions: [], demo: false, pointsLocked: true,
    });
    const parsed = AppSpecSchema.parse(spec);
    const r = parsed.requirements[0]!;
    expect(r.measures).toEqual(['price']);
    expect(r.transform).toBe('base100');
    expect(r.covers).toEqual(['Comparaison base 100']);
    expect(r.entities).toEqual(['Bitcoin', 'Ethereum']);
    expect(r.period).toBe('30 jours');
  });
});
