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

/** La mission nomme l'outil à appeler. Le Data Engineer ne part pas chercher un autre serveur. */
export function liaisonMission(prompt: string, read?: { tool: string; args: Record<string, unknown> }): string {
  const collection = collectionForPrompt(prompt);
  const call = read
    ? `Le premier mcp_call est exactement ${read.tool} avec les arguments ${JSON.stringify(read.args)}. Tu n'appelles aucun autre serveur.`
    : `Échantillonne l'outil en lecture dont le nom contient ${collection}. Tu n'appelles pas un outil de recherche de workflows.`;
  return `L'interface existe déjà. On ajoute un élément ou des données.\nDemande : ${prompt}\nCollection visée : ${collection}.\n${call}\nRapport court : outil, arguments, champs observés. N'invente aucun champ. Tu n'écris pas la page.`;
}

function componentName(collection: string): string {
  const stem = collection.replace(/[^A-Za-z0-9]/g, '');
  return `Added${stem.charAt(0).toUpperCase()}${stem.slice(1)}`;
}

function titleOf(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').replace(/[{}<>&]/g, ' ').trim().slice(0, 90) || 'Élément ajouté';
}

/** Pose un tableau branché sur data_list juste avant la fin du tableau de bord. */
export function poseRequest(source: string, prompt: string): { code: string; changed: boolean } {
  const collection = collectionForPrompt(prompt);
  const name = componentName(collection);
  if (source.includes(`function ${name}(`)) return { code: source, changed: false };
  const anchor = source.includes('</BoardStack>') ? '</BoardStack>' : source.includes('</AppShell>') ? '</AppShell>' : '';
  if (!anchor) return { code: source, changed: false };
  const title = titleOf(prompt);
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
