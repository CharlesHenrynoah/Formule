import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sense, senseLines } from '../src/agent/sensor.ts';

const at = '2026-11-24T07:40:00.000Z';

test('un outil de la liaison devient une ligne horodatée', () => {
  const line = sense({ type: 'agent', kind: 'tool_result', role: 'data', tool: 'mcp_call', ok: false, summary: 'lecture refusée' }, at);
  assert.equal(line?.component, 'Liaison');
  assert.equal(line?.step, 'mcp_call');
  assert.equal(line?.level, 'error');
  assert.equal(line?.at, at);
});

test('les deltas de code ne remplissent pas le journal', () => {
  assert.equal(sense({ type: 'code_delta', text: 'x' }, at), null);
  assert.equal(sense({ type: 'log', component: 'Déjà', step: 'vu', text: 'x' }, at), null);
});

test('un appel se déplie en une ligne par argument, plus la durée', () => {
  const lines = senseLines({
    type: 'agent', kind: 'tool', role: 'data', tool: 'mcp_call',
    args: { tool: 'demo__list_notes', args: { limit: 5, city: 'Lyon' } },
  }, at);
  assert.deepEqual(lines.map((line) => line.text), ['demo__list_notes', 'limit=5', 'city=Lyon']);
  const done = senseLines({ type: 'agent', kind: 'tool_result', role: 'dev', tool: 'write_file', ok: true, summary: 'écrit', ms: 12 }, at);
  assert.equal(done.at(-1)?.text, '12 ms');
});

test('la finition et la passerelle ont un composant', () => {
  assert.equal(sense({ type: 'phase', phase: 'validate', label: 'Validation du code' }, at)?.component, 'Passerelle');
  assert.equal(sense({ type: 'error', message: 'coupé' }, at)?.level, 'error');
  assert.equal(sense({ type: 'chart_ready', chart: { title: 'Commits' } }, at)?.text, 'Commits');
});
