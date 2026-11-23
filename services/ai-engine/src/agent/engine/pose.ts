/**
 * Si l'agent incrémental s'arrête sans toucher la page, on pose quand même l'élément demandé.
 * Le tableau lit data_list : la collection vide est remplie à l'ouverture.
 */

const FAMILIES: Array<[RegExp, string]> = [
  [/release|version/i, 'releases'],
  [/pull|fusion/i, 'pullRequests'],
  [/issue/i, 'issues'],
  [/commit/i, 'commits'],
  [/workflow/i, 'workflows'],
  [/note/i, 'notes'],
  [/alert/i, 'alerts'],
];

function familyOf(text: string): string {
  for (const [pattern, name] of FAMILIES) if (pattern.test(text)) return name;
  return '';
}

const STOP = new Set(['ajoute', 'ajouter', 'modifie', 'modifier', 'change', 'changer', 'supprime', 'supprimer', 'retire', 'retirer', 'mets', 'mettre', 'faire', 'fais', 'montre', 'voir', 'avec', 'dans', 'pour', 'sous', 'vers', 'chez', 'sur', 'par', 'les', 'des', 'une', 'aux', 'son', 'ses', 'est', 'pas', 'plus', 'tout', 'tous', 'toutes', 'cette', 'cet', 'mois', 'semaine', 'semaines', 'jour', 'jours', 'dernier', 'derniers', 'dernieres', 'trois', 'depuis', 'entre', 'sans', 'logiciel', 'demande', 'element', 'couleur', 'couleurs', 'titre', 'texte', 'fond', 'style', 'suivi', 'affichage', 'detail', 'details']);

const KIND_WORD = 'courbe|graphique|histogramme|camembert|série|serie|tableau|liste|grille|formulaire|saisie|filtre|sélecteur|selecteur|recherche|bouton|action|page|écran|ecran|panneau|onglet|carte';

function nouns(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9àâäéèêëïîôùûüç]+/).filter((word) => word.length > 2 && !STOP.has(word));
}

function collectionFrom(words: string[]): string {
  for (const word of words) {
    const named = familyOf(word);
    if (named) return named;
  }
  const first = words.find((word) => !/courbe|graphique|tableau|liste|page|ecran|écran|panneau|carte|bouton|formulaire|filtre/.test(word));
  return (first ?? 'lignes').slice(0, 24);
}

export function collectionForPrompt(prompt: string): string {
  return routeDemand(prompt).collection;
}

export type DemandKind = 'courbe' | 'tableau' | 'formulaire' | 'filtre' | 'action' | 'page' | 'element';
export type DemandRoute = { kind: DemandKind; collection: string; collections: string[]; title: string; data: boolean };

const LOCATED = new RegExp(`(?:sous|dans|près|pres|avant|après|apres)(?:\\s+(?:le|la|les|l['’]))?\\s+(?:${KIND_WORD})s?\\s+(?:(?!\\s+un(?:e)?\\s)[^.;\\n]){0,80}`, 'gi');

function labelOf(collection: string): string {
  if (collection === 'pullRequests') return 'Pull requests';
  return collection.charAt(0).toUpperCase() + collection.slice(1);
}

/** Toutes les collections nommées, dans l'ordre du texte. L'endroit (« sous le tableau des releases ») ne compte pas. */
export function collectionsInDemand(prompt: string): string[] {
  const body = prompt.replace(LOCATED, ' ');
  const hits: Array<{ at: number; name: string }> = [];
  for (const [pattern, name] of FAMILIES) {
    const match = new RegExp(pattern.source, 'ig').exec(body);
    if (match) hits.push({ at: match.index, name });
  }
  hits.sort((a, b) => a.at - b.at);
  const names = [...new Set(hits.map((hit) => hit.name))];
  if (names.length) return names;
  const words = nouns(body).length ? nouns(body) : nouns(prompt);
  return [collectionFrom(words)];
}

function kindOf(word: string): DemandKind {
  if (/courbe|graphique|histogramme|camembert|série|serie/.test(word)) return 'courbe';
  if (/tableau|liste|grille/.test(word)) return 'tableau';
  if (/formulaire|saisie/.test(word)) return 'formulaire';
  if (/filtre|sélecteur|selecteur|recherche/.test(word)) return 'filtre';
  if (/bouton|action/.test(word)) return 'action';
  if (/page|écran|ecran|panneau|onglet|carte/.test(word)) return 'page';
  return 'element';
}

/** Décide avant le Data Engineer, pour n'importe quel logiciel : l'élément, le sujet, et s'il faut lire des données. */
export function routeDemand(prompt: string): DemandRoute {
  const mentions = [...prompt.matchAll(new RegExp(`(?:(sous|dans|près|avant|après|apres)(?:\\s+(?:le|la|les|l['’]))?\\s+)?(${KIND_WORD})s?\\s+((?:(?!\\s+un(?:e)?\\s)[^.;\\n]){0,80})`, 'gi'))];
  const added = mentions.find((match) => !match[1]);
  const kind = added ? kindOf((added[2] ?? '').toLowerCase()) : 'element';
  const collections = collectionsInDemand(prompt);
  const collection = collections[0] ?? 'lignes';
  const reads = kind === 'courbe' || kind === 'tableau' || kind === 'page' || /montre|affiche|nombre|compte|données|donnees|par semaine|par jour|par mois|derni[eè]r|croise/i.test(prompt);
  const data = reads && kind !== 'formulaire' && kind !== 'filtre' && kind !== 'action' && !(/couleur|déplace|deplace|renomme|retire|supprime/i.test(prompt) && kind !== 'courbe' && kind !== 'tableau');
  const labels = collections.map(labelOf);
  const span = /3 derniers mois/i.test(prompt) ? ' (3 derniers mois)' : '';
  const joined = labels.length > 1 ? `${labels.slice(0, -1).join(', ')} et ${labels.at(-1)}` : labels[0] ?? labelOf(collection);
  const title = kind === 'courbe' && /semaine|mois|jour|croise/i.test(prompt) ? `${joined} par semaine${span}` : kind === 'tableau' && /derni/i.test(prompt) ? `Dernières ${joined.toLowerCase()}` : joined;
  return { kind, collection, collections, title, data };
}

type ReadCall = { tool: string; args: Record<string, unknown> };

/** La mission nomme chaque outil à appeler, un par collection. Aucun autre serveur. */
export function liaisonMission(prompt: string, read?: ReadCall | ReadCall[]): string {
  const route = routeDemand(prompt);
  const reads = !read ? [] : Array.isArray(read) ? read : [read];
  const subject = route.collections.length > 1 ? `collections ${route.collections.join(', ')}` : `collection ${route.collection}`;
  const call = reads.length
    ? `Les mcp_call sont exactement, dans cet ordre :\n${reads.map((item, index) => `${index + 1}. ${item.tool} avec les arguments ${JSON.stringify(item.args)}`).join('\n')}\nTu n'appelles aucun autre serveur. Chaque outil une fois.`
    : `Échantillonne l'outil en lecture dont le nom contient ${route.collection}. Tu n'appelles pas un outil de recherche de workflows.`;
  return `Routeur : ${route.kind}, ${subject}, titre « ${route.title} ».\nDemande : ${prompt}\n${call}\nRapport court : un outil, ses arguments et ses champs, pour chaque collection. N'invente aucun champ. Tu n'écris pas la page.`;
}

/** Retire un tableau dont le titre est la demande brute. */
export function dropIncomplete(source: string): { code: string; changed: boolean } {
  let code = source;
  let changed = false;
  for (const match of source.matchAll(/function (Added[A-Za-z0-9]+)\(\)/g)) {
    const name = match[1];
    const block = code.match(new RegExp(`function ${name}\\(\\) \\{[\\s\\S]*?\\n\\}\\n`));
    if (!block || !/<h3[^>]*>\s*Ajoute /.test(block[0])) continue;
    code = code.replace(block[0], '').replace(new RegExp(`\\s*<${name} />\\n?`), '\n');
    changed = true;
  }
  return { code, changed };
}

function componentName(collection: string): string {
  const stem = collection.replace(/[^A-Za-z0-9]/g, '');
  return `Added${stem.charAt(0).toUpperCase()}${stem.slice(1)}`;
}

const SERIES_COLORS: Array<[RegExp, string]> = [[/bleu/i, '1'], [/menthe/i, '2'], [/sable/i, '3'], [/mauve/i, '4']];

function seriesColor(prompt: string, collection: string, index: number): string {
  const needle = collection === 'pullRequests' ? 'pull|fusion' : collection;
  const at = prompt.search(new RegExp(needle, 'i'));
  const around = at >= 0 ? prompt.slice(at, at + 120) : '';
  for (const [pattern, color] of SERIES_COLORS) if (around && pattern.test(around)) return color;
  if (index === 0) for (const [pattern, color] of SERIES_COLORS) if (pattern.test(prompt)) return color;
  return String((index % 4) + 1);
}

function seriesKey(collection: string): string {
  const stem = collection.replace(/[^A-Za-z0-9]/g, '');
  const key = stem ? stem.charAt(0).toLowerCase() + stem.slice(1) : 'serie';
  return /^\d/.test(key) ? `s${key}` : key;
}

function ensureImport(source: string, module: string, names: string[]): string {
  const re = new RegExp(`import\\s+\\{([^}]+)\\}\\s+from\\s+(['"])${module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\2`);
  const match = re.exec(source);
  if (!match) return `import { ${names.join(', ')} } from '${module}';\n${source}`;
  const have = match[1].split(',').map((part) => part.trim()).filter(Boolean);
  const missing = names.filter((name) => !have.includes(name));
  if (!missing.length) return source;
  return source.replace(re, `import { ${[...have, ...missing].join(', ')} } from ${match[2]}${module}${match[2]}`);
}

function anchorOf(source: string): string {
  if (source.includes('</BoardStack>')) return '</BoardStack>';
  if (source.includes('</AppShell>')) return '</AppShell>';
  return '';
}

function replaceFunction(source: string, name: string, fn: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return source;
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        const end = source.indexOf('\n', i);
        return `${source.slice(0, start)}${fn}\n${source.slice(end + 1)}`;
      }
    }
  }
  return source;
}

/** Insère le composant dans le return et ses imports. Sans ancre, la page reste inchangée. */
function mount(source: string, name: string, fn: string, modules: Array<[string, string[]]>): { code: string; changed: boolean } {
  const anchor = anchorOf(source);
  if (!anchor) return { code: source, changed: false };
  const present = source.includes(`function ${name}(`);
  const stale = present && fn.includes('at += 7 * 86400000') && !source.includes('at += 7 * 86400000');
  if (source.includes(`<${name}`) && !stale) return { code: source, changed: false };
  let code = source.includes(`<${name}`) ? source : source.replace(anchor, `<${name} />\n    ${anchor}`);
  if (!present) {
    for (const [module, names] of modules) code = ensureImport(code, module, names);
    const at = code.search(/export default function/);
    code = at >= 0 ? `${code.slice(0, at)}${fn}\n${code.slice(at)}` : `${fn}\n${code}`;
  } else if (stale) code = replaceFunction(code, name, fn);
  return { code, changed: code !== source };
}

const HOOKS: Array<[string, string[]]> = [['react', ['useState', 'useEffect']]];
const CHARTS: Array<[string, string[]]> = [
  ['@/components/ui/chart', ['ChartContainer', 'ChartTooltip', 'ChartTooltipContent']],
  ['recharts', ['CartesianGrid', 'Line', 'LineChart', 'XAxis', 'YAxis', 'Bar', 'BarChart']],
];

function shown(source: string, title: string): boolean {
  const at = source.lastIndexOf('return (');
  return at >= 0 && source.slice(at).includes(title);
}

function tableFn(name: string, collection: string, title: string): string {
  return `function ${name}() {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  useEffect(() => {
    let stop = false;
    Promise.resolve(window.app?.call('data_list', { collection: '${collection}' })).then((result: { items?: unknown[]; result?: { items?: unknown[] } } | undefined) => {
      const items = result?.items ?? result?.result?.items ?? [];
      if (!stop && Array.isArray(items)) setRows(items.slice(0, 10) as Array<Record<string, unknown>>);
    }).catch(() => {});
    return () => { stop = true; };
  }, []);
  return (
    <div className="rounded-xl border bg-card p-6">
      <h3 className="mb-3 text-sm font-semibold">${title}</h3>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t border-border">
              <td className="py-2">{String(row.tag_name ?? row.name ?? row.version ?? row.title ?? row.message ?? row.key ?? '')}</td>
              <td className="py-2">{String(row.author ?? row.login ?? '')}</td>
              <td className="py-2">{String(row.date ?? row.publishedAt ?? row.published_at ?? row.createdAt ?? row.created_at ?? '')}</td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td className="py-2 text-muted-foreground">Aucune ligne</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
`;
}

function chartFn(name: string, collections: string[], title: string, prompt: string): string {
  const ranking = /classement|auteur|contributeur|\btop\b/i.test(prompt) && !/semaine|par jour|par mois|croise/i.test(prompt);
  if (ranking) {
    const collection = collections[0];
    return `function ${name}() {
  const [rows, setRows] = useState<Array<{ label: string; count: number }>>([]);
  useEffect(() => {
    let stop = false;
    Promise.resolve(window.app?.call('data_list', { collection: '${collection}' })).then((result: { items?: unknown[]; result?: { items?: unknown[] } } | undefined) => {
      const items = (result?.items ?? result?.result?.items ?? []) as Array<Record<string, unknown>>;
      const counts = new Map<string, number>();
      for (const row of items) {
        const who = String(row.author ?? row.login ?? '');
        if (!who) continue;
        counts.set(who, (counts.get(who) ?? 0) + 1);
      }
      if (!stop) setRows([...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count).slice(0, 8));
    }).catch(() => {});
    return () => { stop = true; };
  }, []);
  return (
    <div className="rounded-xl border bg-card p-6">
      <h3 className="mb-3 text-sm font-semibold">${title}</h3>
      <ChartContainer config={{ count: { label: 'Nombre', color: 'var(--chart-3)' } }} className="h-[260px] w-full">
        <BarChart data={rows}>
          <CartesianGrid vertical={false} strokeOpacity={0.15} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} />
          <YAxis width={40} tickLine={false} axisLine={false} allowDecimals={false} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="count" fill="var(--color-count)" radius={4} />
        </BarChart>
      </ChartContainer>
    </div>
  );
}
`;
  }
  const keys = collections.map(seriesKey);
  const config = keys.map((key, index) => `${key}: { label: '${labelOf(collections[index] ?? key)}', color: 'var(--chart-${seriesColor(prompt, collections[index] ?? key, index)})' }`).join(', ');
  const lines = keys.map((key) => `<Line dataKey="${key}" type="monotone" stroke="var(--color-${key})" strokeWidth={2} dot={false} />`).join('\n          ');
  const loads = collections.map((collection, index) => {
    const merged = collection === 'pullRequests' && /fusionn|merg/i.test(prompt) ? `if (!(row.mergedAt || row.merged_at || row.merged === true)) continue;` : '';
    return `Promise.resolve(window.app?.call('data_list', { collection: '${collection}' })).then((result: { items?: unknown[]; result?: { items?: unknown[] } } | undefined) => {
        const items = (result?.items ?? result?.result?.items ?? []) as Array<Record<string, unknown>>;
        for (const row of items) {
          const at = new Date(String(row.date ?? row.createdAt ?? row.created_at ?? row.publishedAt ?? row.published_at ?? row.mergedAt ?? row.merged_at ?? '')).getTime();
          if (!at || at < cutoff) continue;
          ${merged}
          const wk = addedWeek(at);
          const bucket = buckets.get(wk) ?? { label: wk${keys.map((key) => `, ${key}: 0`).join('')} };
          bucket.${keys[index]} += 1;
          buckets.set(wk, bucket);
        }
      })`;
  }).join(',\n      ');
  return `function ${name}() {
  const [rows, setRows] = useState<Array<Record<string, string | number>>>([]);
  useEffect(() => {
    let stop = false;
    const cutoff = Date.now() - 90 * 86400000;
    const addedWeek = (at: number) => {
      const utc = new Date(at);
      const day = new Date(Date.UTC(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate()));
      const dow = day.getUTCDay() || 7;
      day.setUTCDate(day.getUTCDate() + 4 - dow);
      const start = new Date(Date.UTC(day.getUTCFullYear(), 0, 1));
      const week = Math.ceil((((day.getTime() - start.getTime()) / 86400000) + 1) / 7);
      return day.getUTCFullYear() + '-' + String(week).padStart(2, '0');
    };
    const buckets = new Map<string, { label: string; ${keys.map((key) => `${key}: number`).join('; ')} }>();
    Promise.all([
      ${loads}
    ]).then(() => {
      for (let at = cutoff; at <= Date.now(); at += 7 * 86400000) {
        const wk = addedWeek(at);
        if (!buckets.has(wk)) buckets.set(wk, { label: wk${keys.map((key) => `, ${key}: 0`).join('')} });
      }
      if (!stop) setRows([...buckets.values()].sort((a, b) => a.label.localeCompare(b.label)).slice(-13));
    }).catch(() => {});
    return () => { stop = true; };
  }, []);
  return (
    <div className="rounded-xl border bg-card p-6">
      <h3 className="mb-3 text-sm font-semibold">${title}</h3>
      <ChartContainer config={{ ${config} }} className="h-[260px] w-full">
        <LineChart data={rows}>
          <CartesianGrid vertical={false} strokeOpacity={0.15} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} minTickGap={16} />
          <YAxis width={40} tickLine={false} axisLine={false} allowDecimals={false} />
          <ChartTooltip content={<ChartTooltipContent />} />
          ${lines}
        </LineChart>
      </ChartContainer>
    </div>
  );
}
`;
}

function cardFn(name: string, collection: string, title: string): string {
  return `function ${name}() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let stop = false;
    Promise.resolve(window.app?.call('data_list', { collection: '${collection}' })).then((result: { items?: unknown[]; total?: number; result?: { items?: unknown[]; total?: number } } | undefined) => {
      const items = result?.items ?? result?.result?.items ?? [];
      const total = result?.total ?? result?.result?.total;
      if (!stop) setCount(typeof total === 'number' ? total : Array.isArray(items) ? items.length : 0);
    }).catch(() => {});
    return () => { stop = true; };
  }, []);
  return (
    <div className="rounded-xl border bg-card p-6">
      <h3 className="mb-3 text-sm font-semibold">${title}</h3>
      <p className="text-2xl font-semibold tabular-nums">{count}</p>
    </div>
  );
}
`;
}

function formFn(name: string, title: string): string {
  return `function ${name}() {
  const [value, setValue] = useState('');
  return (
    <form className="rounded-xl border bg-card p-6" onSubmit={(event) => event.preventDefault()}>
      <h3 className="mb-3 text-sm font-semibold">${title}</h3>
      <input value={value} onChange={(event) => setValue(event.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
    </form>
  );
}
`;
}

/** Pose l'élément routé dans le return. Le titre n'est jamais la demande brute. Sans ancre, rien n'est écrit. */
export function poseRequest(source: string, prompt: string): { code: string; changed: boolean } {
  const route = routeDemand(prompt);
  if (route.kind === 'filtre' || route.kind === 'action') return { code: source, changed: false };
  if (!route.data && route.kind !== 'formulaire') return { code: source, changed: false };
  const name = componentName(route.collections.join('') || route.collection);
  const fn = route.kind === 'courbe' ? chartFn(name, route.collections, route.title, prompt) : '';
  const stale = fn.includes('at += 7 * 86400000') && source.includes(`function ${name}(`) && !source.includes('at += 7 * 86400000');
  if (shown(source, route.title) && !stale) return { code: source, changed: false };
  if (route.kind === 'courbe') return mount(source, name, fn, [...HOOKS, ...CHARTS]);
  if (route.kind === 'tableau') return mount(source, name, tableFn(name, route.collection, route.title), HOOKS);
  if (route.kind === 'formulaire') return mount(source, name, formFn(name, route.title), [['react', ['useState']]]);
  if (route.data) return mount(source, name, cardFn(name, route.collection, route.title), HOOKS);
  return { code: source, changed: false };
}
