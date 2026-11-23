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

function norm(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function labelsOn(page: string): string[] {
  const labels: string[] = [];
  for (const match of page.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)) {
    const text = match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text) labels.push(text);
  }
  for (const match of page.matchAll(/\blabel=["']([^"']+)["']/gi)) labels.push(match[1]);
  return labels;
}

/** Titre déjà affiché sur la page, pour n'importe quel projet. Un mot trop court ne bloque pas une autre vue. */
export function presentLabel(prompt: string, page: string): string | null {
  if (!page.trim()) return null;
  const route = routeDemand(prompt);
  const quoted = [...prompt.matchAll(/[«"]([^»"]{2,80})[»"]/g)].map((match) => match[1].trim());
  const names = [...quoted, route.title].filter(Boolean);
  for (const label of labelsOn(page)) {
    const shown = norm(label);
    if (shown.length < 4) continue;
    for (const name of names) {
      const asked = norm(name);
      const words = asked.split(' ').filter(Boolean);
      if (asked.length < 4) continue;
      if (shown === asked || (words.length >= 2 && shown.includes(asked))) return label.replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

/** Texte montré à l'utilisateur, et le brief que le développement réutilise s'il valide. */
export function offerFromReads(prompt: string, reads: SourceRead[], page = ''): SourceOffer {
  const present = presentLabel(prompt, page);
  if (present) {
    const text = `Cet élément est déjà présent sur l'interface : « ${present} ».\nRien de nouveau ne sera généré.`;
    return { canBuild: false, text, brief: text };
  }
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
  if (presentLabel(prompt, page)) return offerFromReads(prompt, [], page);
  if (!route.data) return offerFromReads(prompt, [], page);
  let reads: Array<{ tool: string; args: Record<string, unknown> }> = [];
  try {
    const listed = await list();
    const catalog: SourceTool[] = listed.filter((tool) => !(tool.write || tool.ecriture)).map((tool) => ({
      id: tool.id,
      name: tool.id.includes('__') ? tool.id.split('__').slice(1).join('__') : tool.id,
      write: false,
      inputSchema: (tool.schema ?? tool.inputSchema) as SourceTool['inputSchema'],
    }));
    reads = readsForCollections(route.collections, `${prompt}\n${page}`, catalog).slice(0, 3);
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
  return offerFromReads(prompt, done, page);
}
