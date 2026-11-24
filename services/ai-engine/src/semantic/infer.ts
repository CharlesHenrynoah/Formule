import { createHash } from 'node:crypto';
import type { DataContract, DataField, SemanticRole } from '../../../../packages/contracts/src/types.ts';

function valueType(value: unknown): string {
  if (value == null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Le rôle vient de la forme de la valeur. Un nom seul ne décide pas. */
export function roleOfValue(path: string, value: unknown): SemanticRole {
  if (path === 'id' || path.endsWith('.id')) return 'identifier';
  if (typeof value === 'number' && value > 1e11) return 'timestamp';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return 'timestamp';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return 'timestamp';
  if (typeof value === 'number') return 'measure';
  if (typeof value === 'boolean') return 'status';
  if (value && typeof value === 'object') return 'relation';
  return 'text';
}

export function inferContract(input: {
  server: string;
  tool: string;
  args?: Record<string, unknown>;
  rawRef: string;
  entity: string;
  rows: Array<Record<string, unknown>>;
  fetchedAt?: string;
}): DataContract {
  const sample = input.rows[0] ?? {};
  const fields: DataField[] = Object.entries(sample).slice(0, 24).map(([path, value]) => {
    const role = roleOfValue(path, value);
    return {
      path,
      type: valueType(value),
      role,
      entity: input.entity,
      nullable: input.rows.some((row) => row[path] == null),
      aggregation: role === 'measure' ? 'none' : role === 'timestamp' ? 'last' : 'none',
    };
  });
  const observed = fields.find((field) => field.role === 'timestamp');
  const id = createHash('sha256').update(`${input.tool}\n${fields.map((field) => field.path).join(',')}`).digest('hex').slice(0, 16);
  return {
    id,
    version: 1,
    source: { server: input.server, tool: input.tool, args: input.args ?? {}, rawRef: input.rawRef },
    fields,
    temporal: { fetchedAt: input.fetchedAt ?? new Date(0).toISOString(), observedAtPath: observed?.path },
  };
}
