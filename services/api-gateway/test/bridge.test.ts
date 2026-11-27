import { describe, expect, it } from 'vitest';
import { decideBridge, APP_CSP } from '../src/bridge.js';
import { RateLimiter } from '../src/ratelimit.js';

const spec = { queries: [{ id: 'q', serverId: 'demo', tool: 'factures_lister', args: {}, refresh: { mode: 'once' } }] } as never;

describe('pont d’exécution', () => {
  it('liste blanche', () => {
    expect(decideBridge(spec, 'demo__factures_lister', {}).ok).toBe(true);
    expect(decideBridge(spec, 'demo__campagne_mettre_en_pause', {})).toMatchObject({ ok: false, status: 403 });
    expect(decideBridge(spec, 'app__simuler', { viewId: 'sim' }).ok).toBe(true);
  });
  it('arguments bornés et figés', () => {
    expect(decideBridge(spec, 'demo__factures_lister', { x: 'a'.repeat(21_000) })).toMatchObject({ ok: false, status: 413 });
    expect(decideBridge(spec, 'demo__factures_lister', { curseur: '40' })).toMatchObject({ ok: false, status: 403 });
  });
  it('60 appels par minute', () => {
    const l = new RateLimiter(60, 60_000);
    const res = Array.from({ length: 61 }, () => l.take('p', 1000));
    expect(res.filter(Boolean)).toHaveLength(60);
    expect(l.take('p', 62_000)).toBe(true);
  });
  it('CSP sans réseau', () => { expect(APP_CSP).toContain("connect-src 'none'"); });
});
