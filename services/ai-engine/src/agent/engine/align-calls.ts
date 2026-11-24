/**
 * Avant d'écrire : la forme du tableau d'exemple (board.tsx).
 * Après l'écriture : seuls les champs observés à la lecture s'affichent.
 * Un écran qui invente price ou volume alors que la lecture n'a que method
 * est remplacé, pour n'importe quel projet et n'importe quel MCP —
 * sauf si la demande veut du live : on ne pose alors PAS un catalogue de docs.
 */
import { CANONICAL, collectionForRead, collectionsInBackend } from '../seed-from-samples.ts';
import { linkChain } from './chain.ts';
import { docsMismatchIntent, fieldsLookLikeDocs, thinkAboutDemand } from './product-owner.ts';

const ALLOWED = new Set([
  'items', 'total', 'totalCount', 'id', 'key', 'label', 'count', 'length', 'map', 'filter', 'slice',
  'find', 'some', 'every', 'includes', 'concat', 'join', 'split', 'trim', 'push', 'reduce', 'forEach',
  'toFixed', 'toLocaleString', 'toString', 'padStart', 'localeCompare', 'getTime', 'call', 'collection',
  'then', 'catch', 'finally', 'result', 'rows', 'value', 'hint', 'config', 'color', 'fill', 'stroke',
  'name', 'type', 'ok', 'error', 'ms', 'data', 'state', 'props', 'children', 'className', 'style',
  'current', 'target', 'index', 'i', 'j', 'k', 'entry', 'entries', 'keys', 'values', 'size', 'has', 'get', 'set',
  'mounted', 'alive', 'stop', 'signal', 'abort', 'Promise', 'Array', 'Object', 'String', 'Number', 'Math',
  'window', 'app', 'document', 'undefined', 'null', 'true', 'false', 'const', 'let', 'var',
]);

export function interfaceChecklist(fields: string[], prompt = ''): string {
  const columns = fields.filter((field) => field !== 'id').slice(0, 6);
  const shown = columns.length ? columns.join(', ') : 'les champs observés';
  if (!prompt.trim()) {
    return [
      'Forme, la même que le tableau d\'exemple src/components/es/board.tsx :',
      '1. BoardHeader, le titre de la demande (pas le prompt entier dans une cellule).',
      '2. MetricGrid, quatre MetricCard. Chaque valeur vient de data_list (result.total) ou du nombre de valeurs distinctes d\'un champ observé.',
      '3. BoardSplit({ chart, side }). Le graphique a className "h-[260px] w-full". dataKey label et count.',
      '4. Le tableau à côté n\'affiche que ces champs : ' + shown + '.',
      '5. window.app.call ne nomme que data_list, data_get, ou un outil présent dans server/tools.ts.',
      '6. Interdit d\'afficher un champ absent de cette liste.',
    ].join('\n');
  }
  const chain = linkChain(prompt, columns);
  const thought = thinkAboutDemand(prompt);
  return [
    chain.text,
    `Intention : ${thought.ui} sur « ${thought.subject} ».`,
    chain.ok
      ? [
          'Forme, la même que le tableau d\'exemple src/components/es/board.tsx :',
          '1. BoardHeader, le titre de la demande (pas le prompt entier dans une cellule).',
          `2. Seulement les maillons tenus. Champs permis : ${chain.allowed.join(', ') || shown}.`,
          '3. Un maillon ouvert n\'a ni carte, ni courbe, ni zéro fictif.',
          '4. window.app.call ne nomme que data_list, data_get, ou un outil présent dans server/tools.ts.',
          '5. Interdit d\'afficher un champ absent de cette liste.',
        ].join('\n')
      : 'La chaîne est rompue. Ne génère pas l\'écran.',
  ].join('\n\n');
}

export function observedFields(samples: Array<{ rows?: Array<Record<string, unknown>> }>): string[] {
  const keys = new Set<string>();
  for (const sample of samples) {
    for (const row of sample.rows ?? []) {
      for (const key of Object.keys(row)) if (key !== 'id' && keys.size < 8) keys.add(key);
    }
  }
  return [...keys];
}

/** Collection lue : celle du backend, sinon le nom de l'outil de lecture. */
export function observedCollection(toolsSource: string, samples: Array<{ tool?: string }> = []): string {
  return collectionsInBackend(toolsSource)[0]
    ?? samples.map((sample) => String(sample.tool ?? '')).find((tool) => tool.includes('__'))
    ?? 'lignes';
}

/** Champs lus dans la page qui n'existent pas dans l'échantillon. */
export function unknownFieldReads(page: string, fields: string[]): string[] {
  const known = new Set([...fields, ...ALLOWED]);
  const hits = new Set<string>();
  for (const match of page.matchAll(/\.(?:[A-Za-z_][\w]*)/g)) {
    const field = match[0].slice(1);
    if (/^[A-Z]/.test(field)) continue;
    if (known.has(field)) continue;
    if (/^(use[A-Z]|set[A-Z]|on[A-Z]|Board|Metric|Chart|Table|Card|App)/.test(field)) continue;
    hits.add(field);
  }
  return [...hits];
}

function declaredTools(source: string): Set<string> {
  const names = new Set(['data_list', 'data_get']);
  for (const match of source.matchAll(/^\s{2}([A-Za-z][\w]*)\s*:\s*\{/gm)) names.add(match[1]);
  return names;
}

/** Un appel absent du backend lit data_list. */
export function alignCalls(page: string, toolsSource: string): { code: string; changed: boolean } {
  const names = declaredTools(toolsSource);
  const collection = collectionsInBackend(toolsSource)[0];
  if (!collection) return { code: page, changed: false };
  let changed = false;
  const code = page.replace(/app\??\.call\(\s*(['"`])([A-Za-z][\w]*)\1(\s*,\s*\{[^}]*\})?/g, (full, quote: string, name: string) => {
    if (names.has(name)) return full;
    changed = true;
    return `app.call(${quote}data_list${quote}, { collection: '${collection}' })`;
  });
  return { code, changed };
}

function esc(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function titleOf(prompt: string, collection: string): string {
  const line = prompt.replace(/\s+/g, ' ').trim().slice(0, 72);
  return line || collection;
}

function screenTitle(prompt: string): string {
  const quoted = [...prompt.matchAll(/[«"]([^»"]{2,80})[»"]/g)].map((match) => match[1].trim());
  const named = [...quoted].reverse().find((label) => label.split(' ').length >= 2 && !/[{}/]/.test(label));
  return (named || prompt.replace(/\s+/g, ' ').trim()).slice(0, 72);
}

/**
 * Page branchée sur les maillons tenus.
 * Sans vue nommée : le tableau des champs observés.
 * Avec des vues nommées : une carte par mesure, une courbe si une date existe, un tableau si demandé.
 * Jamais une répartition du premier champ à la place de ces vues.
 */
export function poseObservedPage(prompt: string, collection: string, fields: string[]): string {
  const chain = linkChain(prompt, fields);
  const named = chain.claims.some((claim) => claim.kind === 'vue' && !/écran des données demandées/.test(claim.text));
  if (!named) return poseListing(prompt, collection, fields);
  const cols = (chain.allowed.length ? chain.allowed : fields).filter((field) => field !== 'id').slice(0, 6);
  const measures = chain.links.filter((link) => link.state === 'tenu' && link.field && chain.claims.some((claim) => claim.id === link.claim && claim.kind === 'mesure'));
  const cards = measures.filter((link, index, all) => all.findIndex((item) => item.field === link.field) === index).slice(0, 4);
  const curve = chain.links.some((link) => link.state === 'tenu' && /courbe|graphique/i.test(link.text));
  const table = chain.links.some((link) => link.state === 'tenu' && /tableau|liste|grille|top\s*\d+/i.test(link.text));
  const stamp = chain.links.some((link) => link.state === 'tenu' && /horodat|heure|mise à jour/i.test(link.text));
  const dateField = cols.find((field) => /^date$/i.test(field)) || cols.find((field) => /timestamp|_at$|At$/i.test(field)) || '';
  const measureField = cards[0]?.field ?? cols.find((field) => field !== dateField) ?? '';
  const highlight = prompt.match(/ligne\s+([^.,]{2,40}?)\s+mise en évidence/i)?.[1]?.trim().toLowerCase() ?? '';
  const title = esc(screenTitle(prompt));
  const col = esc(collection);
  const cardNodes = cards.map((link) => `        <MetricCard label="${esc(link.text)}" value={rows[0]?.${link.field} ?? '—'} hint="" />`).join('\n');
  const heads = cols.slice(0, 4).map((field) => `<th className="py-2 pr-2 font-medium">${esc(field)}</th>`).join('\n                    ');
  const cells = cols.slice(0, 4).map((field) => `<td className="py-2 pr-2 text-xs">{String(row.${field} ?? '')}</td>`).join('\n                      ');
  const chart = curve && dateField && measureField
    ? `<div>
            <h2 className="mb-2 text-sm font-medium">${esc(measureField)}</h2>
            <ChartContainer config={chartConfig} className="h-[260px] w-full">
              <LineChart data={series}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Line dataKey="value" stroke="var(--color-value)" dot={false} />
              </LineChart>
            </ChartContainer>
          </div>`
    : '';
  const grid = cardNodes
    ? `<MetricGrid>
${cardNodes}
      </MetricGrid>`
    : '';
  const sheet = table
    ? `<div>
            <h2 className="mb-2 text-sm font-medium">${esc(chain.links.find((link) => /tableau|top/i.test(link.text))?.text || 'Lignes')}</h2>
            <div className="max-h-[260px] overflow-auto">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 border-b bg-card"><tr className="text-xs text-muted-foreground">${heads}</tr></thead>
                <tbody>
                  {rows.slice(0, 10).map((row, index) => (
                    <tr key={index} className={${highlight ? `String(Object.values(row).join(' ')).toLowerCase().includes('${esc(highlight)}') ? 'bg-muted' : ''` : "''"}}>
                      ${cells}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>`
    : '';
  const body = chart && sheet
    ? `<BoardSplit chart={${chart}} side={${sheet}} />`
    : `${chart}${sheet}`;
  return `import { AppShell } from '@/components/es/app-shell';
import { useEffect, useMemo, useState } from 'react';
import { BoardStack, BoardHeader, MetricGrid, MetricCard, BoardSplit } from '@/components/es/board';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';

type Row = Record<string, unknown>;

const chartConfig = { value: { label: '${esc(measureField || 'valeur')}', color: 'var(--chart-1)' } } satisfies ChartConfig;

export default function App() {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    let alive = true;
    window.app?.call('data_list', { collection: '${col}' })
      .then((result: { items?: Row[] } | undefined) => { if (alive) setRows(Array.isArray(result?.items) ? result.items : []); })
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, []);
  const series = useMemo(() => rows.flatMap((row) => {
    const date = String(row.date ?? row.${dateField || 'date'} ?? '');
    const value = Number(row.${measureField || 'value'});
    return date && Number.isFinite(value) ? [{ date, value }] : [];
  }), [rows]);
  return (<AppShell title="Pilotage">
    <BoardStack>
      <BoardHeader title="${title}">${stamp && dateField ? `<span className="text-sm text-muted-foreground">{String(rows[0]?.${dateField} ?? '')}</span>` : ''}
      </BoardHeader>
      ${grid}
      ${body}
    </BoardStack>
  </AppShell>);
}
`;
}

function poseListing(prompt: string, collection: string, fields: string[]): string {
  const cols = fields.filter((field) => field !== 'id').slice(0, 4);
  const a = cols[0] ?? 'label';
  const b = cols[1] ?? a;
  const c = cols[2] ?? b;
  const title = esc(screenTitle(prompt) || titleOf(prompt, collection));
  const col = esc(collection);
  const cells = cols.slice(0, 3).map((field) => `<td className="py-2 pr-2 text-xs">{String(row.${field} ?? '')}</td>`).join('\n                      ');
  const heads = cols.slice(0, 3).map((field) => `<th className="py-2 pr-2 font-medium">${esc(field)}</th>`).join('\n                    ');
  return `import { AppShell } from '@/components/es/app-shell';
import { useEffect, useMemo, useState } from 'react';
import { BoardStack, BoardHeader, MetricGrid, MetricCard, BoardSplit } from '@/components/es/board';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';

type Row = Record<string, unknown>;

const chartConfig = {
  count: { label: 'Nombre', color: 'var(--chart-1)' },
} satisfies ChartConfig;

export default function App() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let alive = true;
    window.app
      ?.call('data_list', { collection: '${col}' })
      .then((result: { items?: Row[]; total?: number } | undefined) => {
        if (!alive) return;
        const items = Array.isArray(result?.items) ? result.items : [];
        setRows(items);
        setTotal(typeof result?.total === 'number' ? result.total : items.length);
      })
      .catch(() => {
        if (alive) { setRows([]); setTotal(0); }
      });
    return () => { alive = false; };
  }, []);

  const distinctA = useMemo(() => new Set(rows.map((row) => String(row.${a} ?? '')).filter(Boolean)).size, [rows]);
  const distinctB = useMemo(() => new Set(rows.map((row) => String(row.${b} ?? '')).filter(Boolean)).size, [rows]);
  const filled = useMemo(() => rows.filter((row) => row.${c} != null && String(row.${c}) !== '').length, [rows]);
  const chartData = useMemo(() => {
    const buckets = new Map<string, number>();
    for (const row of rows) {
      const key = String(row.${a} ?? '—');
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    return [...buckets.entries()].map(([label, count]) => ({ label, count })).sort((left, right) => right.count - left.count).slice(0, 12);
  }, [rows]);

  return (<AppShell title="Pilotage">
    <BoardStack>
      <BoardHeader title="${title}">
        <span className="text-sm text-muted-foreground">${col}</span>
      </BoardHeader>
      <MetricGrid>
        <MetricCard label="Lignes" value={total} hint="data_list" />
        <MetricCard label="${esc(a)}" value={distinctA} hint="valeurs distinctes" />
        <MetricCard label="${esc(b)}" value={distinctB} hint="valeurs distinctes" />
        <MetricCard label="${esc(c)}" value={filled} hint="renseignés" />
      </MetricGrid>
      <BoardSplit
        chart={
          <div>
            <h2 className="mb-2 text-sm font-medium">Répartition · ${esc(a)}</h2>
            <ChartContainer config={chartConfig} className="h-[260px] w-full">
              <BarChart data={chartData}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} />
                <YAxis tickLine={false} axisLine={false} allowDecimals={false} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="count" fill="var(--color-count)" radius={4} />
              </BarChart>
            </ChartContainer>
          </div>
        }
        side={
          <div>
            <h2 className="mb-2 text-sm font-medium">Top 10</h2>
            <div className="max-h-[260px] overflow-auto">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 border-b bg-card">
                  <tr className="text-xs text-muted-foreground">
                    ${heads}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 10).map((row, index) => (
                    <tr key={index} className="border-b align-top">
                      ${cells}
                    </tr>
                  ))}
                  {rows.length === 0 ? (
                    <tr><td className="py-2 text-muted-foreground" colSpan={3}>Aucune ligne</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        }
      />
    </BoardStack>
  </AppShell>);
}
`;
}

function boardBroken(page: string): boolean {
  if (/<BoardSplit\s*>/.test(page) && !/<BoardSplit[^>]*\bchart=/.test(page)) return true;
  if (/BoardSplit/.test(page) && !/\bchart=/.test(page)) return true;
  return false;
}

/**
 * Si la page invente des champs absents de la lecture, ou casse BoardSplit,
 * on pose l'écran d'exemple branché sur les champs observés.
 */
export function alignObserved(
  page: string,
  toolsSource: string,
  prompt: string,
  samples: Array<{ tool?: string; rows?: Array<Record<string, unknown>> }>,
): { code: string; changed: boolean } {
  const fields = observedFields(samples);
  if (!fields.length) return { code: page, changed: false };
  const listed = observedCollection(toolsSource, samples);
  if (/^demo/i.test(listed) && /pas\s+(?:le\s+)?serveur\s+(?:de\s+)?d[eé]mo|n['']?utilise\s+pas.*d[eé]mo/i.test(prompt)) {
    return { code: page, changed: false };
  }
  const thought = thinkAboutDemand(prompt);
  const chain = linkChain(prompt, fields);
  if (!chain.ok || docsMismatchIntent(thought, fields) || (thought.needsLiveData && fieldsLookLikeDocs(fields))) {
    return { code: page, changed: false };
  }
  const home = collectionForRead(toolsSource, samples);
  const unknown = unknownFieldReads(page, fields);
  const mold = /Répartition\s*·|valeurs distinctes/.test(page);
  const named = chain.claims.some((claim) => claim.kind === 'vue' && !/écran des données demandées/.test(claim.text));
  if (!unknown.length && !boardBroken(page) && !(mold && named)) {
    return retargetCollection(page, home);
  }
  return { code: poseObservedPage(prompt, home, fields), changed: true };
}

/** Une collection canonique qui n'est pas celle des lignes lues est remplacée. Le reste de l'écran reste. */
function retargetCollection(page: string, home: string): { code: string; changed: boolean } {
  if (!home) return { code: page, changed: false };
  let changed = false;
  const code = page.replace(/collection:\s*(['"])([A-Za-z][\w]*)\1/g, (full, quote: string, name: string) => {
    if (name === home || !CANONICAL.includes(name)) return full;
    changed = true;
    return `collection: ${quote}${home}${quote}`;
  });
  return { code, changed };
}
