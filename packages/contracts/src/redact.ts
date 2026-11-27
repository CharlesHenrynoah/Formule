/** Expurgation : aucun secret dans les logs, les prompts, les événements ou les bundles. */
const SECRET_KEY = /(token|secret|password|passwd|authorization|api[-_]?key|bearer|cookie|credential|private[-_]?key)/i;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]{6,}/g;
const OPENAI_KEY = /sk-[A-Za-z0-9_-]{10,}/g;

export function maskSecret(secret: string | undefined | null): string {
  if (!secret) return '';
  return '••••' + secret.slice(-4);
}

export function redactString(s: string): string {
  return s.replace(BEARER, 'Bearer ••••').replace(OPENAI_KEY, 'sk-••••');
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 12) return '[profondeur]' as unknown as T;
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? (typeof v === 'string' ? maskSecret(v) : '••••') : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
