import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WIP_LIMIT, addCards, finish, fluxLine, openBoard, pull, reopen, requeue, view } from '../src/agent/kanban.ts';

test('une carte se termine avant que la suivante s’ouvre, et la troisième est refusée', () => {
  const board = openBoard([{ id: 'a', title: 'Données' }, { id: 'b', title: 'Atomes' }, { id: 'c', title: 'Page' }], 1_000);
  const first = pull(board, 1_100);
  assert.equal(first.ok && first.card.id, 'a');
  const busy = pull(board, 1_200);
  assert.equal(busy.ok, false);
  if (!busy.ok) assert.equal(busy.reason, 'en-cours');
  finish(board, 'a', 2_000);
  assert.equal(pull(board, 2_100, { finishFirst: false }).ok, true);
  assert.equal(pull(board, 2_200, { finishFirst: false }).ok, true);
  const blocked = pull(board, 2_300, { finishFirst: false });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.reason, 'limite');
  assert.equal(WIP_LIMIT, 2);
  assert.equal(view(board, 3_000).maxWip, 2);
});

test('la revue libère le flux, la page peut se rouvrir, les mesures sortent en français', () => {
  const board = openBoard([{ id: 'page', title: 'Page' }], 0);
  pull(board, 0);
  finish(board, 'page', 4_000);
  addCards(board, [{ id: 'revue', title: 'Revue' }]);
  assert.equal(pull(board, 5_000).ok, true);
  requeue(board, 'revue');
  const again = reopen(board, 'page', 6_000);
  assert.equal(again.ok && again.card.column, 'doing');
  const held = pull(board);
  assert.equal(held.ok, false);
  if (!held.ok) assert.equal(held.reason, 'en-cours');
  finish(board, 'page', 8_000);
  const snap = view(board, 8_000);
  assert.deepEqual(snap.done, ['Page']);
  assert.equal(snap.todo[0], 'Revue');
  assert.match(fluxLine(snap), /délai 8 s · cycle 2 s · 1 terminée · pointe 1\/2/);
});
