/**
 * États de valeur — distincts de la valeur elle-même.
 * Zéro observé = disponible. null/absent = manquante. Texte numérique ≠ nombre (invalide).
 */
export type ValueState = 'available' | 'missing' | 'invalid' | 'partial' | 'stale' | 'inaccessible';
export type DatasetState = 'initial' | 'loading' | 'ready' | 'empty' | 'partial' | 'stale' | 'error' | 'unavailable';
export type FieldType = 'number' | 'string' | 'boolean' | 'time' | 'object' | 'array';

export interface ReadValue<T = unknown> { state: ValueState; value: T | null; reason?: string }

/** Lecture par chemin : "a.b", "items[].prix.valeur" (le [] désigne une collection). */
export function getPath(obj: unknown, path: string): unknown {
  if (path === '' || path === '$') return obj;
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    const key = seg.endsWith('[]') ? seg.slice(0, -2) : seg;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Éléments d'une collection : "x.y[]" ou "x.y" ; les collections imbriquées sont aplaties
 * ("results[].result.entries" = toutes les entrées de tous les résultats).
 */
export function getCollection(obj: unknown, path: string): unknown[] | undefined {
  const parts = path.replace(/\[\]$/, '').split('[].');
  let cur: unknown[] = [obj];
  for (let i = 0; i < parts.length; i++) {
    const next: unknown[] = [];
    let found = false;
    for (const o of cur) {
      const v = getPath(o, parts[i]);
      if (Array.isArray(v)) { found = true; next.push(...v); }
    }
    if (!found) return undefined;
    cur = next;
  }
  return cur;
}

export function parseTime(v: unknown): number | null {
  if (typeof v === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null; // pas de conversion implicite nombre→date
}

export function classifyValue(raw: unknown, type: FieldType): ReadValue {
  if (raw === undefined) return { state: 'missing', value: null, reason: 'champ absent' };
  if (raw === null) return { state: 'missing', value: null, reason: 'valeur nulle' };
  switch (type) {
    case 'number':
      if (typeof raw === 'number') return Number.isFinite(raw) ? { state: 'available', value: raw } : { state: 'invalid', value: null, reason: 'nombre non fini' };
      return { state: 'invalid', value: null, reason: `type ${typeof raw} au lieu de nombre` };
    case 'time': {
      const t = parseTime(raw);
      return t === null ? { state: 'invalid', value: null, reason: 'date invalide' } : { state: 'available', value: raw };
    }
    case 'string': return typeof raw === 'string' ? { state: 'available', value: raw } : { state: 'invalid', value: null, reason: 'type inattendu' };
    case 'boolean': return typeof raw === 'boolean' ? { state: 'available', value: raw } : { state: 'invalid', value: null, reason: 'type inattendu' };
    default: return { state: 'available', value: raw };
  }
}

export function datasetState(rows: unknown[] | undefined, opts: { partial?: boolean; stale?: boolean; error?: boolean } = {}): DatasetState {
  if (opts.error && !rows) return 'error';
  if (rows === undefined) return 'unavailable';
  if (opts.stale) return 'stale';
  if (rows.length === 0) return 'empty';
  if (opts.partial) return 'partial';
  return 'ready';
}

export const VALUE_STATE_LABEL: Record<ValueState, string> = {
  available: 'disponible', missing: 'manquante', invalid: 'invalide',
  partial: 'partielle', stale: 'obsolète', inaccessible: 'inaccessible',
};
