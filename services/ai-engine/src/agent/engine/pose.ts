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
export type DemandRoute = { kind: DemandKind; collection: string; title: string; data: boolean };

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
  const clause = added?.[3] || prompt;
  const collection = collectionFrom(nouns(clause).length ? nouns(clause) : nouns(prompt));
  const reads = kind === 'courbe' || kind === 'tableau' || kind === 'page' || /montre|affiche|nombre|compte|données|donnees|par semaine|par jour|par mois|derni[eè]r/i.test(prompt);
  const data = reads && kind !== 'formulaire' && kind !== 'filtre' && kind !== 'action' && !(/couleur|déplace|deplace|renomme|retire|supprime/i.test(prompt) && kind !== 'courbe' && kind !== 'tableau');
  const label = collection === 'pullRequests' ? 'Pull requests' : collection.charAt(0).toUpperCase() + collection.slice(1);
  const span = /3 derniers mois/i.test(prompt) ? ' (3 derniers mois)' : '';
  const title = kind === 'courbe' && /semaine/i.test(prompt) ? `${label} par semaine${span}` : kind === 'tableau' && /derni/i.test(prompt) ? `Dernières ${label.toLowerCase()}` : label;
  return { kind, collection, title, data };
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
  if (route.kind !== 'tableau' || !route.data) return { code: source, changed: false };
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
