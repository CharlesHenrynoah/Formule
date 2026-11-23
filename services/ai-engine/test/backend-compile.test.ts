import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileTools, loadBackend, testBackend } from '../../../packages/app-mcp/src/core.mjs';
import { compileBackend, guardBackendSource } from '../src/agent/engine/backend/compile.ts';
import { EXAMPLE_CONTRACT } from '../src/agent/engine/backend/registry.ts';

const issues = [
  { id: '1', state: 'open', created_at: '2026-01-02', stars: 3 },
  { id: '2', state: 'closed', created_at: '2026-01-01', stars: 1 },
];

test('le contrat d\'exemple devient un handler synchrone conforme', async () => {
  const compiled = compileBackend([
    EXAMPLE_CONTRACT,
    { name: 'lister_issues', collection: 'issues', operation: 'sort', field: 'created_at', direction: 'desc' },
    { name: 'par_etat', collection: 'issues', operation: 'groupBy', field: 'state' },
    { name: 'projeter', collection: 'issues', operation: 'simulate', filter: { state: 'open' } },
  ]);
  assert.equal(compiled.ok, true);
  assert.match(compiled.source, /export const tools/);
  assert.doesNotMatch(compiled.source, /\b(async|await)\b/);
  const backend = loadBackend(await compileTools(compiled.source), { issues });
  assert.equal(backend.call('get_issue_stats', {}).total, 1);
  assert.equal(backend.call('get_issue_stats', { state: 'closed' }).total, 1);
  assert.equal(backend.call('lister_issues', {}).items[0].id, '1');
  assert.equal(backend.call('lister_issues', {}).total, 2);
  assert.equal(backend.call('par_etat', {}).items.length, 2);
  assert.equal(backend.call('projeter', { factor: 2 }).total, 2);
  const report = await testBackend(compiled.source, null);
  assert.equal(report.ok, true);
  assert.equal(report.smoke.filter((item: { ok: boolean }) => item.ok).length, report.tools.length);
});

test('un backend vide, async ou sans export est refusé', () => {
  assert.match(guardBackendSource('').join(' '), /0 bytes/);
  assert.deepEqual(guardBackendSource('export const tools = { lire: { run: (args, db) => ({ total: db.count("issues"), totalCount: 0 }) } };'), []);
  assert.match(guardBackendSource('export const tools = { lire: { run: async (args, db) => ({ total: 1 }) } };').join(' '), /async\/await/);
  assert.match(guardBackendSource('const tools = {};').join(' '), /0\/0/);
  const custom = compileBackend([{ name: 'faire', collection: 'issues', operation: 'predict' }]);
  assert.equal(custom.ok, false);
  assert.equal(custom.typescript, true);
});

test('une collection vide reste conforme', async () => {
  const compiled = compileBackend([EXAMPLE_CONTRACT]);
  const backend = loadBackend(await compileTools(compiled.source), {});
  assert.equal(backend.call('get_issue_stats', {}).total, 0);
  const report = await testBackend(compiled.source, null);
  assert.equal(report.ok, true);
  assert.equal(report.smoke.filter((item: { ok: boolean }) => item.ok).length, 1);
});
