/**
 * Coupure entre la passerelle et le moteur.
 * Un redémarrage (tsx watch) ou un MCP qui fait tomber le processus
 * doit être attendu, pas affiché comme un échec au premier silence.
 */

export const RELAY_BUDGET_MS = 45_000;
export const RELAY_TRIES = 5;

const CUT = /terminated|econnrefused|econnreset|etimedout|und_err_|socket hang up|other side closed|fetch failed|failed to fetch|headers timeout|body timeout|flux interrompu/;

/** undici met toujours « fetch failed » dans message. La cause réelle est dans cause. */
export function causeText(e: unknown) {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 6 && cur && typeof cur === 'object'; i++) {
    const o = cur as { message?: unknown; code?: unknown; cause?: unknown };
    if (o.message) parts.push(String(o.message));
    if (o.code) parts.push(String(o.code));
    cur = o.cause;
  }
  if (!parts.length) parts.push(String(e ?? ''));
  return parts.join(' ').toLowerCase();
}

export function linkCut(e: unknown) {
  return CUT.test(causeText(e));
}

/** Rejoue tant que la coupure est réseau et que le moteur n'a pas déjà répondu une erreur métier. */
export function relayAgain(error: unknown, attempt: number, tries = RELAY_TRIES) {
  if (attempt + 1 >= tries) return false;
  if (error && typeof error === 'object' && (error as { delivered?: boolean }).delivered) return false;
  return linkCut(error);
}
