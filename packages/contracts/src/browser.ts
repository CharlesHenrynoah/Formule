// Point d'entrée sans dépendance (pas de zod) pour le runtime des apps générées.
export * from './canonical.js';
export * from './values.js';
export * from './series.js';
export * from './aggregate.js';
export * from './simulate.js';
export * from './consts.js';
export * from './events.js';
export type { AppSpec, ViewSpec, QuerySpec, ActionSpec, AppDataBundle, Aggregate } from './spec.js';
export type { AcquisitionEnvelope, FailureKind } from './envelope.js';
export { FAILURE_LABEL } from './envelope.js';
export * from './shapes.js';
