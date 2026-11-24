/** Journal d'une génération : lignes déjà captees, prêtes à stocker. */

export type GenLog = { at: string; component: string; step: string; level: 'info' | 'ok' | 'error'; text: string };

const clip = (value: unknown, max = 240) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

export function asLog(event: Record<string, unknown>): GenLog | null {
  if (event.type !== 'log' || typeof event.component !== 'string' || typeof event.step !== 'string') return null;
  const level = event.level === 'ok' || event.level === 'error' ? event.level : 'info';
  return {
    at: typeof event.at === 'string' ? event.at : new Date().toISOString(),
    component: event.component.slice(0, 40),
    step: event.step.slice(0, 60),
    level,
    text: clip(event.text),
  };
}

export function localLog(component: string, step: string, text: string, level: GenLog['level'] = 'info'): GenLog {
  return { at: new Date().toISOString(), component: component.slice(0, 40), step: step.slice(0, 60), level, text: clip(text) };
}
