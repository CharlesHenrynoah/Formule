export type JobEventType =
  | 'job.created' | 'job.state' | 'step' | 'log' | 'source' | 'requirement' | 'answer'
  | 'certification' | 'published' | 'limitation' | 'error' | 'job.done';

export interface JobEvent {
  eventId: string; jobId: string; projectId: string | null; version: number | null;
  seq: number; type: JobEventType; timestamp: string; payload: Record<string, unknown>;
}

/** Déduplication côté client : on garde le plus grand seq vu et on ignore le reste. */
export class EventCursor {
  private seen = new Set<string>();
  last = 0;
  accept(e: JobEvent): boolean {
    if (this.seen.has(e.eventId) || e.seq <= this.last) return false;
    this.seen.add(e.eventId); this.last = e.seq; return true;
  }
}
