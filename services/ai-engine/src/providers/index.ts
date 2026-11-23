import type { LLMProvider } from '../types.ts';
import { MockProvider } from './mock.ts';
import { OpenAICompatibleProvider } from './openai.ts';
import { AnthropicProvider } from './anthropic.ts';

export const INCEPTION_BASE_URL = 'https://api.inceptionlabs.ai/v1';
export const INCEPTION_DEFAULT_MODEL = 'mercury-3';

export type ProviderChoice = { provider: LLMProvider; requested: string; fallback?: string };

/**
 * Sélection du provider via l'environnement :
 *   LLM_PROVIDER = inception (défaut) | openai | anthropic | mock
 *   INCEPTION_API_KEY / LLM_API_KEY, LLM_MODEL, LLM_BASE_URL, LLM_REASONING_EFFORT
 * Sans clé → repli automatique sur le mock (signalé dans les événements `meta`).
 */
export function createProvider(env: NodeJS.ProcessEnv = process.env): ProviderChoice {
  const requested = (env.LLM_PROVIDER || 'inception').toLowerCase();
  const model = env.LLM_MODEL?.trim();
  if (requested === 'mock') return { provider: new MockProvider(), requested };

  if (requested === 'inception') {
    const key = env.INCEPTION_API_KEY || env.LLM_API_KEY;
    if (!key) return { provider: new MockProvider(), requested, fallback: 'INCEPTION_API_KEY absente : mode démo (mock)' };
    const effort = env.LLM_REASONING_EFFORT || 'instant';
    return {
      requested,
      provider: new OpenAICompatibleProvider({
        name: 'inception', baseUrl: env.LLM_BASE_URL || INCEPTION_BASE_URL, apiKey: key,
        model: model || INCEPTION_DEFAULT_MODEL, supportsDiffusion: true, maxTokensField: 'max_completion_tokens',
        extraBody: { reasoning_effort: effort },
      }),
    };
  }
  if (requested === 'openai') {
    const key = env.LLM_API_KEY || env.OPENAI_API_KEY;
    if (!key) return { provider: new MockProvider(), requested, fallback: 'LLM_API_KEY absente : mode démo (mock)' };
    return {
      requested,
      provider: new OpenAICompatibleProvider({ name: 'openai', baseUrl: env.LLM_BASE_URL || 'https://api.openai.com/v1', apiKey: key, model: model || 'gpt-4o-mini' }),
    };
  }
  if (requested === 'anthropic') {
    const key = env.LLM_API_KEY || env.ANTHROPIC_API_KEY;
    if (!key) return { provider: new MockProvider(), requested, fallback: 'LLM_API_KEY absente : mode démo (mock)' };
    return { requested, provider: new AnthropicProvider(key, model || 'claude-sonnet-4-5', env.LLM_BASE_URL || undefined) };
  }
  return { provider: new MockProvider(), requested, fallback: `Provider inconnu « ${requested} » : mode démo (mock)` };
}
