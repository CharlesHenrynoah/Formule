import { redactString } from '@formule/contracts';

/**
 * Fournisseur LLM interchangeable (API OpenAI-compatible). Ordre de résolution :
 *   1. INCEPTION_API_KEY → Inception Mercury (https://api.inceptionlabs.ai/v1, modèle mercury-3 par défaut)
 *   2. OPENAI_API_KEY    → OPENAI_BASE_URL (OpenAI par défaut)
 *   3. aucune clé        → mock déterministe, marqué « Démo »
 * Le modèle propose ; il ne reçoit aucun secret et n'accorde aucune permission.
 * Les variables sont lues à l'appel (le .env est chargé par service-kit).
 */
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface Llm { name: 'openai-compatible' | 'mock'; json<T>(messages: ChatMessage[], timeoutMs?: number): Promise<T | null> }

interface ProviderConf { label: string; key: string; base: string; model: string; extra: Record<string, unknown> }
export function providerConf(): ProviderConf | null {
  if (process.env.INCEPTION_API_KEY) return { label: 'inception', key: process.env.INCEPTION_API_KEY, base: (process.env.INCEPTION_BASE_URL ?? 'https://api.inceptionlabs.ai/v1').replace(/\/$/, ''), model: process.env.FORMULE_MODEL ?? 'mercury-3', extra: { reasoning_effort: process.env.INCEPTION_REASONING_EFFORT ?? 'medium' } };
  if (process.env.OPENAI_API_KEY) return { label: 'openai', key: process.env.OPENAI_API_KEY, base: (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''), model: process.env.FORMULE_MODEL ?? 'gpt-4o-mini', extra: {} };
  return null;
}

/** Extrait le premier objet JSON d'une réponse texte (si le mode JSON natif n'est pas accepté). */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : text;
  const start = src.indexOf('{'); const end = src.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(src.slice(start, end + 1)) as T; } catch { return null; }
}

async function post(conf: ProviderConf, body: Record<string, unknown>, timeoutMs: number) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${conf.base}/chat/completions`, { method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json', Authorization: `Bearer ${conf.key}` }, body: JSON.stringify(body) });
  } finally { clearTimeout(t); }
}

const remote: Llm = {
  name: 'openai-compatible',
  async json<T>(messages: ChatMessage[], timeoutMs = 45_000): Promise<T | null> {
    const conf = providerConf(); if (!conf) return null;
    try {
      const base = { model: conf.model, ...conf.extra, messages };
      let res = await post(conf, { ...base, response_format: { type: 'json_object' } }, timeoutMs);
      // certains fournisseurs refusent response_format : on réessaie en texte et on extrait le JSON
      if (res.status === 400 || res.status === 422) res = await post(conf, { ...base, messages: [...messages, { role: 'user', content: 'Réponds uniquement par un objet JSON valide.' }] }, timeoutMs);
      if (!res.ok) { console.warn(`[ai-engine] LLM ${conf.label} ${res.status} : ${redactString((await res.text()).slice(0, 200))}`); return null; }
      const j = await res.json() as { choices: { message: { content: string } }[] };
      return extractJson<T>(j.choices?.[0]?.message?.content ?? '');
    } catch (e) { console.warn(`[ai-engine] LLM ${conf.label} indisponible :`, redactString((e as Error).message)); return null; }
  },
};
const mock: Llm = { name: 'mock', async json() { return null; } };

export const llm: Llm = { get name() { return providerConf() ? 'openai-compatible' : 'mock'; }, json: (m, t) => (providerConf() ? remote.json(m, t) : mock.json(m, t)) } as Llm;
export const isDemoMode = () => providerConf() === null;

/** Vérification au démarrage : un appel minimal, résultat journalisé (jamais la clé). */
export async function probeLlm(): Promise<{ ok: boolean; detail: string }> {
  const conf = providerConf();
  if (!conf) return { ok: false, detail: 'aucune clé : mode démo' };
  const r = await remote.json<{ ok?: boolean }>([{ role: 'user', content: 'Réponds {"ok": true}' }], 20_000);
  return r?.ok ? { ok: true, detail: `${conf.label} · ${conf.model} joignable` } : { ok: false, detail: `${conf.label} · ${conf.model} injoignable ou réponse non JSON : repli sur la compréhension déterministe` };
}
