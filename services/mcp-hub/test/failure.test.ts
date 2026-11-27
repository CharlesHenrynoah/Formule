import { describe, expect, it } from 'vitest';
import { classifyError, retryAfterMs, ReadCooldown } from '../src/failure.js';
describe('classification universelle', () => {
  it.each(['Failed to generate response', 'Cannot operate on data', 'Invalid exchange rate'])('pas de faux quota : %s', (message) => expect(['quota','rate_limited']).not.toContain(classifyError(message)));
  it('distingue quota et débit', () => {
    expect(classifyError({ status: 429 })).toBe('rate_limited');
    expect(classifyError({ status: 429, error: { code: 'insufficient_quota' } })).toBe('quota');
    expect(classifyError('Rate limit exceeded')).toBe('rate_limited');
    expect(classifyError('Error: 429')).toBe('rate_limited');
    expect(classifyError('Quota exceeded')).toBe('quota');
    expect(classifyError({ code: -32602, message: 'Invalid arguments' })).toBe('invalid_schema');
  });
  it('respecte Retry-After', () => {
    expect(retryAfterMs({ response: { headers: { 'Retry-After': '12' } } })).toBe(12000);
    expect(retryAfterMs({ headers: new Headers({ 'Retry-After': '5' }) })).toBe(5000);
    expect(retryAfterMs({ retryAfterMs: 1200 })).toBe(1200);
  });
  it('suspend uniquement le serveur concerné et expire sans relance automatique', () => {
    const c = new ReadCooldown();
    c.block('a','rate_limited',12000,1000);
    expect(c.active('a',2000)).toEqual({kind:'rate_limited',retryAfterMs:11000});
    expect(c.active('b',2000)).toBeUndefined();
    expect(c.active('a',13000)).toBeUndefined();
    c.block('b','invalid_schema',undefined,1000);
    expect(c.active('b',1001)).toBeUndefined();
  });
});
