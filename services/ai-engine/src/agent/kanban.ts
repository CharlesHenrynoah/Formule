/** Tableau de flux. Une carte se termine avant que la suivante s'ouvre. Deux cartes en cours est le plafond. */

export const WIP_LIMIT = 2;

export type KanbanColumn = 'todo' | 'doing' | 'done';
export type KanbanCard = { id: string; title: string; column: KanbanColumn; pulledAt?: number; doneAt?: number };
export type KanbanBoard = { cards: KanbanCard[]; openedAt: number; maxWip: number };
export type PullResult =
  | { ok: true; card: KanbanCard; wip: number }
  | { ok: false; reason: 'limite' | 'en-cours' | 'vide' };

export function openBoard(items: Array<{ id: string; title: string }>, now = Date.now()): KanbanBoard {
  return { cards: items.map((item) => ({ ...item, column: 'todo' })), openedAt: now, maxWip: 0 };
}

export function addCards(board: KanbanBoard, items: Array<{ id: string; title: string }>) {
  for (const item of items) if (!board.cards.some((card) => card.id === item.id)) board.cards.push({ ...item, column: 'todo' });
}

/** Tire la première carte à faire. `finishFirst` refuse tant qu'une carte est déjà en cours. */
export function pull(board: KanbanBoard, now = Date.now(), opts?: { finishFirst?: boolean }): PullResult {
  const doing = board.cards.filter((card) => card.column === 'doing');
  if (doing.length >= WIP_LIMIT) return { ok: false, reason: 'limite' };
  if (opts?.finishFirst !== false && doing.length > 0) return { ok: false, reason: 'en-cours' };
  const next = board.cards.find((card) => card.column === 'todo');
  if (!next) return { ok: false, reason: 'vide' };
  next.column = 'doing';
  next.pulledAt = now;
  board.maxWip = Math.max(board.maxWip, doing.length + 1);
  return { ok: true, card: next, wip: doing.length + 1 };
}

export function finish(board: KanbanBoard, id: string, now = Date.now()) {
  const card = board.cards.find((item) => item.id === id);
  if (!card || card.column !== 'doing') return card;
  card.column = 'done';
  card.doneAt = now;
  return card;
}

/** Renvoie une carte en cours vers À faire, pour libérer le flux. */
export function requeue(board: KanbanBoard, id: string) {
  const card = board.cards.find((item) => item.id === id);
  if (!card || card.column === 'done') return card;
  card.column = 'todo';
  card.pulledAt = undefined;
  return card;
}

/** Rouvre une carte terminée. Refusé si une autre occupe déjà le flux. */
export function reopen(board: KanbanBoard, id: string, now = Date.now()): PullResult {
  const card = board.cards.find((item) => item.id === id);
  if (!card) return { ok: false, reason: 'vide' };
  if (card.column === 'doing') return { ok: true, card, wip: board.cards.filter((item) => item.column === 'doing').length };
  const doing = board.cards.filter((item) => item.column === 'doing');
  if (doing.length >= WIP_LIMIT) return { ok: false, reason: 'limite' };
  if (doing.length > 0) return { ok: false, reason: 'en-cours' };
  card.column = 'doing';
  card.pulledAt = now;
  card.doneAt = undefined;
  board.maxWip = Math.max(board.maxWip, doing.length + 1);
  return { ok: true, card, wip: doing.length + 1 };
}

export function view(board: KanbanBoard, now = Date.now()) {
  const titles = (column: KanbanColumn) => board.cards.filter((card) => card.column === column).map((card) => card.title);
  const cycles = board.cards.flatMap((card) => card.column === 'done' && card.pulledAt && card.doneAt ? [card.doneAt - card.pulledAt] : []);
  const doing = titles('doing');
  return {
    todo: titles('todo'), doing, done: titles('done'),
    wip: doing.length, limit: WIP_LIMIT, maxWip: board.maxWip, doneCount: titles('done').length,
    leadMs: Math.max(0, now - board.openedAt),
    cycleMs: cycles.length ? Math.round(cycles.reduce((sum, ms) => sum + ms, 0) / cycles.length) : 0,
  };
}

export function fluxLine(snap: ReturnType<typeof view>) {
  const sec = (ms: number) => `${Math.max(0, Math.round(ms / 1000))} s`;
  const n = snap.doneCount;
  return `Flux : délai ${sec(snap.leadMs)} · cycle ${sec(snap.cycleMs)} · ${n} terminée${n > 1 ? 's' : ''} · pointe ${snap.maxWip}/${snap.limit}`;
}
