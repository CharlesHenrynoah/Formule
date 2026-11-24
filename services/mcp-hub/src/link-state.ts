/**
 * Reprise de liaison MCP, commune à tous les serveurs et tous les transports.
 * Le SDK 1.32.2 rejoue un flux SSE déjà ouvert, mais conserve mcp-session-id :
 * un 404 de session (issues 1708 / 1641) n'est pas réparé tant que le client n'est pas reconstruit.
 * La forme du délai vient du backoff avec jitter déjà prouvé (dyad, coworker) : base courte, plafond borné.
 */

export type Phase = 'connected' | 'degraded' | 'disconnected' | 'reconnecting' | 'verifying' | 'failed';
export type Obstacle = 'transport' | 'session' | 'availability' | 'auth' | 'quota' | 'signature' | 'structure' | 'unknown';
export type TransportName = 'stdio' | 'http' | 'sse';

export type Breaker = { failures: number; openedAt: number | null };

const SECRET = /bearer\s+[a-z0-9._~+/-]+=*/gi;

export function scrub(message: string, secrets: string[] = []): string {
  let text = message;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) text = text.split(secret).join('[SECRET_REDACTED]');
  }
  return text.replace(SECRET, 'Bearer [SECRET_REDACTED]');
}

export function readFailure(error: unknown): { message: string; code?: number } {
  if (error && typeof error === 'object') {
    const raw = (error as { code?: unknown; message?: unknown }).code;
    const message = String((error as { message?: unknown }).message ?? error);
    if (typeof raw === 'number') return { message, code: raw };
    if (typeof raw === 'string' && /^ECONN|^ETIMEDOUT|^UND_ERR/i.test(raw)) return { message: `${raw} ${message}` };
  }
  return { message: String(error ?? '') };
}

/** Classe l'obstacle. Une coupure n'est jamais « unknown » ni une absence de données. */
export function classifyLink(message: string, code?: number): { obstacle: Obstacle; recoverable: boolean } {
  const text = message.toLowerCase();
  if (code === 401 || code === 403 || /401|403|unauthori[sz]ed|forbidden|invalid[_ ]token|www-authenticate|api[_ ]?key|jeton refusé/.test(text)) {
    return { obstacle: 'auth', recoverable: false };
  }
  if (code === 429 || /429|quota|rate limit|too many requests/.test(text)) {
    return { obstacle: 'quota', recoverable: false };
  }
  if (code === 404 || /session not found|invalid session|session expired|mcp-session|no valid session|session terminat/.test(text)) {
    return { obstacle: 'session', recoverable: true };
  }
  if (/terminated|econnreset|econnrefused|socket hang up|fetch failed|und_err_|other side closed|network error|headers timeout|body timeout/.test(text)) {
    return { obstacle: 'transport', recoverable: true };
  }
  if (code === 408 || code === 502 || code === 503 || code === 504 || /etimedout|timeout|délai|unavailable|temporairement|503|504/.test(text)) {
    return { obstacle: 'availability', recoverable: true };
  }
  if (/expected \d+\s*(?:-\d+)?\s+arguments?|not assignable to parameter/.test(text)) {
    return { obstacle: 'signature', recoverable: false };
  }
  if (/cannot read propert|is not iterable|syntaxerror|is not a function/.test(text)) {
    return { obstacle: 'structure', recoverable: false };
  }
  return { obstacle: 'unknown', recoverable: false };
}

/** Backoff exponentiel avec jitter. `random` vaut 0 au centre, 1 au maximum. */
export function delayMs(attempt: number, random = Math.random()): number {
  const base = Math.min(250 * 2 ** Math.max(0, attempt), 4_000);
  const jitter = base * 0.25 * (random * 2 - 1);
  return Math.max(50, Math.round(base + jitter));
}

export function breakerOpen(breaker: Breaker, now: number, coolMs = 15_000): boolean {
  if (breaker.openedAt == null) return false;
  if (now - breaker.openedAt >= coolMs) {
    breaker.openedAt = null;
    breaker.failures = 0;
    return false;
  }
  return true;
}

export function noteFailure(breaker: Breaker, now: number, threshold = 5): void {
  breaker.failures += 1;
  if (breaker.failures >= threshold && breaker.openedAt == null) breaker.openedAt = now;
}

export class Flight {
  private pending = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const job = fn().finally(() => {
      if (this.pending.get(key) === job) this.pending.delete(key);
    });
    this.pending.set(key, job);
    return job;
  }
}

export type RecoverResult<T> =
  | { ok: true; value: T; phase: Phase; correlationId: string; attempts: number; replayed: boolean }
  | { ok: false; phase: Phase; obstacle: Obstacle; error: string; correlationId: string; replayed: boolean };

export async function recoverCall<T>(opts: {
  write: boolean;
  correlationId: string;
  serverId: string;
  transport: TransportName;
  linked: boolean;
  flight: Flight;
  breaker?: Breaker;
  budget?: number;
  secrets?: string[];
  call: () => Promise<T>;
  reconnect: () => Promise<{ ok: boolean; tools: string[]; error?: string; code?: number }>;
  permitted: (tools: string[]) => boolean;
  onPhase?: (phase: Phase) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}): Promise<RecoverResult<T>> {
  const budget = opts.budget ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const breaker = opts.breaker ?? { failures: 0, openedAt: null };
  let online = opts.linked;
  let phase: Phase = online ? 'connected' : 'disconnected';
  let attempt = 0;
  let replayed = false;
  const tell = (next: Phase) => {
    phase = next;
    opts.onPhase?.(next);
  };
  const stop = (obstacle: Obstacle, error: string): RecoverResult<T> => {
    tell(obstacle === 'auth' || attempt + 1 >= budget ? 'failed' : phase);
    return { ok: false, phase, obstacle, error: scrub(error, opts.secrets), correlationId: opts.correlationId, replayed };
  };

  while (attempt < budget) {
    if (breakerOpen(breaker, now())) return stop('availability', 'coupure répétée, reprise suspendue');
    if (!online) {
      tell('disconnected');
      tell('reconnecting');
      const again = await opts.flight.run(`${opts.serverId}:${opts.transport}`, () => opts.reconnect());
      tell('verifying');
      const kind = classifyLink(again.error ?? '', again.code);
      if (!again.ok || !opts.permitted(again.tools)) {
        noteFailure(breaker, now());
        const obstacle = !again.ok ? kind.obstacle : 'session';
        const error = again.error || 'outil absent après redécouverte';
        if (!again.ok && !kind.recoverable) return stop(obstacle, error);
        if (attempt + 1 >= budget) return stop(obstacle, error);
        tell('degraded');
        await sleep(delayMs(attempt, random()));
        attempt += 1;
        replayed = true;
        continue;
      }
      online = true;
      tell('connected');
    }
    try {
      const value = await opts.call();
      breaker.failures = 0;
      breaker.openedAt = null;
      tell('connected');
      return { ok: true, value, phase: 'connected', correlationId: opts.correlationId, attempts: attempt + 1, replayed };
    } catch (error) {
      const parsed = readFailure(error);
      const kind = classifyLink(parsed.message, parsed.code);
      noteFailure(breaker, now());
      if (opts.write || !kind.recoverable || attempt + 1 >= budget) {
        tell(kind.obstacle === 'auth' ? 'failed' : 'degraded');
        if (kind.obstacle === 'auth' || attempt + 1 >= budget) tell('failed');
        return { ok: false, phase, obstacle: kind.obstacle, error: scrub(parsed.message, opts.secrets), correlationId: opts.correlationId, replayed };
      }
      online = false;
      replayed = true;
      tell('degraded');
      await sleep(delayMs(attempt, random()));
      attempt += 1;
    }
  }
  return stop('unknown', 'budget de reprise épuisé');
}
