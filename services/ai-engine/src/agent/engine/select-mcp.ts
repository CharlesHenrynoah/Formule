/**
 * Le sélecteur est un agent. Il choisit le serveur MCP adapté à l'intention,
 * puis on exécute nous-mêmes les lectures qu'il a nommées.
 */
import { argsForTool, repoInText, valueFits, type SourceTool } from '../../app-agents/ingest.ts';

export type SelectedRead = { tool: string; args: Record<string, unknown> };

function intentHint(demand: string): string {
  const text = demand.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const hints = [
    'Chaque serveur est un moteur interchangeable. L’app est le véhicule : elle se monte sur un moteur, elle n’est pas écrite pour une marque.',
    'Choisis le moteur dont le nom, la description ou les outils couvrent la demande. S’il en nomme un, c’est celui-là.',
  ];
  if (/doc|documentation|wiki|swagger|openapi/.test(text) && !/prix|price|volume|execute/.test(text)) {
    hints.push('La demande veut de la documentation : un outil read / search_docs peut suffire.');
  } else if (/prix|price|volume|courbe|kpi|dashboard|tableau|liste|top\s*\d+/.test(text)) {
    hints.push('La demande veut des mesures ou une liste : un outil qui renvoie des données (list, get, markets, execute). Une doc seule ne suffit pas.');
  }
  return hints.join('\n');
}

export function selectorPrompt(demand: string, tools: SourceTool[]): string {
  const groups = new Map<string, SourceTool[]>();
  for (const tool of tools) {
    if (tool.write || !tool.id || tool.id.startsWith('app-')) continue;
    const id = tool.id.includes('__') ? tool.id.split('__')[0] : tool.id;
    const key = `${tool.serverName || id} · ${id}`;
    groups.set(key, [...(groups.get(key) ?? []), tool]);
  }
  const lines = [...groups.entries()].slice(0, 20).map(([label, list]) => {
    const toolsLine = list.slice(0, 10).map((tool) => {
      const required = (tool.inputSchema?.required ?? []).join(', ') || 'aucun';
      const blurb = (tool.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);
      return blurb ? `${tool.id} (${required}) — ${blurb}` : `${tool.id} (${required})`;
    }).join('\n    ');
    return `- ${label} :\n    ${toolsLine}`;
  });
  return [
    'Tu es le Sélecteur. Tu choisis le moteur MCP sur lequel monter le véhicule.',
    'Tu raisonnes sur l’intention (ce qu’il faut afficher) et sur les moteurs réellement branchés, pas sur une marque par défaut.',
    'Règles :',
    '1. Un moteur = un serveur. Tu compares son nom, son serverName et la description de ses outils à la demande.',
    '2. Si la demande nomme un moteur, même approximativement, tu le privilégies.',
    '3. Tu ne choisis jamais un moteur que la demande écarte.',
    '4. Sans exclusion explicite : le moteur de démo ne sert que si aucun autre moteur ne couvre la demande.',
    '5. Si la demande veut des mesures et qu’un outil execute (paramètre code) existe : search_docs seul ne suffit pas, il faut l’outil qui renvoie les données.',
    '6. Tu n’inventes aucun identifiant. Au plus 3 outils en lecture, de préférence sur le même moteur.',
    '7. Un identifiant présent dans la demande (dépôt, ville, id) est recopié tel quel dans les arguments.',
    '8. Remplis les args requis avec des valeurs tirées de la demande ; sinon laisse args à {}.',
    '9. Tu ne transmets jamais de code. Un outil execute se nomme avec args vide : le moteur d’exécution écrira le script.',
    'Réponds uniquement par un JSON : {"reads":[{"tool":"identifiant","args":{}}],"why":"une phrase"}',
    '',
    intentHint(demand),
    '',
    'Serveurs disponibles :',
    lines.join('\n') || '- aucun',
    '',
    `Demande : ${demand.slice(0, 1400)}`,
  ].join('\n');
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
    const needsCode = (tool.inputSchema?.required ?? []).includes('code');
    if (needsCode) delete args.code;
    if (repo) {
      if ('owner' in args) args.owner = repo.owner;
      if ('repo' in args && args.repo !== repo.repo) args.repo = repo.repo;
      for (const key of Object.keys(args)) {
        if (/repo.?name|repository|full.?name/i.test(key)) args[key] = `${repo.owner}/${repo.repo}`;
      }
    }
    const required = (tool.inputSchema?.required ?? []).filter((key) => !(needsCode && key === 'code'));
    if (required.some((key) => args[key] == null || args[key] === '')) continue;
    const props = tool.inputSchema?.properties ?? {};
    if (Object.entries(args).some(([key, value]) => props[key] && !valueFits(value, props[key]))) continue;
    out.push({ tool: tool.id, args });
    if (out.length >= 3) break;
  }
  return out;
}
