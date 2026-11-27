import { describe, expect, it } from 'vitest';
import { extractJson, providerConf } from '../src/llm.js';

describe('fournisseur LLM', () => {
  it('Inception prioritaire, mercury-3 par défaut', () => {
    const save = { ...process.env };
    process.env.INCEPTION_API_KEY = 'sk_test'; process.env.OPENAI_API_KEY = 'sk-autre'; delete process.env.FORMULE_MODEL;
    expect(providerConf()).toMatchObject({ label: 'inception', base: 'https://api.inceptionlabs.ai/v1', model: 'mercury-3', extra: { reasoning_effort: 'medium' } });
    delete process.env.INCEPTION_API_KEY; delete process.env.OPENAI_API_KEY;
    expect(providerConf()).toBeNull();
    process.env = save;
  });
  it('JSON extrait d’une réponse texte', () => {
    expect(extractJson('Voici :\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('pas de json')).toBeNull();
  });
});
