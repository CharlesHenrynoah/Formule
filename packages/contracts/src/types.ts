/** Contrat partagé par le backend et le frontend. Le nom d'un champ ne suffit pas à lui donner un rôle. */

export type SemanticRole =
  | 'identifier'
  | 'measure'
  | 'dimension'
  | 'timestamp'
  | 'status'
  | 'relation'
  | 'text';

export interface DataField {
  path: string;
  type: string;
  role: SemanticRole;
  entity: string;
  unit?: string;
  nullable: boolean;
  aggregation?: 'sum' | 'avg' | 'count' | 'last' | 'none';
}

export interface DataContract {
  id: string;
  version: number;
  source: {
    server: string;
    tool: string;
    args: Record<string, unknown>;
    rawRef: string;
  };
  fields: DataField[];
  temporal: {
    fetchedAt: string;
    observedAtPath?: string;
    maxAgeMs?: number;
  };
}
