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

export function collectionForPrompt(prompt: string): string {
  const mentions = [...prompt.matchAll(/(?:(sous|dans|près|avant|après|apres)(?:\s+(?:le|la|les|l['’]))?\s+)?((?:courbe|graphique|tableau|liste|série|serie|carte)s?)\s+(?:de |des |du |d['’])?(?:la |le |les |l['’])?([a-zàâäéèêëïîôùûüç0-9]+)/gi)];
  for (const match of mentions) {
    if (match[1]) continue;
    const named = familyOf(match[3] ?? '');
    if (named) return named;
  }
  const fromPrompt = familyOf(prompt);
  if (fromPrompt) return fromPrompt;
  const word = prompt.toLowerCase().split(/[^a-z0-9]+/).find((part) => part.length > 3 && !/ajoute|tableau|dernier|dernieres|avec|dans|pour|sous|vers|element|courbe|graphique/.test(part));
  return (word ?? 'lignes').slice(0, 24);
}

export type DemandRoute = { kind: 'courbe' | 'tableau' | 'element'; collection: string; title: string };

/** Décide avant le Data Engineer : quoi poser, sur quelle collection, avec quel titre. */
export function routeDemand(prompt: string): DemandRoute {
  const collection = collectionForPrompt(prompt);
  const mentions = [...prompt.matchAll(/(?:(sous|dans|près|avant|après|apres)(?:\s+(?:le|la|les|l['’]))?\s+)?((?:courbe|graphique|tableau|liste|série|serie|carte)s?)\s+/gi)];
  const added = mentions.find((match) => !match[1]);
  const word = (added?.[2] ?? '').toLowerCase();
  const kind: DemandRoute['kind'] = /courbe|graphique|série|serie/.test(word) ? 'courbe' : /tableau|liste/.test(word) ? 'tableau' : 'element';
  const label = collection === 'pullRequests' ? 'Pull requests' : collection.charAt(0).toUpperCase() + collection.slice(1);
  const span = /3 derniers mois/i.test(prompt) ? ' (3 derniers mois)' : '';
  const title = kind === 'courbe' ? `${label} par semaine${span}` : kind === 'tableau' && collection === 'releases' ? 'Dernières releases' : label;
  return { kind, collection, title };
}

/** La mission nomme l'outil à appeler. Le Data Engineer ne part pas chercher un autre serveur. */
export function liaisonMission(prompt: string, read?: { tool: string; args: Record<string, unknown> }): string {
  const route = routeDemand(prompt);
  const call = read
    ? `Le premier mcp_call est exactement ${read.tool} avec les arguments ${JSON.stringify(read.args)}. Tu n'appelles aucun autre serveur.`
    : `Échantillonne l'outil en lecture dont le nom contient ${route.collection}. Tu n'appelles pas un outil de recherche de workflows.`;
  return `Routeur : ${route.kind}, collection ${route.collection}, titre « ${route.title} ».\nDemande : ${prompt}\n${call}\nTu n'échantillons pas une autre collection. Rapport court : outil, arguments, champs observés. N'invente aucun champ. Tu n'écris pas la page.`;
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

/** Pose l'élément routé. Une courbe n'est jamais un tableau d'une colonne, et le titre n'est jamais la demande brute. */
export function poseRequest(source: string, prompt: string): { code: string; changed: boolean } {
  const route = routeDemand(prompt);
  if (route.kind === 'courbe') return { code: source, changed: false };
  const collection = route.collection;
  const name = componentName(collection);
  if (source.includes(`function ${name}(`) || source.includes(route.title)) return { code: source, changed: false };
  const anchor = source.includes('</BoardStack>') ? '</BoardStack>' : source.includes('</AppShell>') ? '</AppShell>' : '';
  if (!anchor) return { code: source, changed: false };
  const title = route.title;
  const fn = `function ${name}() {
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
              <td className="py-2">{String(row.tag_name ?? row.name ?? row.version ?? row.title ?? row.key ?? '')}</td>
            </tr>
          ))}
          {rows.length === 0 ? <tr><td className="py-2 text-muted-foreground">Aucune ligne</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
`;
  let code = source.replace(anchor, `<${name} />\n    ${anchor}`);
  if (!/\buseState\b/.test(source) || !/\buseEffect\b/.test(source)) {
    if (/from ['"]react['"]/.test(code)) {
      code = code.replace(/import\s+\{([^}]+)\}\s+from\s+(['"])react\2/, (full, inner: string, q: string) => {
        const have = inner.split(',').map((part) => part.trim()).filter(Boolean);
        const missing = ['useState', 'useEffect'].filter((hook) => !have.includes(hook) && !new RegExp(`\\b${hook}\\b`).test(source));
        return missing.length ? `import { ${[...have, ...missing].join(', ')} } from ${q}react${q}` : full;
      });
    } else code = `import { useState, useEffect } from 'react';\n${code}`;
  }
  const at = code.search(/export default function/);
  code = at >= 0 ? `${code.slice(0, at)}${fn}\n${code.slice(at)}` : `${fn}\n${code}`;
  return { code, changed: true };
}
