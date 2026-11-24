export type SyncMode = 'stream' | 'poll' | 'event' | 'on-demand';

/** La stratégie suit les capacités déclarées. Sans signal, la lecture reste à la demande. */
export function syncMode(caps: { stream?: boolean; webhook?: boolean; poll?: boolean }): SyncMode {
  if (caps.stream) return 'stream';
  if (caps.webhook) return 'event';
  if (caps.poll) return 'poll';
  return 'on-demand';
}
