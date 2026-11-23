export type AgentRole = 'data' | 'po' | 'dev';
export const ROLE_LABEL: Record<AgentRole, string> = { data: 'Data Engineer', po: 'Product Owner', dev: 'Développeur' };

export type AgentEvent =
  | { type: 'agent'; kind: 'role'; role: AgentRole; label: string; iteration?: number }
  | { type: 'agent'; kind: 'tool'; role: AgentRole; id: string; tool: string; args: unknown }
  | { type: 'agent'; kind: 'tool_result'; role: AgentRole; id: string; tool: string; ok: boolean; summary: string; ms?: number }
  | { type: 'agent'; kind: 'cli'; role: AgentRole; command: string; ok: boolean; output: string; ms: number }
  | { type: 'agent'; kind: 'file'; role: AgentRole; path: string; bytes: number; lines: number; op: 'write' | 'read' | 'edit'; changed?: number }
  | { type: 'agent'; kind: 'build'; role: AgentRole; ok: boolean; ms: number; bytes?: number; output: string }
  | { type: 'agent'; kind: 'brief'; role: 'data'; text: string; relevant: boolean }
  | { type: 'agent'; kind: 'spec'; role: 'po'; text: string; components: string[] }
  | { type: 'agent'; kind: 'review'; role: 'po'; iteration: number; verdict: 'ok' | 'a_corriger'; criteria: Array<{ id: string; ok: boolean; note?: string }>; remarks: string[] }
  | { type: 'agent'; kind: 'message'; role: AgentRole; text: string }
  | { type: 'agent'; kind: 'contract'; role: 'po'; contract: unknown; ok: boolean; error?: string }
  | { type: 'agent'; kind: 'backend_test'; role: AgentRole; ok: boolean; problems: string[]; tools: string[]; smoke: Array<{ tool: string; ok: boolean; error?: string }> }
  | { type: 'agent'; kind: 'app_agent'; role: 'po'; agent: unknown }
  | { type: 'agent'; kind: 'memory'; role: AgentRole; mode: 'incrémental' | 'complet'; version?: number; text: string }
  | { type: 'agent'; kind: 'summary'; framework: string; ms: number; iterations: number; files: string[]; components: string[]; cliCalls: number; builds: number; mode?: 'incrémental' | 'complet'; memoryVersion?: number; filesChanged?: string[]; toolCalls?: number; metrics?: Record<string, number> }
  | { type: 'agent'; kind: 'kanban'; role: AgentRole; todo: string[]; doing: string[]; done: string[]; wip: number; limit: number; maxWip: number; doneCount: number; leadMs: number; cycleMs: number };

export type AgentResultExtra = {
  brief: string;
  spec: string;
  files: Record<string, string>;
  components: string[];
  workspace: string;
  iterations: number;
  reviews: Array<{ iteration: number; verdict: string; remarks: string[] }>;
  framework: string;
};

/** Déduit un schéma (champs, types, exemples) d'un échantillon JSON. */
export function inferSchema(value: unknown, path = '', out: Array<{ champ: string; type: string; exemple: string }> = [], depth = 0) {
  if (depth > 3 || out.length > 40) return out;
  const t = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  if (path) out.push({ champ: path, type: t === 'array' ? `array(${(value as unknown[]).length})` : t, exemple: t === 'object' || t === 'array' ? '' : JSON.stringify(value).slice(0, 40) });
  if (t === 'object') for (const [k, v] of Object.entries(value as object)) inferSchema(v, path ? `${path}.${k}` : k, out, depth + 1);
  if (t === 'array' && (value as unknown[]).length) inferSchema((value as unknown[])[0], `${path}[]`, out, depth + 1);
  return out;
}

/** Extrait la liste de composants de la section « Composants shadcn » d'une spec. */
export function componentsFromSpec(spec: string, allowed: string[]): string[] {
  const sec = /##\s*Composants[^\n]*\n([\s\S]*?)(?:\n##\s|$)/i.exec(spec)?.[1] ?? '';
  const words = sec.toLowerCase().match(/[a-z][a-z-]+/g) ?? [];
  return [...new Set(words.filter((w) => allowed.includes(w)))];
}

export const importsOf = (code: string) =>
  [...new Set([...code.matchAll(/from\s+['"]@\/components\/ui\/([\w-]+)['"]/g)].map((m) => m[1]))];

export type Dataset = { name: string; rows: Array<Record<string, unknown>> };
/** Profil des données personnelles importées (CSV/JSON) : schéma, volumes, statistiques, échantillon. */
export function profileDatasets(datasets: Dataset[] = []) {
  if (!datasets.length) return '';
  const parts = datasets.map((d) => {
    const keys = [...new Set(d.rows.slice(0, 200).flatMap((r) => Object.keys(r)))].slice(0, 30);
    const lines = keys.map((k) => {
      const vals = d.rows.map((r) => r[k]).filter((v) => v !== undefined && v !== null && v !== '');
      const nums = vals.map((v) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+([.,]\d+)?$/.test(v.trim()) ? Number(v.replace(',', '.')) : NaN)).filter((n) => !isNaN(n));
      const isNum = nums.length >= vals.length * 0.8 && vals.length > 0;
      const isDate = !isNum && vals.slice(0, 20).every((v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v));
      const distinct = [...new Set(vals.map(String))];
      const info = isNum ? `min ${Math.min(...nums)} · max ${Math.max(...nums)} · moyenne ${Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100}`
        : isDate ? `du ${distinct.sort()[0]?.slice(0, 10)} au ${distinct.sort().at(-1)?.slice(0, 10)}`
        : distinct.length <= 12 ? `valeurs : ${distinct.slice(0, 12).join(', ')}` : `${distinct.length} valeurs distinctes, ex. ${JSON.stringify(distinct[0]).slice(0, 40)}`;
      return `| ${k} | ${isNum ? 'number' : isDate ? 'date' : 'string'} | ${vals.length}/${d.rows.length} | ${info.replace(/\|/g, '/')} |`;
    });
    return `### Collection \`${d.name}\` (${d.rows.length} lignes, déjà chargée dans la base de l'app : db.list('${d.name}'))
| champ | type | renseigné | profil |
|---|---|---|---|
${lines.join('\n')}
Échantillon : ${JSON.stringify(d.rows.slice(0, 2)).slice(0, 600)}`;
  });
  return `## Données personnelles importées (profil)\n${parts.join('\n\n')}\nLes nombres importés depuis un CSV sont des chaînes : convertir avec Number() dans les handlers.`;
}
