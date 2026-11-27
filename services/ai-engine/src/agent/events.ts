import { call } from '@formule/service-kit';
import { redact, visibleStep, type JobEvent, type JobState } from '@formule/contracts';

type Listener = (e: JobEvent) => void;
const listeners = new Map<string, Set<Listener>>();

export function subscribe(jobId: string, l: Listener) {
  if (!listeners.has(jobId)) listeners.set(jobId, new Set());
  listeners.get(jobId)!.add(l);
  return () => listeners.get(jobId)?.delete(l);
}

export interface JobRef { id: string; projectId: string | null; version: number | null; kind: 'build' | 'ask'; state: JobState }

/** Événement persisté (seq attribué par le stockage), puis diffusé. Charge utile expurgée. */
export async function emit(job: JobRef, type: JobEvent['type'], payload: Record<string, unknown>) {
  const ev = await call<JobEvent>('storage', '/events', { body: { jobId: job.id, projectId: job.projectId, version: job.version, type, payload: redact(payload) } });
  listeners.get(job.id)?.forEach((l) => l(ev));
  return ev;
}

export async function setState(job: JobRef, to: JobState) {
  await call('storage', `/jobs/${job.id}/transition`, { body: { to } });
  const from = job.state;
  job.state = to;
  await emit(job, 'job.state', { from, to, step: visibleStep(to) });
}
