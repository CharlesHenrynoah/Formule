/**
 * Trois blocs, un seul fil.
 * Le prompt est la genèse. Les données ne s'ajoutent que si elles témoignent
 * d'une demande du prompt. L'écran ne s'ajoute que s'il reprend ces témoignages.
 * Changer un bloc rompt le sceau du suivant.
 */
import { createHash } from 'node:crypto';

export type ClaimKind = 'meta' | 'entite' | 'mesure' | 'unite' | 'parametre' | 'periode' | 'dimension' | 'collection' | 'vue' | 'action';
export type Claim = { id: string; kind: ClaimKind; text: string };
export type LinkState = 'tenu' | 'ouvert';
export type Link = { claim: string; text: string; state: LinkState; field?: string };
export type Seal = { index: number; prev: string; hash: string };

export type Chain = {
  ok: boolean;
  claims: Claim[];
  links: Link[];
  allowed: string[];
  prompt: Seal;
  data: Seal;
  text: string;
  missing: string[];
};

export type ChainProof = { args?: Record<string, unknown>; values?: unknown[]; docs?: string };

const NOT_ACQUIRED = new Set<ClaimKind>(['meta', 'vue', 'action']);

const DOC_FIELD = /^(method|endpoint|summary|description|params|response|query|language|path|url)$/i;

/** Même notion, deux langues. Le nom du serveur n'entre pas ici. */
const SAME: Array<[RegExp, RegExp]> = [
  [/prix|price|cours/, /price|cours|close|last/],
  [/volume/, /volume/],
  [/variation|change|ecart/, /change|variation|percent|pct|delta/],
  [/capitalisation|market.?cap/, /market_cap|capitali/],
  [/plus haut|ath|high/, /ath|high/],
  [/date|jour|heure|horodat/, /date|time|timestamp|updated|heure/],
  [/nom|name|titre|title/, /name|title|nom|label|titre/],
  [/etat|statut|status/, /state|status|etat|statut/],
  [/nombre|count|total|taux|score/, /count|total|rate|score|nombre/],
];

const MEASURE = /\b(prix|price|volume|variation|capitalisation|market cap|date|nom|statut|nombre|total|taux|score|plus haut)\b/gi;
const VIEW = /\b(\d+\s+)?(cartes?|kpis?|courbe|graphique|tableau|liste|grille|page|écran|ecran|panneau|horodatage|top\s*\d+)\b([^.;\n]{0,90})/gi;

function fold(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

function seal(index: number, prev: string, payload: string): Seal {
  const hash = createHash('sha256').update(`${index}\n${prev}\n${payload}`).digest('hex').slice(0, 16);
  return { index, prev, hash };
}

function wantsDocs(prompt: string): boolean {
  const text = fold(prompt);
  const asks = /catalogue|documentation|methodes|endpoints/.test(text);
  const live = /prix|price|volume|dashboard|courbe|execute|capitalisation|en direct/.test(text);
  return asks && !live;
}

/** Ce que le prompt demande vraiment : des vues nommées, des mesures entre parenthèses, des mots de mesure. */
export function claimsFromPrompt(prompt: string): Claim[] {
  const claims: Claim[] = [];
  const seen = new Set<string>();
  const add = (kind: ClaimKind, raw: string) => {
    const text = raw.replace(/\s+/g, ' ').replace(/^[:\-–—]\s*/, '').trim().slice(0, 90);
    const key = `${kind}:${fold(text)}`;
    if (text.length < 2 || seen.has(key)) return;
    seen.add(key);
    claims.push({ id: `c${claims.length + 1}`, kind, text });
  };
  for (const match of prompt.matchAll(VIEW)) {
    add('vue', `${match[1] ?? ''}${match[2]} ${match[3] ?? ''}`);
  }
  for (const match of prompt.matchAll(/\(([^)]{3,160})\)/g)) {
    for (const part of match[1].split(/,/)) add('mesure', part);
  }
  for (const match of prompt.matchAll(MEASURE)) add('mesure', match[1]);
  for (const match of prompt.matchAll(/\b(\d+\s*(?:jours?|heures?|semaines?|mois|h))\b/gi)) add('periode', match[1]);
  for (const match of prompt.matchAll(/\b(EUR|USD|GBP|JPY|CHF)\b/g)) add('unite', match[1]);
  for (const match of prompt.matchAll(/\bpar\s+([A-Za-zÀ-ÿ][\w-]{2,30})/gi)) add('dimension', match[1]);
  for (const match of prompt.matchAll(/param[eè]tre\s+([A-Za-z_][\w]*)/gi)) add('parametre', match[1]);
  for (const match of prompt.matchAll(/[«"]([^»"]{2,80})[»"]/g)) add('meta', match[1]);
  for (const match of prompt.matchAll(/\b([A-Z]{2,6})\b/g)) {
    if (!/^(MCP|API|EUR|USD|GBP|JPY|CHF|GET|SDK|HTTP|KPI)$/.test(match[1])) add('entite', match[1]);
  }
  const named = prompt.match(/donn[ée]es de\s+([^,(.]{2,40})/i);
  if (named) add('entite', named[1]);
  for (const match of prompt.matchAll(/\b(issues?|commits?|releases?|pull requests?|commandes?|topics?|orders?)\b/gi)) add('collection', match[1]);
  for (const match of prompt.matchAll(/\b(alerter|envoie|envoyer|supprimer)\b/gi)) add('action', match[1]);
  if (!claims.length) add('vue', 'écran des données demandées');
  return claims.slice(0, 24);
}

function covers(claim: string, field: string): boolean {
  const left = fold(claim);
  const right = fold(field);
  if (left.includes(right) && right.length > 2) return true;
  const word = left.split(' ').find((part) => part.length > 3);
  if (word && (right.includes(word) || word.includes(right))) return true;
  return SAME.some(([ask, got]) => ask.test(left) && got.test(right));
}

function viewHeld(text: string, fields: string[]): boolean {
  const kind = fold(text);
  const business = fields.filter((field) => !DOC_FIELD.test(field));
  if (/courbe|graphique/.test(kind)) {
    const dated = fields.some((field) => /date|time|jour|timestamp/i.test(field));
    const measured = business.some((field) => /price|volume|count|total|value|score|rate|change|market_cap/i.test(field));
    return dated || measured || business.length > 0 && covers(text, business[0] ?? '');
  }
  if (/tableau|liste|grille|top\s*\d+/.test(kind)) return business.length >= 1 || fields.length >= 2;
  if (/carte|kpi/.test(kind)) return business.some((field) => covers(text, field)) || business.length > 0;
  return business.length > 0 || fields.length > 0;
}

function proofTouches(proof: ChainProof | undefined, needle: string): boolean {
  if (!proof || needle.trim().length < 2) return false;
  const blob = fold(JSON.stringify({ args: proof.args ?? {}, values: proof.values ?? [], docs: proof.docs ?? '' }));
  return blob.includes(fold(needle));
}

export function acquisitionNeeds(chain: Chain): Array<{ text: string; kind: ClaimKind }> {
  return chain.links.flatMap((link) => {
    const claim = chain.claims.find((item) => item.id === link.claim);
    if (!claim || link.state === 'tenu' || NOT_ACQUIRED.has(claim.kind)) return [];
    return [{ text: link.text, kind: claim.kind }];
  });
}

export function linkChain(prompt: string, fields: string[], proof?: ChainProof): Chain {
  const claims = claimsFromPrompt(prompt);
  const clean = [...new Set(fields.map((field) => field.trim()).filter(Boolean))].slice(0, 12);
  const docsOnly = clean.length > 0 && clean.every((field) => DOC_FIELD.test(field));
  const business = clean.filter((field) => !DOC_FIELD.test(field));
  const links: Link[] = claims.map((claim) => {
    const open = { claim: claim.id, text: claim.text, state: 'ouvert' as const };
    if (claim.kind === 'mesure' || claim.kind === 'dimension') {
      const field = clean.find((item) => !DOC_FIELD.test(item) && covers(claim.text, item))
        ?? (wantsDocs(prompt) ? clean.find((item) => covers(claim.text, item)) : undefined);
      return field ? { claim: claim.id, text: claim.text, state: 'tenu' as const, field } : open;
    }
    if (claim.kind === 'entite') {
      const short = fold(claim.text).length <= 12 && !fold(claim.text).includes(' ');
      const field = business.find((item) => covers(claim.text, item) || (short && /^(name|title|nom|titre|id|symbol|slug)$/i.test(item)));
      return field ? { claim: claim.id, text: claim.text, state: 'tenu' as const, field } : open;
    }
    if (claim.kind === 'unite') {
      const token = fold(claim.text);
      const field = business.find((item) => fold(item).includes(token) || /currency|devise|unit/i.test(item));
      if (field) return { claim: claim.id, text: claim.text, state: 'tenu' as const, field };
      if (proofTouches(proof, token)) return { claim: claim.id, text: claim.text, state: 'tenu' as const, field: 'argument' };
      return open;
    }
    if (claim.kind === 'periode') {
      const number = claim.text.match(/\d+/)?.[0] ?? '';
      const field = business.find((item) => /date|time|timestamp|jour|heure/i.test(item) || (number && fold(item).includes(number)) || /change|variation|percent|pct/i.test(item));
      if (field) return { claim: claim.id, text: claim.text, state: 'tenu' as const, field };
      if ((number && proofTouches(proof, number)) || proofTouches(proof, claim.text)) return { claim: claim.id, text: claim.text, state: 'tenu' as const, field: 'argument' };
      return open;
    }
    if (claim.kind === 'parametre') {
      const key = fold(claim.text);
      const field = business.find((item) => fold(item) === key);
      if (field || proofTouches(proof, key)) return { claim: claim.id, text: claim.text, state: 'tenu' as const, field: field ?? 'argument' };
      return open;
    }
    if (claim.kind === 'meta' || claim.kind === 'action') return open;
    if (claim.kind === 'collection') {
      return business.length ? { claim: claim.id, text: claim.text, state: 'tenu' as const, field: business[0] } : open;
    }
    const held = wantsDocs(prompt) ? docsOnly || viewHeld(claim.text, clean) : !docsOnly && viewHeld(claim.text, clean);
    const field = clean.find((item) => covers(claim.text, item));
    return held
      ? { claim: claim.id, text: claim.text, state: 'tenu' as const, field }
      : open;
  });

  const required = new Set(claims.filter((claim) => !NOT_ACQUIRED.has(claim.kind)).map((claim) => claim.id));
  const missing = links.filter((link) => required.has(link.claim) && link.state !== 'tenu');
  const viewsHold = links.some((link) => claims.find((claim) => claim.id === link.claim)?.kind === 'vue' && link.state === 'tenu');
  const ok = clean.length > 0 && !(docsOnly && !wantsDocs(prompt)) && missing.length === 0;

  const measures = links.filter((link) => claims.find((claim) => claim.id === link.claim)?.kind === 'mesure');
  const tableHeld = links.some((link) => link.state === 'tenu' && /tableau|liste|grille|top\s*\d+|écran des données/i.test(link.text));
  const allowed = tableHeld || (!measures.length && viewsHold)
    ? clean.filter((field) => wantsDocs(prompt) || !DOC_FIELD.test(field) || docsOnly)
    : [...new Set(links.filter((link) => link.state === 'tenu' && link.field).map((link) => link.field!))];

  const promptPayload = claims.map((claim) => `${claim.id}|${claim.kind}|${fold(claim.text)}`).join('\n');
  const dataPayload = links.map((link) => `${link.claim}|${link.state}|${link.field ?? ''}`).join('\n');
  const promptSeal = seal(0, '0'.repeat(16), promptPayload);
  const dataSeal = seal(1, promptSeal.hash, dataPayload);

  const held = links.filter((link) => link.state === 'tenu').map((link) => `${link.text}${link.field ? ` → ${link.field}` : ''}`);
  const open = links.filter((link) => link.state === 'ouvert').map((link) => link.text);
  const text = [
    'Chaîne — chaque bloc reprend le sceau du précédent.',
    `Prompt ${promptSeal.hash}`,
    ...claims.map((claim) => `  ${claim.id} ${claim.kind} : ${claim.text}`),
    `Données ${dataSeal.hash} ← ${promptSeal.hash}`,
    held.length ? `  tenus : ${held.join(' ; ')}` : '  tenus : aucun',
    open.length ? `  ouverts : ${open.join(' ; ')}` : '  ouverts : aucun',
    missing.length ? `  exigences manquantes : ${missing.map((link) => link.text).join(' ; ')}` : '  exigences manquantes : aucune',
    ok
      ? `Écran : il devra sceller ${dataSeal.hash}. Champs permis : ${allowed.join(', ') || '(aucun)'}. Un maillon ouvert ne s'affiche pas.`
      : `Écran : chaîne rompue en ${dataSeal.hash}. Rien ne s'affiche tant qu'un maillon ouvert n'a pas de champ.`,
  ].join('\n');

  return { ok, claims, links, allowed, prompt: promptSeal, data: dataSeal, text, missing: missing.map((link) => link.text) };
}
