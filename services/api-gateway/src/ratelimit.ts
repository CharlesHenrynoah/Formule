/** Fenêtre glissante : 60 appels/min par clé (app). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max = 60, private windowMs = 60_000) {}
  take(key: string, now = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) { this.hits.set(key, arr); return false; }
    arr.push(now); this.hits.set(key, arr); return true;
  }
}
