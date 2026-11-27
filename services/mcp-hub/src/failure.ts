import type { FailureKind } from '@formule/contracts';

type Details = Record<string, unknown>;
const object = (v: unknown): Details => v && typeof v === 'object' ? v as Details : {};
function fields(e: unknown): Details[] {
  const x = object(e), response = object(x.response), data = object(x.data), inner = object(x.error), cause = object(x.cause);
  return [x, response, data, inner, cause, object(response.data), object(data.error), object(object(response.data).error)];
}
function messages(e: unknown): string {
  if (typeof e === 'string') return e;
  return fields(e).flatMap(x => [x.message, x.text, x.code, x.type, x.error_description].filter(v => typeof v === 'string')).join(' ');
}
export function classifyError(e: unknown): FailureKind {
  const f = fields(e);
  const codes = f.flatMap(x => [x.status, x.statusCode, x.code, x.httpStatus]).map(String);
  const m = messages(e).toLowerCase();
  const quota = /\b(?:insufficient[_ ]quota|quota[_ ](?:exceeded|exhausted|depleted)|(?:monthly|daily|annual|billing|usage|credit)\s+(?:quota|limit)\s+(?:exceeded|reached|exhausted)|(?:exceeded|exhausted|out of)\s+(?:your\s+|the\s+)?(?:quota|credits)|(?:quota|credits)\s+(?:has been\s+)?(?:exceeded|exhausted|depleted)|payment required)\b/;
  if (codes.includes('401') || codes.includes('403')) return 'permission';
  if (codes.includes('402') || quota.test(m)) return 'quota';
  if (codes.includes('429')) return 'rate_limited';
  if (codes.includes('-32601') || codes.includes('404')) return 'method_missing';
  if (codes.includes('-32602') || codes.includes('400') || codes.includes('422')) return 'invalid_schema';
  if (codes.includes('408') || codes.includes('504')) return 'timeout';
  if (/\b(?:http(?: status)?|status(?: code)?|error(?: code)?)\s*[:=]?\s*429\b|\b(?:error|failed|response)\s*[:(]?\s*429\b|\b429\s+too many requests\b|\btoo many requests\b|\brate[_ -]?limit(?:ed|ing| exceeded| reached)?\b|\bthrottl(?:ed|ing)\b/.test(m)) return 'rate_limited';
  if (/\b(?:http(?: status)?|status(?: code)?|error(?: code)?)\s*[:=]?\s*(?:401|403)\b|\b(?:unauthori[sz]ed|forbidden|permission denied|invalid api[- ]?key|authentication required)\b/.test(m)) return 'permission';
  if (/\b(?:timeout|timed out|aborted|etimedout)\b/.test(m)) return 'timeout';
  if (/\b(?:not found|unknown tool|method not found)\b|-32601\b/.test(m)) return 'method_missing';
  if (/\b(?:invalid|schema|validation failed)\b|-32602\b/.test(m)) return 'invalid_schema';
  if (/\b(?:econnrefused|enotfound|fetch failed|connection closed|spawn)\b/.test(m)) return 'not_connected';
  return 'provider_down';
}
export function retryAfterMs(e: unknown, now = Date.now()): number | undefined {
  for (const x of fields(e)) {
    const direct = x.retryAfterMs ?? x.retry_after_ms;
    if (typeof direct === 'number' && Number.isFinite(direct) && direct >= 0) return direct;
    const h = object(x.headers);
    const val = typeof h.get === 'function' ? (h.get as (k:string)=>unknown).call(h,'retry-after') : h['retry-after'] ?? h['Retry-After'];
    const retry = val ?? x.retryAfter ?? x.retry_after;
    if (typeof retry === 'number' || typeof retry === 'string') {
      const n = Number(retry);
      if (String(retry).trim() && Number.isFinite(n) && n >= 0) return n * 1000;
      const date = Date.parse(String(retry)); if (Number.isFinite(date)) return Math.max(0, date - now);
    }
  }
  return undefined;
}
export class ReadCooldown {
  private entries = new Map<string, { kind: 'quota' | 'rate_limited'; until: number }>();
  block(id: string, kind: FailureKind, retryMs?: number, now = Date.now()) {
    if (kind !== 'quota' && kind !== 'rate_limited') return;
    const fallback = kind === 'quota' ? 300_000 : 60_000;
    const until = now + Math.max(1000, retryMs ?? fallback);
    const prev = this.entries.get(id);
    if (!prev || prev.until < until) this.entries.set(id, { kind, until });
  }
  active(id: string, now = Date.now()) {
    const entry = this.entries.get(id);
    if (!entry || entry.until <= now) { this.entries.delete(id); return undefined; }
    return { kind: entry.kind, retryAfterMs: entry.until - now };
  }
}
