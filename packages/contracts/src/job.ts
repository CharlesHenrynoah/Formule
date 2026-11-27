/**
 * Machine à états durable des jobs. Le LLM ne déclenche jamais une transition :
 * seul le code appelle transition(), qui refuse toute transition non déclarée.
 */
export const BUILD_STATES = [
  'DRAFT', 'DISCOVERY', 'CONTRACT', 'BUILD', 'CERTIFICATION', 'READY', 'ACTIVE',
  'BLOCKED', 'CANCELLED', 'FAILED', 'DEGRADED', 'REPAIR',
] as const;
export const ASK_STATES = ['DRAFT', 'DISCOVERY', 'DONE', 'BLOCKED', 'CANCELLED', 'FAILED'] as const;

export type BuildState = (typeof BUILD_STATES)[number];
export type AskState = (typeof ASK_STATES)[number];
export type JobState = BuildState | AskState;
export type JobKind = 'build' | 'ask';

const BUILD_T: Record<BuildState, BuildState[]> = {
  DRAFT: ['DISCOVERY', 'BLOCKED', 'CANCELLED', 'FAILED'],
  DISCOVERY: ['CONTRACT', 'BLOCKED', 'CANCELLED', 'FAILED'],
  CONTRACT: ['BUILD', 'BLOCKED', 'CANCELLED', 'FAILED'],
  BUILD: ['CERTIFICATION', 'CANCELLED', 'FAILED'],
  // DEGRADED = livraison partielle étiquetée (porte G6 incomplète) ; REPAIR = réparation bornée.
  CERTIFICATION: ['READY', 'DEGRADED', 'REPAIR', 'FAILED', 'CANCELLED'],
  READY: ['ACTIVE', 'CANCELLED', 'FAILED'],
  ACTIVE: [],
  DEGRADED: [],
  REPAIR: ['BUILD', 'FAILED', 'CANCELLED'],
  BLOCKED: ['CANCELLED'],
  CANCELLED: [],
  FAILED: [],
};

const ASK_T: Record<AskState, AskState[]> = {
  DRAFT: ['DISCOVERY', 'BLOCKED', 'CANCELLED', 'FAILED'],
  DISCOVERY: ['DONE', 'BLOCKED', 'CANCELLED', 'FAILED'],
  DONE: [], BLOCKED: [], CANCELLED: [], FAILED: [],
};

export class InvalidTransitionError extends Error {
  constructor(public kind: JobKind, public from: string, public to: string) {
    super(`Transition refusée (${kind}) : ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function allowedTransitions(kind: JobKind, from: JobState): JobState[] {
  const table = (kind === 'build' ? BUILD_T : ASK_T) as Record<string, JobState[]>;
  return table[from] ?? [];
}

export function canTransition(kind: JobKind, from: JobState, to: JobState): boolean {
  return allowedTransitions(kind, from).includes(to);
}

export function assertTransition(kind: JobKind, from: JobState, to: JobState): void {
  if (!canTransition(kind, from, to)) throw new InvalidTransitionError(kind, from, to);
}

export function isTerminal(kind: JobKind, s: JobState): boolean {
  return allowedTransitions(kind, s).length === 0;
}

/** Étapes visibles côté Studio (jamais de rôles internes). */
export const VISIBLE_STEPS = ['Analyse des données', 'Conception', 'Construction', 'Vérification'] as const;
export function visibleStep(state: JobState): (typeof VISIBLE_STEPS)[number] | null {
  switch (state) {
    case 'DRAFT': case 'DISCOVERY': return 'Analyse des données';
    case 'CONTRACT': return 'Conception';
    case 'BUILD': case 'REPAIR': return 'Construction';
    case 'CERTIFICATION': return 'Vérification';
    default: return null;
  }
}
