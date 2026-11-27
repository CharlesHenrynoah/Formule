export const SERIES_COLORS = ['#6eacd7', '#79bb9e', '#d5ba82', '#9f8fbe'] as const;
export function toolKey(serverId: string, tool: string): string { return `${serverId}__${tool}`; }
export function splitToolKey(key: string): { serverId: string; tool: string } | null {
  const i = key.indexOf('__');
  if (i <= 0) return null;
  return { serverId: key.slice(0, i), tool: key.slice(i + 2) };
}
