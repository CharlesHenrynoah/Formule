/**
 * Étape de sourcing, avant tout développement.
 * Lecture déterministe : le dépôt vient de la page et de la demande, pas d'un essai du modèle.
 */
import { readsForCollections, type SourceTool } from '../../app-agents/ingest.ts';
import { routeDemand } from './pose.ts';

export type SourceRead = { tool: string; args: Record<string, unknown>; ok: boolean; error?: string; rows: Array<Record<string, unknown>> };
export type SourceOffer = { canBuild: boolean; text: string; brief: string };

function rowsOf(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data.filter((row) => row && typeof row === 'object').slice(0, 20) as Array<Record<string, unknown>>;
  if (data && typeof data === 'object') {
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (Array.isArray(value) && value[0] && typeof value[0] === 'object') return value.slice(0, 20) as Array<Record<string, unknown>>;
    }
  }
  return [];
}

function roleOf(key: string, value: unknown): 'date' | 'libellé' | 'nombre' | 'état' {
  if (/state|status/i.test(key)) return 'état';
  if (/date|created|published|updated|merged|closed/i.test(key) || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value))) return 'date';
  if (typeof value === 'number') return 'nombre';
  return 'libellé';
}

function fieldsOf(row: Record<string, unknown> | undefined): string {
  if (!row) return 'aucun champ observé';
  return Object.entries(row).slice(0, 8).map(([key, value]) => `${key} (${roleOf(key, value)})`).join(', ');
}

/** Texte montré à l'utilisateur, et le brief que le développement réutilise s'il valide. */
export function offerFromReads(prompt: string, reads: SourceRead[]): SourceOffer {
  const route = routeDemand(prompt);
  const lines = !route.data
    ? ['Aucune collection à lire pour cette demande.']
    : reads.length
    ? reads.map((read) => {
      const where = [read.args.owner, read.args.repo].filter(Boolean).join('/');
      if (!read.ok) return `${read.tool}${where ? ` sur ${where}` : ''} a échoué : ${read.error ?? 'lecture impossible'}.`;
      return `${read.tool}${where ? ` sur ${where}` : ''} : ${read.rows.length} ligne${read.rows.length > 1 ? 's' : ''}. Champs : ${fieldsOf(read.rows[0])}.`;
    })
    : ['Aucune lecture ne correspond à cette demande.'];
  const ready = !route.data || reads.some((read) => read.ok && read.rows.length > 0);
  const element = `Ce qui peut être généré : ${route.kind} « ${route.title} ».`;
  const text = [
    'Voici les données pour cette demande.',
    ...lines,
    ready ? element : 'Rien ne peut être généré tant qu’une lecture ne renvoie pas de lignes.',
  ].join('\n');
  const brief = [`Sourcing validé. ${element}`, ...lines, 'Respecte le rôle de chaque champ : une date reste une date, un libellé reste un libellé.'].join('\n');
  return { canBuild: ready, text, brief };
}

type Listed = { id: string; write?: boolean; ecriture?: boolean; schema?: unknown; inputSchema?: unknown };

/** Lit les outils imposés par la demande. N'appelle pas le modèle. */
export async function collectSource(prompt: string, page: string, list: () => Promise<Listed[]>, call: (tool: string, args: Record<string, unknown>) => Promise<unknown>): Promise<SourceOffer> {
  const route = routeDemand(prompt);
  if (!route.data) return offerFromReads(prompt, []);
  let reads: Array<{ tool: string; args: Record<string, unknown> }> = [];
  try {
    const listed = await list();
    const catalog: SourceTool[] = listed.filter((tool) => !(tool.write || tool.ecriture)).map((tool) => ({
      id: tool.id,
      name: tool.id.includes('__') ? tool.id.split('__').slice(1).join('__') : tool.id,
      write: false,
      inputSchema: (tool.schema ?? tool.inputSchema) as SourceTool['inputSchema'],
    }));
    reads = readsForCollections(route.collections, `${prompt}\n${page.slice(0, 2500)}`, catalog).slice(0, 3);
  } catch (error) {
    return offerFromReads(prompt, [{ tool: 'mcp', args: {}, ok: false, error: (error as Error).message, rows: [] }]);
  }
  const done: SourceRead[] = [];
  for (const read of reads) {
    try {
      const result = await call(read.tool, read.args);
      const rows = rowsOf(result);
      done.push({ ...read, ok: rows.length > 0, error: rows.length ? undefined : 'réponse vide', rows });
    } catch (error) {
      done.push({ ...read, ok: false, error: (error as Error).message, rows: [] });
    }
  }
  return offerFromReads(prompt, done);
}
