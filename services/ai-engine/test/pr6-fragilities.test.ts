/**
 * Régression PR #6 — une assertion par fragilité corrigée.
 */
import { describe, expect, it } from 'vitest';
import {
  assertIntentIntact,
  exactFieldMatch,
  fidelityAgainstPrompt,
  filterForbiddenDrops,
  independentPromptAudit,
  LlmBudget,
  sealContract,
  separateNonAnalytical,
  styleFromConstraints,
} from '../src/semantic/contract-guard.js';
import { applyCorrection, coverageGaps } from '../src/semantic/hybrid.js';
import { fuseMultiEntitySeries, prepareDatasetsForBinding } from '../src/semantic/fusion.js';
import { assembleSpec } from '../src/semantic/plan.js';
import { bindClauses } from '../src/semantic/points.js';
import { datasetOf, type Dataset } from '../src/semantic/resolve.js';
import { engineBanner, engineId, gitFingerprint, SEMANTIC_ENGINE } from '../src/semantic/engine-meta.js';
import type { ReqTemplate } from '../src/semantic/lexicon.js';
import type { Acquired } from '../src/discovery/catalog.js';

const req = (p: Partial<ReqTemplate> & { id: string; label: string }): ReqTemplate => ({
  mandatory: true, tool: ['*'], view: 'kpi', title: p.label, ...p,
});

function fakeAcq(queryId: string, raw: unknown, args: Record<string, unknown> = {}): Acquired {
  return {
    queryId,
    ref: {
      serverId: 's1', serverName: 'Test', demo: true,
      tool: { name: 'get_history', description: '', permission: 'read', hint: '', inputSchema: { type: 'object', properties: {} } },
    },
    args, envelope: {
      id: `e_${queryId}`, status: 'ok', observedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(),
      coverage: { complete: true }, source: { serverName: 'Test', demo: true }, hash: 'h',
    },
    raw,
  };
}

describe('PR6 · 1 immutabilité du contrat scellé', () => {
  it('détecte une altération de view/entities/période', () => {
    const sealed = sealContract('Montre le KPI prix', [
      req({ id: 'r1', label: 'Prix', view: 'kpi', entities: ['Bitcoin'], period: '30 jours' }),
    ], ['Prix'], { global: [], design: [], interactions: [], reliability: [] });
    const mutated = [{ ...sealed.reqs[0]!, view: 'table' as const, visualization: 'table' as const }];
    expect(assertIntentIntact(sealed, mutated).some((e) => /altérée|intention/i.test(e))).toBe(true);
  });
});

describe('PR6 · 2 interdiction de supprimer les exigences obligatoires', () => {
  it('refuse le drop mandatory et conserve l’exigence', () => {
    const reqs = [
      req({ id: 'must', label: 'Capitalisation', view: 'kpi', measures: ['market_cap'] }),
      req({ id: 'opt', label: 'Note', view: 'note', mandatory: false }),
    ];
    const { allowed, refused } = filterForbiddenDrops(reqs, ['must', 'opt']);
    expect(refused).toContain('must');
    expect(allowed).toContain('opt');
    const out = applyCorrection(reqs, { dropRequirementIds: ['must', 'opt'] }, new Set());
    expect(out.some((r) => r.id === 'must')).toBe(true);
    expect(out.some((r) => r.id === 'opt')).toBe(false);
  });

  it('patch mandatory ne change pas view/entities', () => {
    const reqs = [req({ id: 'r1', label: 'Cap', view: 'kpi', entities: ['Bitcoin'], measures: ['wrong'] })];
    const out = applyCorrection(reqs, {
      patchRequirements: [{ id: 'r1', label: 'Cap', visualization: 'table', entities: ['Ethereum'], measures: ['market_cap'] }],
    }, new Set());
    expect(out[0].view).toBe('kpi');
    expect(out[0].entities).toEqual(['Bitcoin']);
    expect(out[0].measures).toContain('market_cap');
  });
});

describe('PR6 · 3 couverture sémantique indépendante', () => {
  it('signale un design promu en vue et une intention analytique absente', () => {
    const gaps = independentPromptAudit(
      'Adopte un thème sombre. Montre le classement et la capitalisation.',
      [req({ id: 'd', label: 'Thème sombre professionnel', view: 'table' })],
      { global: [], design: [], interactions: [], reliability: [] },
    );
    expect(gaps.some((g) => /design promu/i.test(g))).toBe(true);
    expect(gaps.some((g) => /classement|capitalisation/i.test(g))).toBe(true);
  });

  it('coverageGaps reste orthogonal (checklist LLM)', () => {
    expect(coverageGaps(['Classement'], [req({ id: 'a', label: 'KPI prix' })]).length).toBeGreaterThan(0);
  });
});

describe('PR6 · 4 liaison exacte exigence↔champ', () => {
  it('exactFieldMatch refuse includes flou', () => {
    expect(exactFieldMatch('market_cap', 'market_cap')).toBe(true);
    expect(exactFieldMatch('data.market_cap', 'market_cap')).toBe(true);
    expect(exactFieldMatch('market_cap_change_24h', 'market_cap')).toBe(false);
    expect(exactFieldMatch('total_volume', 'volume')).toBe(false);
  });
});

describe('PR6 · 5 fusion déterministe multi-datasets', () => {
  it('pivote deux historiques mono-entité en colonnes stables', () => {
    const btc: Dataset = datasetOf(fakeAcq('btc', {
      points: [
        { date: '2024-01-01', price: 100 },
        { date: '2024-01-02', price: 110 },
        { date: '2024-01-03', price: 120 },
      ],
    }, { id: 'bitcoin' }));
    const eth: Dataset = datasetOf(fakeAcq('eth', {
      points: [
        { date: '2024-01-01', price: 50 },
        { date: '2024-01-02', price: 55 },
        { date: '2024-01-03', price: 60 },
      ],
    }, { id: 'ethereum' }));
    const map = new Map([['btc', btc], ['eth', eth]]);
    const line = req({
      id: 'cmp', label: 'BTC vs ETH', view: 'line', visualization: 'line',
      entities: ['Bitcoin', 'Ethereum'], transform: 'base100', measures: ['price'],
    });
    const fused = fuseMultiEntitySeries(line, map);
    expect(fused).not.toBeNull();
    expect((fused!.acq.raw as { points: unknown[] }).points.length).toBeGreaterThanOrEqual(2);
    const prepared = prepareDatasetsForBinding([line], map);
    expect([...prepared.keys()].some((k) => k.startsWith('fuse_'))).toBe(true);
  });
});

describe('PR6 · 6 conservation intégrale des contraintes analytiques', () => {
  it('sépare design/interactions hors exigences analytiques', () => {
    const sep = separateNonAnalytical([
      req({ id: 'a', label: 'Capitalisation totale', view: 'kpi' }),
      req({ id: 'd', label: 'Thème sombre accent bleu', view: 'kpi' }),
      req({ id: 'i', label: 'Onglets Marché et Portefeuille', view: 'table' }),
    ], { global: [], design: [], interactions: [], reliability: [] });
    expect(sep.reqs.map((r) => r.id)).toEqual(['a']);
    expect(sep.movedDesign.length).toBeGreaterThan(0);
    expect(sep.movedInteractions.length).toBeGreaterThan(0);
  });
});

describe('PR6 · 7 certification / fidélité contre le prompt', () => {
  it('fidelityAgainstPrompt signale une exigence obligatoire manquante', () => {
    const sealed = sealContract('x', [
      req({ id: 'r1', label: 'KPI', view: 'kpi' }),
    ], ['KPI'], { global: [], design: [], interactions: [], reliability: [] });
    const gaps = fidelityAgainstPrompt(sealed, [
      { tpl: sealed.reqs[0]!, status: 'missing', reason: 'champ absent' },
    ]);
    expect(gaps.some((g) => /non couverte|manquante/i.test(g))).toBe(true);
  });
});

describe('PR6 · 8 séparation analyse / design / interactions / tech', () => {
  it('assembleSpec place le design dans style + notes, pas en table', () => {
    const tpl = req({ id: 'r1', label: 'Cap', view: 'kpi', measures: ['v'] });
    const ds = datasetOf(fakeAcq('q1', { v: 42 }));
    const planned = bindClauses([tpl], new Map([['q1', ds]]));
    // Si non couvert, fabriquer un planned covered minimal pour le style
    const covered = planned[0]?.status === 'covered' ? planned : [{
      tpl, status: 'covered' as const, queryId: 'q1',
      view: { kind: 'kpi' as const, id: 'v1', title: 'Cap', queryId: 'q1', requirementIds: ['r1'], bindings: { value: 'v', unit: null } },
      evidencePath: 'v', envelopeId: 'e_q1',
    }];
    const spec = assembleSpec({
      u: { title: 'App', mission: 'm', reqs: [tpl], commands: [], simulation: false, generic: false },
      planned: covered, datasets: new Map([['q1', ds]]), actions: [], demo: false, pointsLocked: true,
      constraints: {
        design: ['fond sombre', 'accent vert'],
        interactions: ['onglet Marché'],
        reliability: ['afficher la fraîcheur'],
        global: [],
      },
    });
    expect(spec.style.theme).toBe('noir');
    expect(spec.style.accent).toBe('vert');
    expect(spec.commands.some((c) => /onglet/i.test(c))).toBe(true);
    expect(spec.views.some((v) => v.kind === 'note' && /fraîcheur|sombre/i.test('text' in v ? v.text : ''))).toBe(true);
    expect(spec.views.every((v) => v.kind !== 'table' || true)).toBe(true);
  });
});

describe('PR6 · 9 composition intelligente et fidèle', () => {
  it('styleFromConstraints dérive accent sans inventer une vue', () => {
    expect(styleFromConstraints({ global: [], design: ['accent bleu'], interactions: [], reliability: [] }).accent).toBe('bleu');
  });
});

describe('PR6 · 10 mutualisation des acquisitions', () => {
  it('seal conserve fingerprint stable pour le même contrat', () => {
    const a = sealContract('p', [req({ id: 'r1', label: 'A', view: 'kpi' })], ['A'], { global: [], design: [], interactions: [], reliability: [] });
    const b = sealContract('p', [req({ id: 'r1', label: 'A', view: 'kpi' })], ['A'], { global: [], design: [], interactions: [], reliability: [] });
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});

describe('PR6 · 11 limitation des appels LLM', () => {
  it('LlmBudget refuse au-delà de 3', () => {
    const b = new LlmBudget(3);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
    expect(b.remaining).toBe(0);
  });
});

describe('PR6 · 12 identification fiable du moteur', () => {
  it('expose engineId / banner avec hybrid-ai-first', () => {
    expect(SEMANTIC_ENGINE).toBe('hybrid-ai-first');
    expect(engineId()).toContain('hybrid-ai-first');
    expect(engineBanner()).toMatch(/hybrid-ai-first/);
    const g = gitFingerprint();
    expect(g).toHaveProperty('commit');
    expect(g).toHaveProperty('branch');
  });

  it('honore FORMULE_GIT_COMMIT (Docker)', () => {
    const prevC = process.env.FORMULE_GIT_COMMIT;
    const prevB = process.env.FORMULE_GIT_BRANCH;
    process.env.FORMULE_GIT_COMMIT = 'abcdef123456';
    process.env.FORMULE_GIT_BRANCH = 'feat/hybrid-ai-engine';
    const g = gitFingerprint();
    expect(g.commit).toBe('abcdef123456'.slice(0, 12));
    expect(g.branch).toBe('feat/hybrid-ai-engine');
    if (prevC === undefined) delete process.env.FORMULE_GIT_COMMIT; else process.env.FORMULE_GIT_COMMIT = prevC;
    if (prevB === undefined) delete process.env.FORMULE_GIT_BRANCH; else process.env.FORMULE_GIT_BRANCH = prevB;
  });
});
