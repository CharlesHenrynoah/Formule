import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHtml } from '../src/validate.ts';

const wrap = (body: string, head = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

test('accepte une mini-app valide', () => {
  const r = validateHtml(wrap('<button id="b">ok</button><script>document.getElementById("b").onclick=()=>alert(1)</script>'));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.stats.scripts, 1);
});

test('détecte une erreur de syntaxe JS avec la ligne', () => {
  const r = validateHtml(wrap('\n<script>\nconst x = ;\n</script>'));
  assert.equal(r.ok, false);
  const e = r.errors.find((x) => x.code === 'syntax');
  assert.ok(e, 'erreur syntax attendue');
  assert.ok((e!.line ?? 0) >= 2);
});

test('détecte une sortie tronquée', () => {
  const r = validateHtml('<!doctype html><html><body><script>let a = 1;');
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'truncated'));
  assert.ok(r.errors.some((e) => e.code === 'unclosed-script'));
});

test('bloque document.cookie et top.location', () => {
  const r = validateHtml(wrap('<script>console.log(document.cookie); top.location = "x"</script>'));
  assert.ok(r.errors.some((e) => e.code === 'cookie'));
  assert.ok(r.errors.some((e) => e.code === 'frame-escape'));
});

test('autorise les CDN connus et refuse les autres', () => {
  const ok = validateHtml(wrap('', '<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>'));
  assert.equal(ok.ok, true);
  const ko = validateHtml(wrap('', '<script src="https://evil.example.com/x.js"></script>'));
  assert.ok(ko.errors.some((e) => e.code === 'script-host'));
});

test('analyse le JSX des scripts text/babel', () => {
  const good = validateHtml(wrap('<script type="text/babel">const App = () => <div className="a">Salut</div>;</script>'));
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  const bad = validateHtml(wrap('<script type="text/babel">const App = () => <div>Salut</span>;</script>'));
  assert.equal(bad.ok, false);
});

test('signale eval en avertissement', () => {
  const r = validateHtml(wrap('<script>eval("1+1")</script>'));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.code === 'eval'));
});

test('toutes les mini-apps du mock passent la validation', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../../ai-engine/src/mock/apps/', import.meta.url);
  for (const f of readdirSync(dir)) {
    const r = validateHtml(readFileSync(new URL(f, dir), 'utf8'));
    assert.equal(r.ok, true, `${f} : ${JSON.stringify(r.errors)}`);
  }
});
