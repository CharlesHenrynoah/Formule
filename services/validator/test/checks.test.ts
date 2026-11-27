import { describe, expect, it } from 'vitest';
import { checkHtml, checkSpec } from '../src/checks.js';

describe('validateur statique', () => {
  it('refuse script externe, cookie, window.top, URL inconnue', () => {
    const f = checkHtml('<script src="https://cdn.evil.example/x.js"></script><script>document.cookie; window.top.x; fetch("https://api.tiers.example")</script>');
    const rules = f.map((x) => x.rule);
    expect(rules).toEqual(expect.arrayContaining(['script-externe', 'cookie', 'window-top', 'url-inconnue']));
  });
  it('accepte le pont postMessage', () => {
    expect(checkHtml('<script>window.parent.postMessage({}, "*")</script>')).toEqual([]);
  });
  it('refuse un outil inventé', () => {
    const spec = { specVersion: 1, title: 't', mission: '', demo: true, requirements: [], views: [], queries: [{ id: 'q', serverId: 'demo', tool: 'invente' }] };
    expect(checkSpec(spec, [{ serverId: 'demo', tools: [{ name: 'vrai', permission: 'read' }] }])[0].rule).toBe('outil-invente');
  });
});
