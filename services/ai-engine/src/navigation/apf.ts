import { senseLines, type GenLog } from '../agent/sensor.ts';
import { linkChain, type Chain } from '../agent/engine/chain.ts';
import { evaluate, type Report } from '../evaluation/evaluator.ts';
import type { DataContract } from '../../../../packages/contracts/src/types.ts';
import { locate, type Layer } from '../evaluation/repair.ts';
import { remember } from '../experience/memory.ts';
import { reusable, type Experience } from '../experience/regression.ts';

export type ObstacleKind = 'bug' | 'regression' | 'fragile-dependency' | 'contract' | 'uncertainty';

export type Obstacle = {
  kind: ObstacleKind;
  note: string;
  layer: Layer;
  weight: number;
};

export type Trajectory = {
  id: string;
  progress: number;
  risk: number;
  complexity: number;
  uncertainty: number;
  invariants: string[];
};

export type Field = {
  logs: GenLog[];
  chain: Chain | null;
  report: Report | null;
  obstacles: Obstacle[];
  distance: number;
};

function push(obstacles: Obstacle[], item: Obstacle) {
  if (obstacles.some((known) => known.kind === item.kind && known.note === item.note)) return;
  obstacles.push(item);
}

/** Carte réelle : journal, chaîne, évaluateur, mémoire. La distance est la somme des répulsions. */
export function mapField(input: {
  events?: Array<{ type?: string; [key: string]: unknown }>;
  prompt?: string;
  fields?: string[];
  page?: string;
  raw?: Array<Record<string, unknown>>;
  stored?: Array<Record<string, unknown>>;
  contract?: DataContract;
  memory?: Experience[];
}): Field {
  const logs = (input.events ?? []).flatMap((event) => senseLines(event));
  const obstacles: Obstacle[] = [];
  for (const log of logs) {
    if (log.level !== 'error') continue;
    const kind: ObstacleKind = /régress|regress/.test(log.text) ? 'regression' : /dépendance|depend/.test(log.text) ? 'fragile-dependency' : 'bug';
    push(obstacles, { kind, note: log.text, layer: locate(`${log.step} ${log.text}`), weight: 1 });
  }
  const chain = input.prompt ? linkChain(input.prompt, input.fields ?? []) : null;
  if (chain && !chain.ok) push(obstacles, { kind: 'contract', note: chain.text, layer: 'frontend', weight: 1 });
  const report = input.prompt || input.contract
    ? evaluate({ prompt: input.prompt, page: input.page, raw: input.raw, stored: input.stored, contract: input.contract })
    : null;
  for (const failure of report?.failures ?? []) {
    const kind: ObstacleKind = failure.id === 'integrite' || failure.id === 'schema' || failure.id === 'intention' ? 'contract' : 'bug';
    push(obstacles, { kind, note: failure.note, layer: locate(failure.note), weight: 1 });
  }
  for (const item of input.memory ?? []) {
    if (!item.validated) push(obstacles, { kind: 'uncertainty', note: item.rootCause, layer: locate(item.rootCause), weight: 0.5 });
  }
  const distance = obstacles.reduce((sum, item) => sum + item.weight, 0);
  return { logs, chain, report, obstacles, distance };
}

export function trajectoryScore(candidate: Trajectory): number {
  return candidate.progress - candidate.risk - 0.5 * candidate.uncertainty - 0.25 * candidate.complexity;
}

/** Retient la trajectoire admissible au meilleur rapport progression/risque. */
export function selectTrajectory(candidates: Trajectory[]): { chosen: Trajectory | null; localMinimum: boolean } {
  const admissible = candidates.filter((candidate) => candidate.invariants.length === 0 && candidate.progress > 0);
  if (!admissible.length) return { chosen: null, localMinimum: candidates.length > 0 };
  const ranked = [...admissible].sort((a, b) => trajectoryScore(b) - trajectoryScore(a) || a.risk - b.risk);
  if (trajectoryScore(ranked[0]) <= 0) return { chosen: null, localMinimum: true };
  return { chosen: ranked[0], localMinimum: false };
}

/** Une baisse de distance ne compte que si une preuve l'accompagne. */
export function acceptProgress(before: number, after: number, proven: boolean): boolean {
  return proven && after < before;
}

/** Échec : la cause est localisée, l'état précédent reste la référence, la correction non validée n'est pas rejouée. */
export function recalibrate(memory: Experience[], failure: { note: string; input: unknown }): { memory: Experience[]; layer: Layer; restored: true; replay: Experience | null } {
  const layer = locate(failure.note);
  const next = remember(memory, {
    errorType: layer,
    rootCause: failure.note,
    failingInput: failure.input,
    correction: '',
    regressionTest: `apf:${layer}`,
    validated: false,
  });
  return { memory: next, layer, restored: true, replay: reusable(next, layer) };
}
