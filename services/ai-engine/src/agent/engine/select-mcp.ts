/**
 * Le sélecteur est un agent. Il choisit le serveur MCP dont le nom ressemble à la demande,
 * puis on exécute nous-mêmes les lectures qu'il a nommées.
 */
import { argsForTool, repoInText, type SourceTool } from '../../app-agents/ingest.ts';

export type SelectedRead = { tool: string; args: Record<string, unknown> };

export function selectorPrompt(demand: string, tools: SourceTool[]): string {
  const groups = new Map<string, SourceTool[]>();
  for (const tool of tools) {
    if (tool.write || !tool.id || tool.id.startsWith('app-')) continue;
    const id = tool.id.includes('__') ? tool.id.split('__')[0] : tool.id;
    const key = `${tool.serverName || id} · ${id}`;
    groups.set(key, [...(groups.get(key) ?? []), tool]);
  }
  const lines = [...groups.entries()].slice(0, 16).map(([label, list]) => {
    const tools = list.slice(0, 8).map((tool) => {
      const required = (tool.inputSchema?.required ?? []).join(', ') || 'aucun';
      return `${tool.id} (${required})`;
    }).join(' ; ');
    return `- ${label} : ${tools}`;
  });
  return [
    'Tu es le sélecteur. Tu es un agent.',
    'Tu choisis le serveur MCP dont le nom ressemble le plus au nom cité dans la demande, même s’il est approximatif.',
    'Tu ne choisis pas un serveur que la demande écarte.',
    'Tu n’inventes aucun identifiant d’outil. Au plus 3 outils en lecture.',
    'Si la demande contient un dépôt owner/repo, tu le recopies tel quel dans les arguments.',
    'Réponds uniquement par un JSON : {"reads":[{"tool":"identifiant","args":{}}]}',
    '',
    'Serveurs :',
    lines.join('\n') || '- aucun',
    '',
    `Demande : ${demand.slice(0, 1200)}`,
  ].join('\n');
}

function requiredMissing(tool: SourceTool, args: Record<string, unknown>): boolean {
  const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
  return required.some((key) => args[key] == null || args[key] === '');
}

/** Garde les lectures dont l'outil existe. Le dépôt écrit dans la demande remplace celui inventé. */
export function readsFromSelector(answer: string, tools: SourceTool[], demand: string): SelectedRead[] {
  const block = answer.match(/\{[\s\S]*\}/);
  if (!block) return [];
  let parsed: { reads?: Array<{ tool?: unknown; args?: unknown }> } = {};
  try { parsed = JSON.parse(block[0]); } catch { return []; }
  const known = new Map(tools.filter((tool) => !tool.write && tool.id).map((tool) => [tool.id, tool]));
  const repo = repoInText(demand);
  const out: SelectedRead[] = [];
  for (const read of Array.isArray(parsed.reads) ? parsed.reads : []) {
    const tool = known.get(String(read.tool ?? ''));
    if (!tool) continue;
    const given = read.args && typeof read.args === 'object' && !Array.isArray(read.args) ? read.args as Record<string, unknown> : {};
    const args = { ...(argsForTool(tool, demand) ?? {}), ...given };
    if (repo) {
      if ('owner' in args) args.owner = repo.owner;
      if ('repo' in args && args.repo !== repo.repo) args.repo = repo.repo;
      for (const key of Object.keys(args)) {
        if (/repo.?name|repository|full.?name/i.test(key)) args[key] = `${repo.owner}/${repo.repo}`;
      }
    }
    if (requiredMissing(tool, args)) continue;
    out.push({ tool: tool.id, args });
    if (out.length >= 3) break;
  }
  return out;
}
