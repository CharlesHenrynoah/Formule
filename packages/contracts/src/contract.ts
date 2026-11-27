import type { FieldType } from './values.js';
import { parseTime } from './values.js';

export type FieldRole = 'identifier' | 'measure' | 'dimension' | 'time' | 'state' | 'text' | 'relation';

export interface FieldContract {
  path: string;
  type: FieldType;
  nullable: boolean;
  role: FieldRole;
  unit: string | null;
  units?: string[];           // plusieurs unités observées → pas de fusion implicite
  domain?: (string | number)[];
  cardinality: 'one' | 'many';
  granularity?: string;
  provenance: { envelopeId: string; serverId: string; tool: string };
}

export interface CollectionContract { path: string; count: number }

export interface DataContract {
  version: number;
  envelopeId: string;
  fields: FieldContract[];
  collections: CollectionContract[];
}

const UNIT_SUFFIX: Record<string, string> = { eur: 'EUR', usd: 'USD', gbp: 'GBP', chf: 'CHF', jpy: 'JPY', pct: '%', ms: 'ms', kwh: 'kWh', km: 'km', kg: 'kg' };
const UNIT_KEYS = ['unit', 'unite', 'unité', 'devise', 'currency'];
const VALUE_KEYS = ['value', 'valeur', 'amount', 'montant'];
const PRICE_KEYS = ['prix', 'price', 'cours', 'close', 'cloture'];

function scalarType(v: unknown): FieldType | null {
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return parseTime(v) !== null ? 'time' : 'string';
  return null;
}

function roleFor(key: string, type: FieldType): FieldRole {
  const k = key.toLowerCase();
  if (k === 'id' || k.endsWith('_id') || k.endsWith('id') && k.length <= 4) return 'identifier';
  if (type === 'time') return 'time';
  if (type === 'number') return 'measure';
  if (['statut', 'status', 'etat', 'état', 'state'].includes(k)) return 'state';
  if (type === 'string') return k.length < 20 && ['nom', 'name', 'secteur', 'type', 'categorie', 'site', 'sens'].includes(k) ? 'dimension' : 'text';
  return 'text';
}

function unitFromKey(key: string): string | null {
  const m = key.toLowerCase().match(/_(eur|usd|gbp|chf|jpy|pct|ms|kwh|km|kg)$/);
  return m ? UNIT_SUFFIX[m[1]] : null;
}

/**
 * Inférence de contrat à partir d'un brut quelconque (objets imbriqués compris).
 * Ne convertit jamais : date→mesure, texte→nombre, mesure→comptage.
 */
export function inferContract(raw: unknown, prov: { envelopeId: string; serverId: string; tool: string }): DataContract {
  const fields = new Map<string, FieldContract>();
  const collections: CollectionContract[] = [];

  const add = (path: string, type: FieldType, key: string, many: boolean, value: unknown, unit: string | null) => {
    const cur = fields.get(path);
    if (!cur) {
      fields.set(path, {
        path, type, nullable: value === null, role: roleFor(key, type), unit,
        units: unit ? [unit] : [], cardinality: many ? 'many' : 'one', provenance: prov,
      });
      return;
    }
    if (value === null) cur.nullable = true;
    if (unit && !cur.units!.includes(unit)) { cur.units!.push(unit); cur.unit = cur.units!.length > 1 ? null : unit; }
    if (cur.type !== type && type) cur.type = cur.type === 'number' || type === 'number' ? cur.type : 'string';
  };

  const walk = (node: unknown, prefix: string, many: boolean, inheritedUnit: string | null) => {
    if (Array.isArray(node)) {
      const p = prefix + '[]';
      collections.push({ path: p, count: node.length });
      for (const item of node) walk(item, p, true, inheritedUnit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const localUnitKey = UNIT_KEYS.find((k) => typeof obj[k] === 'string');
    const localUnit = localUnitKey ? (obj[localUnitKey] as string) : null;
    for (const [key, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (v === null) { add(path, fields.get(path)?.type ?? 'string', key, many, null, null); continue; }
      if (Array.isArray(v) || typeof v === 'object') { walk(v, path, many, localUnit ?? inheritedUnit); continue; }
      const t = scalarType(v)!;
      let unit: string | null = null;
      if (t === 'number') {
        unit = unitFromKey(key);
        if (!unit && VALUE_KEYS.includes(key)) unit = localUnit;
        if (!unit && PRICE_KEYS.includes(key)) unit = localUnit ?? inheritedUnit;
      }
      add(path, t, key, many, v, unit);
    }
  };
  walk(raw, '', false, null);
  // dédoublonne les collections (comptes cumulés)
  const coll = new Map<string, number>();
  for (const c of collections) coll.set(c.path, (coll.get(c.path) ?? 0) + c.count);
  return {
    version: 1,
    envelopeId: prov.envelopeId,
    fields: [...fields.values()],
    collections: [...coll.entries()].map(([path, count]) => ({ path, count })),
  };
}

export function findField(c: DataContract, path: string): FieldContract | undefined {
  return c.fields.find((f) => f.path === path);
}

/** Champs d'une collection, relatifs à celle-ci. */
export function collectionFields(c: DataContract, collPath: string): (FieldContract & { rel: string })[] {
  const pre = collPath.endsWith('[]') ? collPath + '.' : collPath + '[].';
  return c.fields.filter((f) => f.path.startsWith(pre) && !f.path.slice(pre.length).includes('[]'))
    .map((f) => ({ ...f, rel: f.path.slice(pre.length) }));
}
