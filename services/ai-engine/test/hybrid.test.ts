import { describe, expect, it } from 'vitest';
import {
  BindComposeSchema,
  CorrectionSchema,
  InterpretPlanSchema,
  applyCorrection,
  coverageGaps,
  interpretAndPlan,
  validateInterpretation,
  interpretationIssues,
} from '../src/semantic/hybrid.js';
import { draftAnalytical } from '../src/semantic/analytical.js';
import type { ReqTemplate, Understanding } from '../src/semantic/lexicon.js';
import { llm } from '../src/llm.js';

const base: Understanding = {
  title: 'App', mission: '', reqs: [], commands: [], simulation: false, generic: true,
};

describe('hybrid schemas AI-first', () => {
  it('valide un contrat avec coverage, contraintes et acquisitions', () => {
    const ok = InterpretPlanSchema.safeParse({
      title: 'Crypto Market Intelligence',
      mission: 'Piloter le marché crypto',
      coverage: [
        'Taille totale du marché',
        "Courbe Bitcoin et Ethereum sur 30 jours",
        'Tableau de trois cryptomonnaies',
        'Comparaison en base 100',
        'Classement des performances',
      ],
      constraints: {
        design: ['fond sombre', 'accent bleu'],
        interactions: ['onglets Marché / Portefeuille'],
        reliability: [' indiquer la fraîcheur des données'],
        global: ['population = top cryptomonnaies'],
      },
      requirements: [
        { label: 'Capitalisation totale', visualization: 'kpi', measures: ['market_cap'], covers: ['Taille totale du marché'] },
        { label: 'BTC vs ETH 30j', visualization: 'line', entities: ['Bitcoin', 'Ethereum'], period: '30 jours', transform: 'base100', covers: ["Courbe Bitcoin et Ethereum sur 30 jours", 'Comparaison en base 100'] },
        { label: 'Trois cryptos', visualization: 'table', entities: ['Bitcoin', 'Ethereum', 'Solana'], limit: 3, covers: ['Tableau de trois cryptomonnaies'] },
        { label: 'Meilleures perfs', visualization: 'ranking', order: 'desc', limit: 10, covers: ['Classement des performances'] },
      ],
      acquisitions: [
        { id: 'mkt', forRequirementIds: ['0', '2', '3'], toolHints: ['get_global'], dataNotDocs: true },
        { id: 'btc', entity: 'bitcoin', forRequirementIds: ['1'], toolHints: ['get_coin_history'], dataNotDocs: true },
        { id: 'eth', entity: 'ethereum', forRequirementIds: ['1'], toolHints: ['get_coin_history'], dataNotDocs: true },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it('neutralise une visualisation inconnue (pas de rejet du contrat entier)', () => {
    const p = InterpretPlanSchema.safeParse({
      title: 'X', mission: 'Y', coverage: ['a'],
      requirements: [{ label: 'Z', visualization: 'radar' }],
    });
    expect(p.success).toBe(true);
    if (p.success) expect(p.data.requirements[0]?.visualization).toBeUndefined();
  });

  it('valide liaison et correction avec patch', () => {
    expect(BindComposeSchema.safeParse({
      bindings: [{ requirementId: 'r1', queryId: 'q1', measure: 'amount', operation: 'sum', visualization: 'kpi' }],
    }).success).toBe(true);
    expect(CorrectionSchema.safeParse({
      patchRequirements: [{ id: 'r1', label: 'Capitalisation', measures: ['market_cap'], visualization: 'kpi' }],
      note: 'mesure corrigée',
    }).success).toBe(true);
  });
});

describe('AI-first : pas de contrat syntaxique équivalent', () => {
  it('signale unavailable sans LLM ni pack', async () => {
    // Sans clé → mock. Sans pack → unavailable (pas readContract silencieux).
    if (llm.name !== 'mock') return; // environnement avec LLM réel : skip
    const plan = await interpretAndPlan("Montre le nombre d'éléments et la somme des montants.", [], base);
    expect(plan.ok).toBe(false);
    expect(plan.source).toBe('unavailable');
    expect(plan.reason).toMatch(/indisponible|Échec|équivalent/i);
    expect(plan.u.reqs).toHaveLength(0);
  });

  it('draftAnalytical propage ok=false', async () => {
    if (llm.name !== 'mock') return;
    const draft = await draftAnalytical("Créer l'interface d'analyse", base, []);
    expect(draft.ok).toBe(false);
    expect(draft.source).toBe('unavailable');
  });

  it('accepte un pack démo explicite sans le travestir en LLM', async () => {
    if (llm.name !== 'mock') return;
    const packed: Understanding = {
      ...base, generic: false,
      reqs: [{ id: 'r1', label: 'KPI pack', mandatory: true, tool: ['*'], view: 'kpi', title: 'KPI pack' }],
    };
    const plan = await interpretAndPlan('prompt quelconque', [], packed);
    expect(plan.ok).toBe(true);
    expect(plan.source).toBe('demo_pack');
    expect(plan.reason).toMatch(/démo/i);
  });
});

describe('coverageGaps', () => {
  const req = (partial: Partial<ReqTemplate> & { id: string; label: string }): ReqTemplate => ({
    mandatory: true, tool: ['*'], view: 'kpi', title: partial.label, ...partial,
  });

  it('détecte une intention absente du contrat (pas de matching lexical)', () => {
    const gaps = coverageGaps(
      ['Taille du marché', 'Classement des performances', 'Base 100'],
      [req({ id: 'a', label: 'Capitalisation totale du marché', acceptance: 'kpi' })],
    );
    expect(gaps).toContain('Taille du marché');
    expect(gaps).toContain('Classement des performances');
    expect(gaps).toContain('Base 100');
  });

  it('passe quand covers[] ou label exact portent le coverage', () => {
    const gaps = coverageGaps(
      ["Nombre d'éléments en hausse", 'Part de marché'],
      [
        req({ id: 'a', label: "Nombre d'éléments en hausse", view: 'kpi', acceptance: 'filtre:gt' }),
        req({ id: 'b', label: 'Part de marché', view: 'kpi', operation: 'ratio', acceptance: 'op:ratio' }),
      ],
    );
    expect(gaps).toEqual([]);
  });

  it('couvre via covers[] explicites (population / multi-entités)', () => {
    const gaps = coverageGaps(
      ['Population top 100', 'Bitcoin vs Ethereum base 100'],
      [
        req({ id: 'a', label: 'Répartition', population: 'top 100 cryptomonnaies', view: 'donut', covers: ['Population top 100'] }),
        req({ id: 'b', label: 'BTC vs ETH', view: 'line', entities: ['Bitcoin', 'Ethereum'], transform: 'base100', covers: ['Bitcoin vs Ethereum base 100'] }),
      ],
    );
    expect(gaps).toEqual([]);
  });

  it('porte le design via constraints, pas via matching de mots sur l’exigence', () => {
    const gaps = coverageGaps(
      ['Thème sombre et accent bleu'],
      [req({ id: 'a', label: 'KPI prix' })],
      { global: [], design: ['Thème sombre et accent bleu'], interactions: [], reliability: [] },
    );
    expect(gaps).toEqual([]);
  });
});

describe('applyCorrection', () => {
  it('n’applique un rebind que sur des queryIds autorisés', () => {
    const reqs: ReqTemplate[] = [{
      id: 'r1', label: 'Total', mandatory: true, tool: ['*'], view: 'kpi', title: 'Total',
      measure: ['price'], measures: ['price'], agg: 'sum', operation: 'sum',
    }];
    const out = applyCorrection(reqs, {
      rebind: [{ requirementId: 'r1', queryId: 'q-blocked', measure: 'qty', operation: 'sum' }],
    }, new Set(['q-ok']));
    expect(out[0].measure).toEqual(['price']);
    const ok = applyCorrection(reqs, {
      rebind: [{ requirementId: 'r1', queryId: 'q-ok', measure: 'qty', operation: 'sum' }],
    }, new Set(['q-ok']));
    expect(ok[0].measure).toEqual(['qty']);
  });

  it('applique un patchRequirements avant nouvelles acquisitions', () => {
    const reqs: ReqTemplate[] = [{
      id: 'r1', label: 'Taille', mandatory: true, tool: ['*'], view: 'kpi', title: 'Taille',
      measure: ['permets'], measures: ['permets'],
    }];
    const out = applyCorrection(reqs, {
      patchRequirements: [{ id: 'r1', label: 'Capitalisation totale', visualization: 'kpi', measures: ['market_cap'] }],
      note: 'mesure corrigée',
    }, new Set());
    expect(out[0].measures).toContain('market_cap');
    expect(out[0].measures).not.toContain('permets');
  });
});


describe('validation du contrat LLM', () => {
  const fixture = (transform: unknown, extra: Record<string, unknown> = {}) => ({
    title: 'Analyse', mission: 'Comparer', coverage: ['Comparer les séries'],
    requirements: [{ id: 'r1', label: 'Comparer les séries', visualization: 'line', transform, ...extra }],
  });

  it('accepte base 100 et les valeurs facultatives nulles sans inventer de normalisation', () => {
    const normalized = InterpretPlanSchema.parse(fixture('base 100', { order: null, certainty: null }));
    expect(normalized.requirements[0].transform).toBe('base100');
    const plain = InterpretPlanSchema.parse({ ...fixture('none'), constraints: null });
    expect(plain.requirements[0].transform).toBeUndefined();
  });

  it('rejette une transformation inconnue et indique son chemin exact', () => {
    const parsed = InterpretPlanSchema.safeParse(fixture('logarithm'));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(interpretationIssues(parsed.error)).toContain('requirements.0.transform');
  });

  it('répare une réponse invalide une seule fois', async () => {
    let calls = 0;
    const parsed = await validateInterpretation(fixture('logarithm'), async (issues) => {
      calls++;
      expect(issues).toContain('requirements.0.transform');
      return fixture('base100');
    });
    expect(calls).toBe(1);
    expect(parsed.success).toBe(true);
  });

  it('ne relance pas le LLM en absence de réponse ou après une réparation invalide', async () => {
    let calls = 0;
    const repair = async () => { calls++; return fixture('unsupported'); };
    expect((await validateInterpretation(null, repair)).success).toBe(false);
    expect(calls).toBe(0);
    expect((await validateInterpretation(fixture('unsupported'), repair)).success).toBe(false);
    expect(calls).toBe(1);
  });

  it('normalise les opérateurs de filtre et les ordres équivalents', () => {
    const p = InterpretPlanSchema.parse(fixture(null, { order: 'descending', filters: [{ field: 'variation', op: '>', value: 0 }] }));
    expect(p.requirements[0].order).toBe('desc');
    expect(p.requirements[0].filters?.[0].op).toBe('gt');
  });
});
