import { describe, expect, it } from 'vitest';
import {
  BindComposeSchema,
  CorrectionSchema,
  InterpretPlanSchema,
  applyCorrection,
  interpretAndPlan,
} from '../src/semantic/hybrid.js';
import { titleFrom, type ReqTemplate, type Understanding } from '../src/semantic/lexicon.js';
import { measureWords, readContract } from '../src/semantic/analytical.js';

describe('hybrid schemas', () => {
  it('valide un contrat d’interprétation minimal', () => {
    const ok = InterpretPlanSchema.safeParse({
      title: 'Tableau de bord',
      mission: 'Suivre les ventes',
      requirements: [{ label: 'Nombre de commandes', visualization: 'kpi', operation: 'count', certainty: 'certain' }],
    });
    expect(ok.success).toBe(true);
  });

  it('rejette une visualisation inconnue', () => {
    const bad = InterpretPlanSchema.safeParse({
      title: 'X',
      mission: 'Y',
      requirements: [{ label: 'Z', visualization: 'radar' }],
    });
    expect(bad.success).toBe(false);
  });

  it('valide liaison et correction', () => {
    expect(BindComposeSchema.safeParse({
      bindings: [{ requirementId: 'r1', queryId: 'q1', measure: 'amount', operation: 'sum', visualization: 'kpi' }],
    }).success).toBe(true);
    expect(CorrectionSchema.safeParse({
      dropRequirementIds: ['r2'],
      rebind: [{ requirementId: 'r1', measure: 'qty', operation: 'sum', reason: 'mauvaise mesure' }],
    }).success).toBe(true);
  });
});

describe('hybrid fallback mock', () => {
  it('replie sur readContract sans LLM', async () => {
    const base: Understanding = {
      title: 'App',
      mission: '',
      reqs: [],
      commands: [],
      simulation: false,
      generic: true,
    };
    const plan = await interpretAndPlan(
      'Montre le nombre de clients et la somme des montants.',
      [],
      base,
    );
    expect(['deterministic', 'llm']).toContain(plan.source);
    expect(plan.u.reqs.length).toBeGreaterThan(0);
    expect(plan.u.generic).toBe(false);
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
});

describe('garde-fous déterministes (repli)', () => {
  it('n’extrait pas « permets » comme mesure', () => {
    const words = measureWords('Montre la taille totale du marché si tu le permets');
    expect(words).not.toContain('permets');
    expect(words).not.toContain('montre');
  });

  it('lit un titre entre guillemets', () => {
    expect(titleFrom('Crée « Crypto Market Intelligence » avec CoinGecko')).toBe('Crypto Market Intelligence');
  });

  it('détecte limit=3, base100 et classement sur le repli', () => {
    const reqs = readContract([
      'Courbe des prix Bitcoin et Ethereum sur 30 jours en base 100.',
      'Tableau de trois cryptomonnaies parmi Bitcoin, Ethereum et Solana.',
      'Classement des meilleures performances.',
    ].join('\n'));
    expect(reqs.some((r) => r.transform === 'base100')).toBe(true);
    const table = reqs.find((r) => r.view === 'table');
    expect(table?.limit).toBe(3);
    expect(reqs.some((r) => r.view === 'ranking')).toBe(true);
  });
});
