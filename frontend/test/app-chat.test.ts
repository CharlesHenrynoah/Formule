import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatEmptyReason, hasNewActivity, normalizeChat, upsertPipeline, type ChatMsg } from '../src/lib/appChat.ts';

test('normalizeChat filtre les messages invalides venus de l’iframe', () => {
  const m = normalizeChat([{ id: 'a', role: 'user', text: 'simule +10 %' }, { role: 'agent' }, { id: 'x', role: 'hack' }, null, { id: 'b', role: 'agent', text: 'ok', steps: [{ id: 's', tool: 'get_kpis', kind: 'tool', ok: true }] }]);
  assert.equal(m.length, 2);
  assert.equal(m[1].role, 'agent');
  assert.equal((m[1] as Extract<ChatMsg, { role: 'agent' }>).steps.length, 1);
  assert.deepEqual(normalizeChat('nope'), []);
});

test('hasNewActivity : indicateur de l’onglet Chat app', () => {
  const prev: ChatMsg[] = [{ id: 'u1', role: 'user', text: 'q' }, { id: 'a1', role: 'agent', text: '', steps: [] }];
  assert.equal(hasNewActivity(prev, prev), false);
  assert.equal(hasNewActivity(prev, [prev[0], { id: 'a1', role: 'agent', text: 'réponse', steps: [] }]), true);
  const pipe = { id: 'p', role: 'pipeline' as const, title: 'Évolution', status: 'running', steps: [] };
  assert.equal(hasNewActivity(prev, upsertPipeline(prev, pipe)), false);
  assert.equal(hasNewActivity(upsertPipeline(prev, pipe), upsertPipeline(prev, { ...pipe, status: 'done' })), true);
  assert.equal(upsertPipeline(upsertPipeline(prev, pipe), { ...pipe, status: 'done' }).length, 3);
});

test('chatEmptyReason : état vide explicite', () => {
  assert.match(chatEmptyReason({ hasProject: false, running: false, appError: null, capable: null })!, /Aucune app/);
  assert.match(chatEmptyReason({ hasProject: true, running: false, appError: null, capable: false })!, /pas de chat intégré/);
  assert.equal(chatEmptyReason({ hasProject: true, running: false, appError: null, capable: true }), null);
});

import { isAuthError, parseHeaderLines } from '../src/lib/mcpAuth.ts';
test('formulaire MCP : en-têtes personnalisés et erreurs 401', () => {
  assert.deepEqual(parseHeaderLines('X-Org: 42\n# commentaire\n\nX-Env : prod'), { 'X-Org': '42', 'X-Env': 'prod' });
  assert.throws(() => parseHeaderLines('pas-de-deux-points'));
  assert.equal(isAuthError('Le serveur demande une authentification : ajoute un jeton Bearer. Détail : …'), true);
  assert.equal(isAuthError('délai de connexion dépassé (20 s)'), false);
});
