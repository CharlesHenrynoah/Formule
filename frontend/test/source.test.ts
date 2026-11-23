import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSourceRefresh, isPaused, CONTINUE_ORDER, PAUSE_MARK } from '../src/lib/source.ts';

test('pad « Rafraîchir » : execute_workflow d’une app qui lit ses exécutions → exécuter → attendre → ingérer', () => {
  const wl = ['n8n__search_workflow_executions', 'n8n__get_workflow_execution', 'n8n__execute_workflow', 'demo__send_alert'];
  assert.equal(isSourceRefresh('n8n__execute_workflow', wl), true);
  assert.equal(isSourceRefresh('demo__send_alert', wl), false);
  assert.equal(isSourceRefresh('n8n__execute_workflow', ['n8n__execute_workflow']), false, 'sans lecture des exécutions : appel direct');
  assert.equal(isSourceRefresh('n8n__publish_workflow', wl), false);
});

test('chantier en pause → bouton « Continuer »', () => {
  assert.equal(isPaused(`Données déjà obtenues…\n\n${PAUSE_MARK} (budget de 20 étapes utilisé).`), true);
  assert.equal(isPaused('⛔ Limite de 8 étapes atteinte : chantier arrêté'), true, 'anciens messages aussi');
  assert.equal(isPaused('✅ Fait'), false);
  assert.match(CONTINUE_ORDER, /Continue le chantier/);
});
