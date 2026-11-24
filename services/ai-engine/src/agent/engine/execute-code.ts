/**
 * Génération / réparation de code pour tout MCP « execute + code ».
 * Deux formes, quel que soit le fournisseur :
 * - hybride : methode('chemin', { options })
 * - objet   : methode({ options })
 * L'exemple renvoyé par la doc gagne. Le diagnostic (nombre d'arguments, type string, Params) départage le reste.
 */
import type { SourceTool } from '../../app-agents/ingest.ts';

export type DocHint = {
  method?: string;
  endpoint?: string;
  summary?: string;
  description?: string;
  params?: string;
  example?: string;
};

export type CallShape = 'object' | 'hybrid' | 'unknown';
export type ShapeErrorKind = 'want_string_first' | 'want_object' | 'want_more_args' | 'bad_property' | 'other';

function serverOf(id: string): string {
  return id.includes('__') ? id.split('__')[0] : '';
}

export function mcpMetaNames(tools: SourceTool[], server: string): string[] {
  return tools
    .filter((tool) => serverOf(tool.id) === server)
    .map((tool) => tool.name || (tool.id.includes('__') ? tool.id.split('__').slice(1).join('__') : tool.id))
    .filter(Boolean);
}

export function paramsList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(/[\n,]/).map((part) => part.trim()).filter(Boolean);
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>).map(([key, value]) => `${key}: ${String(value)}`);
  }
  return [];
}

type ParamField = { key: string; type: string; optional: boolean };

export function parseParamFields(params: string[]): ParamField[] {
  const out: ParamField[] = [];
  for (const line of params) {
    const match = line.match(/^([A-Za-z_][\w]*)\s*(\?)?\s*:\s*(.+?);?\s*$/);
    if (!match) continue;
    out.push({ key: match[1], optional: match[2] === '?' || /\?/.test(line.split(':')[0] ?? ''), type: match[3].trim() });
  }
  return out;
}

function sampleValue(key: string, type: string): string {
  const t = type.toLowerCase();
  if (/currency|vs_/.test(key)) return "'eur'";
  if (/^days$|day/.test(key)) return "'30'";
  if (/id|coin|slug|repo|owner|name/.test(key)) return "'…'";
  if (/query|search|^q$/.test(key)) return "'…'";
  if (/^boolean/.test(t)) return /market_data|sparkline|localization|include_/.test(key) ? 'true' : 'false';
  if (/^number/.test(t)) return /page|per_page|limit/.test(key) ? '10' : '0';
  if (/\|/.test(t)) {
    const lit = t.match(/'([^']+)'/);
    return lit ? `'${lit[1]}'` : "'…'";
  }
  return "'…'";
}

/** Paramètre de chemin : placeholder d'endpoint, ou identifiant en tête. Le domaine ne compte pas. */
export function isPathKey(key: string): boolean {
  return /Id$/.test(key) || /(?:^|_)(id|slug|name|key|owner|repo|ref|sha|address|symbol|username|user|org|organization|project|workspace|path|uuid)$/i.test(key);
}

export function pathKeys(params: string[], endpoint = ''): string[] {
  const fromEndpoint = [...String(endpoint).matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!).filter(Boolean);
  if (fromEndpoint.length) return fromEndpoint;
  const fields = parseParamFields(params);
  const first = fields[0];
  if (first && !first.optional && /^string/.test(first.type) && isPathKey(first.key)) return [first.key];
  return [];
}

/** Chemin positionnel + objet d'options, ou un seul objet si aucun chemin n'est déclaré. */
export function inferCallShape(params: string[], endpoint = ''): CallShape {
  const fields = parseParamFields(params);
  if (!fields.length && !pathKeys(params, endpoint).length) return 'unknown';
  if (pathKeys(params, endpoint).length) return 'hybrid';
  return 'object';
}

/** L’exemple du fournisseur prime sur l’inférence : `get('id', { … })` ou `get({ … })`. */
export function shapeFromExample(example: string): CallShape | null {
  const compact = example.replace(/\s+/g, ' ');
  if (/\(\s*['"`][^'"`]+['"`]\s*,\s*\{/.test(compact)) return 'hybrid';
  if (/\(\s*\{/.test(compact)) return 'object';
  return null;
}

export function sdkCallLine(example: unknown): string {
  const line = String(example ?? '').split('\n').map((item) => item.trim()).find((item) => /await\s+[\w.]+\(/.test(item));
  return line ? line.replace(/\s+/g, ' ').replace(/;\s*$/, '').slice(0, 240) : '';
}

export function objectCallExample(method: string, params: string[]): string {
  if (!method) return '';
  const fields = parseParamFields(params);
  if (!fields.length) return `await ${method}({})`;
  const entries = fields.slice(0, 8).map((field) => `${field.key}: ${sampleValue(field.key, field.type)}`);
  return `await ${method}({ ${entries.join(', ')} })`;
}

/** Forme hybride : un argument string par paramètre de chemin, puis l'objet des options. */
export function hybridCallExample(method: string, params: string[], endpoint = ''): string {
  const fields = parseParamFields(params);
  const names = pathKeys(params, endpoint);
  const pathFields = names.map((name) => fields.find((field) => field.key === name) ?? { key: name, type: 'string', optional: false });
  const rest = fields.filter((field) => !names.includes(field.key));
  if (!pathFields.length) return objectCallExample(method, params);
  const positional = pathFields.map((field) => sampleValue(field.key, field.type)).join(', ');
  if (!rest.length) return `await ${method}(${positional})`;
  const entries = rest.slice(0, 7).map((field) => `${field.key}: ${sampleValue(field.key, field.type)}`);
  return `await ${method}(${positional}, { ${entries.join(', ')} })`;
}

export function dualCallExamples(method: string, params: string[], endpoint = ''): string {
  const shape = inferCallShape(params, endpoint);
  const object = objectCallExample(method, params);
  const hybrid = hybridCallExample(method, params, endpoint);
  if (shape === 'hybrid') return `préféré → ${hybrid} | alternative → ${object}`;
  return `préféré → ${object} | alternative → ${hybrid}`;
}

export function sdkHintsFromDocs(rows: Array<Record<string, unknown>>): DocHint[] {
  const out: DocHint[] = [];
  for (const row of rows) {
    const method = String(row.method ?? row.name ?? row.path ?? '').trim();
    const endpoint = String(row.endpoint ?? row.url ?? '').trim();
    const summary = String(row.summary ?? row.title ?? '').trim();
    const description = String(row.description ?? row.texte ?? '').trim();
    const list = paramsList(row.params ?? row.parameters);
    if (!method && !endpoint && !summary) continue;
    const sdk = sdkCallLine(row.example);
    const shape = shapeFromExample(sdk) ?? (method ? inferCallShape(list, endpoint) : 'unknown');
    const generated = method
      ? (shape === 'hybrid'
        ? `préféré → ${hybridCallExample(method, list, endpoint)} | alternative → ${objectCallExample(method, list)}`
        : dualCallExamples(method, list, endpoint))
      : '';
    out.push({
      method: method || undefined,
      endpoint: endpoint || undefined,
      summary: summary || undefined,
      description: description.slice(0, 200) || undefined,
      params: list.length ? list.join(' | ').slice(0, 400) : undefined,
      example: [sdk ? `exemple SDK → ${sdk}` : '', generated].filter(Boolean).join(' | ') || undefined,
    });
    if (out.length >= 12) break;
  }
  return out;
}

export function stripCodeFence(raw: string): string {
  return raw.replace(/^```(?:js|javascript|ts|typescript)?\n?/i, '').replace(/\n?```$/i, '').trim();
}

export function ensureRunClient(code: string): string {
  const trimmed = code.trim();
  if (/async\s+function\s+run\s*\(/.test(trimmed)) return trimmed;
  if (/function\s+run\s*\(/.test(trimmed)) return trimmed.replace(/function\s+run\s*\(/, 'async function run(');
  if (/^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/.test(trimmed) || /=>\s*\{/.test(trimmed)) {
    return `async function run(client) {\n${trimmed}\n}`;
  }
  return [
    'async function run(client) {',
    trimmed.split('\n').map((line) => (line ? `  ${line}` : '')).join('\n'),
    '}',
  ].join('\n');
}

/** Classe le diagnostic TS comme github-robust classe les 422. */
export function classifyShapeError(error: string): ShapeErrorKind {
  if (/Did you mean/i.test(error) || /Property '.+' does not exist/i.test(error)) return 'bad_property';
  if (/not assignable to parameter of type 'string'/i.test(error)) return 'want_string_first';
  if (/Expected \d+-\d+ arguments|Expected \d+ arguments, but got 1/i.test(error)) return 'want_more_args';
  if (/no properties in common with type \w*Params/i.test(error) || /not assignable to parameter of type '\w*Params'/i.test(error)) {
    return 'want_object';
  }
  if (/TypeScript diagnostics|Params/i.test(error)) return 'want_object';
  return 'other';
}

type StringProp = { key: string; value: string };

/** Propriétés string d'un objet littéral, dans l'ordre écrit. */
function stringProps(source: string): StringProp[] | null {
  const trimmed = source.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  const body = trimmed.slice(1, -1);
  const props: StringProp[] = [];
  const re = /(?:^|,)\s*([A-Za-z_][\w]*)\s*:\s*(['"`])([^'"`]*)\2/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) props.push({ key: match[1]!, value: match[3]! });
  return props;
}

/** « Expected 2-3 arguments, but got 1 » → sortir 1 paramètre de chemin. Le dernier argument reste l'objet. */
function liftCount(error: string): number {
  const match = error.match(/Expected\s+(\d+)(?:\s*-\s*\d+)?\s+arguments?,\s+but\s+got\s+(\d+)/i);
  if (!match) return 1;
  return Math.max(1, Number(match[1]) - Number(match[2]));
}

function liftCall(path: string, obj: string, count: number): string | null {
  const props = stringProps(obj);
  if (!props?.length) return null;
  const preferred = props.filter((prop) => isPathKey(prop.key));
  const chosen = (preferred.length ? preferred : props).slice(0, count);
  if (!chosen.length) return null;
  let body = obj.trim().slice(1, -1);
  for (const prop of chosen) {
    const quoted = prop.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    body = body.replace(new RegExp(`(?:^|,)\\s*${prop.key}\\s*:\\s*(['"\`])${quoted}\\1\\s*,?`), ',');
  }
  body = body.replace(/^[\s,]+/, '').replace(/[\s,]+$/, '').replace(/,\s*,/g, ',').trim();
  const args = chosen.map((prop) => `'${prop.value}'`).join(', ');
  return body ? `${path}(${args}, { ${body} })` : `${path}(${args})`;
}

/**
 * Réécriture déterministe des appels (pattern githubFallbackAfterError).
 * Retourne null si rien n’a changé.
 */
export function rewriteCallsFromDiagnostics(code: string, error: string): string | null {
  const kind = classifyShapeError(error);
  let next = code;
  let changed = false;

  if (kind === 'bad_property') {
    for (const match of error.matchAll(/Property '([^']+)' does not exist[\s\S]*?Did you mean '([^']+)'/gi)) {
      const bad = match[1];
      const good = match[2];
      if (!bad || !good || bad === good) continue;
      const re = new RegExp(`\\b${bad}\\b`, 'g');
      if (re.test(next)) {
        next = next.replace(re, good);
        changed = true;
      }
    }
  }

  if (kind === 'want_string_first' || kind === 'want_more_args') {
    const count = liftCount(error);
    next = next.replace(
      /(\.\w+(?:\.\w+)*)\(\s*(\{[\s\S]*?\})\s*\)/g,
      (full, path: string, obj: string) => {
        const lifted = liftCall(path, obj, count);
        if (!lifted || lifted === full) return full;
        changed = true;
        return lifted;
      },
    );
  }

  if (kind === 'want_object') {
    next = next.replace(
      /(\.\w+(?:\.\w+)*)\(\s*(['"`])([^'"`]+)\2\s*,\s*(false|true)(?:\s*,\s*(false|true))*\s*\)/g,
      (_full, path: string, _q: string, id: string) => {
        changed = true;
        return `${path}('${id}', {})`;
      },
    );
  }

  return changed ? next : null;
}

export function paramsErrorHint(lastError: string): string {
  const kind = classifyShapeError(lastError);
  if (kind === 'want_string_first' || kind === 'want_more_args') {
    return [
      'Correction obligatoire :',
      '- Le diagnostic veut plusieurs arguments : chaque paramètre de chemin sort de l\'objet et devient une string.',
      '- Forme : await client.ressource.action(\'identifiant\', { option: \'valeur\' })',
      '- Interdit : un seul objet quand l\'exemple SDK ou le diagnostic commence par une string.',
    ].join('\n');
  }
  if (kind === 'want_object') {
    return [
      'Correction obligatoire :',
      '- Passe un objet d\'options, pas une suite de booléens.',
      '- Forme : await client.ressource.action(\'identifiant\', { option: true })',
    ].join('\n');
  }
  if (kind === 'bad_property') {
    return 'Correction obligatoire : remplace la propriété absente par celle suggérée (Did you mean …). N’invente pas de champs hors type.';
  }
  return '';
}

export function executeCodePrompt(input: {
  prompt: string;
  tool: SourceTool;
  docs: DocHint[];
  metaNames: string[];
  lastError?: string;
}): string {
  const server = serverOf(input.tool.id) || input.tool.serverName || 'mcp';
  const forbidden = input.metaNames.length
    ? input.metaNames.map((name) => `client.${name}`).join(', ')
    : 'client.search_docs, client.execute, client.list_tools';
  const methods = input.docs.length
    ? input.docs.map((doc) => {
      const lines = [
        doc.method,
        doc.endpoint ? `endpoint ${doc.endpoint}` : '',
        doc.summary,
        doc.params ? `params → ${doc.params}` : '',
        doc.example ? `exemples → ${doc.example}` : '',
      ].filter(Boolean);
      return `- ${lines.join('\n    ')}`;
    }).join('\n')
    : '- (aucune doc : essaie objet {…} ; si erreur string, passe en hybride id + opts)';

  return [
    'Tu écris uniquement du JavaScript exécutable, sans markdown ni commentaire hors code.',
    'Template OBLIGATOIRE :',
    'async function run(client) {',
    '  // …',
    '}',
    '',
    `Serveur MCP : ${server} (outil ${input.tool.id}).`,
    input.tool.description ? `Description outil : ${input.tool.description.slice(0, 280)}` : '',
    '',
    'Règles (tout MCP code/execute) :',
    '1. Une seule fonction top-level async function run(client). Pas d’export, pas de types TS.',
    '2. `client` = SDK fournisseur, PAS le hub MCP.',
    `3. INTERDIT sur client : ${forbidden}.`,
    '4. Utilise les méthodes listées ci-dessous.',
    '5. Forme d’appel — deux conventions, pour n’importe quel SDK :',
    '   A) Hybride : await client.ressource.action(\'identifiant\', { option: \'valeur\' })',
    '   B) Objet : await client.ressource.action({ option: \'valeur\' })',
    '   Si une ligne « exemple SDK » est donnée, reproduis SA forme.',
    '   Sinon suis « préféré ». Un paramètre présent dans le chemin {…} de l’endpoint est une string ; le reste va dans l’objet.',
    '   Interdit : un seul objet quand l’exemple ou le diagnostic attend plusieurs arguments.',
    '6. N’utilise que des champs présents dans la réponse typée.',
    '7. Renvoie un tableau d’objets plats (mesures, libellés, dates). Pas d’import, pas de fetch si le SDK suffit.',
    '',
    'Méthodes SDK (documentation) :',
    methods,
    '',
    `Demande utilisateur : ${input.prompt.slice(0, 900)}`,
    input.lastError
      ? `\nÉchec précédent — corrige exactement :\n${input.lastError.slice(0, 900)}\n${paramsErrorHint(input.lastError)}`
      : '',
  ].filter(Boolean).join('\n');
}

export function findCodeTool(
  catalog: SourceTool[],
  preferred: string[],
  skip: string[],
): SourceTool | undefined {
  return catalog.find((tool) => {
    const server = serverOf(tool.id);
    if (skip.includes(server)) return false;
    if (preferred.length && !preferred.includes(server)) return false;
    return (tool.inputSchema?.required ?? []).includes('code');
  });
}

/** Outil search_docs (ou équivalent) du serveur préféré — pour peupler les hints avant execute. */
export function findDocsTool(
  catalog: SourceTool[],
  preferred: string[],
  skip: string[],
): SourceTool | undefined {
  return catalog.find((tool) => {
    const server = serverOf(tool.id);
    if (skip.includes(server)) return false;
    if (preferred.length && !preferred.includes(server)) return false;
    return /search_docs|list_docs|read_docs|get_docs/i.test(tool.name) || /search_docs|list_docs/.test(tool.id);
  });
}
