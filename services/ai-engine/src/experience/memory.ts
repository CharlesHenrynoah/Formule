import type { Experience } from './regression.ts';

export function remember(memory: Experience[], item: Experience): Experience[] {
  return [...memory.filter((known) => known.regressionTest !== item.regressionTest), item];
}
