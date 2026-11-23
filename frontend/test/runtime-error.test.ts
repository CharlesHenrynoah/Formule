import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainRuntimeError, fixOrder, toRuntimeError } from '../src/lib/runtimeError.ts';

const RAW = 'Uncaught Error: Minified React error #130; visit https://react.dev/errors/130?args[]=undefined&args[]= for the full message or use the non-minified dev environment for full errors and additional helpful warnings.';

test('erreur React minifiée de la mini-app → message lisible', () => {
  const t = explainRuntimeError(RAW);
  assert.match(t, /^React #130 : un composant utilisé dans le JSX vaut undefined/);
  assert.match(t, /reçu : undefined/);
  assert.equal(explainRuntimeError('TypeError: boom'), 'TypeError: boom');
});

test('« Demander à Formule Agent de corriger » : ordre evolve_app avec panneau, pile et message brut', () => {
  const e = toRuntimeError({ message: RAW, panel: '🎛️ Pads & raccourcis', componentStack: 'span ← ErrorBoundary ← Panel ← AppShell' });
  const o = fixOrder(e);
  assert.match(o, /panneau « 🎛️ Pads & raccourcis »/);
  assert.match(o, /Composants : span ← ErrorBoundary ← Panel/);
  assert.match(o, /evolve_app/);
  assert.equal(toRuntimeError({ message: 'x', explained: 'déjà expliqué' }).explained, 'déjà expliqué');
});
