import type { DataContract } from '../../../../packages/contracts/src/types.ts';

/** Copie les champs du contrat. Aucune agrégation si le contrat dit `none`. */
export function projectRows(rows: Array<Record<string, unknown>>, contract: DataContract): Array<Record<string, unknown>> {
  const fields = contract.fields.filter((field) => field.aggregation === 'none' || field.aggregation === 'last' || field.aggregation == null);
  return rows.map((row) => {
    const next: Record<string, unknown> = {};
    for (const field of fields) if (field.path in row) next[field.path] = row[field.path];
    return next;
  });
}
