/**
 * Product Owner : avant le Développeur, il raisonne sur l’intention réelle
 * (n’importe quel logiciel / MCP), puis vérifie que les lectures y correspondent.
 */
import { keepNamedServer, mentionedServers, type SourceTool } from '../../app-agents/ingest.ts';
import { keepSpan } from './series.ts';
import { claimsFromPrompt, hitsInRows, linkChain, type ChainProof } from './chain.ts';
import { globalShape } from './sdk-scope.ts';
import { classifyLink } from '../../../../mcp-hub/src/link-state.ts';

export type OwnerRead = { tool: string; args: Record<string, unknown>; ok: boolean; error?: string; rows: Array<Record<string, unknown>>; diagnostic?: string };
export type OwnerSample = { tool: string; args: Record<string, unknown>; rows: Array<Record<string, unknown>> };

export type OwnerVerdict = {
  ok: boolean;
  text: string;
  brief: string;
  samples: OwnerSample[];
  thought?: DemandThought;
  missing: string[];
  retryable: boolean;
};

/** Intention déduite du prompt — générique, pas liée à un MCP. */
export type DemandThought = {
  subject: string;
  ui: string;
  needsLiveData: boolean;
  needsDocsCatalog: boolean;
  needsTimeSeries: boolean;
  needsRanking: boolean;
  expectedFields: string[];
  steps: string[];
};

const DOC_FIELD = /^(method|endpoint|summary|description|params|response|titre|title|texte|label|query|language|path|url)$/i;
const METRIC_FIELD = /price|prix|volume|change|variation|market_cap|current|sparkline|close|open|high|low|ath|capitalisation|amount|count|total|score|rate|pct|percent/i;

function serverOf(id: string): string {
  return id.includes('__') ? id.split('__')[0] : '';
}

function fieldsOf(reads: OwnerRead[]): string[] {
  const keys = new Set<string>();
  for (const read of reads) {
    if (!read.ok) continue;
    for (const row of read.rows) for (const key of Object.keys(row)) if (key !== 'id' && keys.size < 10) keys.add(key);
  }
  return [...keys];
}

export function fieldsLookLikeDocs(fields: string[]): boolean {
  if (!fields.length) return false;
  return fields.every((field) => DOC_FIELD.test(field));
}

export function fieldsLookLikeMetrics(fields: string[]): boolean {
  return fields.some((field) => METRIC_FIELD.test(field));
}

/**
 * Petite chaîne de pensée : ce que l’utilisateur attend vraiment,
 * pour n’importe quel moteur branché. Le domaine vient de la demande, pas d’une marque de serveur.
 */
export function thinkAboutDemand(prompt: string): DemandThought {
  const text = prompt.replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

  const needsDocsCatalog = /catalogue\s+d['']?api|liste\s+des\s+(?:method|méthodes|endpoints)|montre\s+la\s+doc|documentation\s+seule|search_docs\s+seulement/i.test(text)
    && !/execute|prix|price|volume|dashboard|cartes?|courbe|tableau\s+du\s+top/i.test(text);

  const needsLiveData = /prix|price|volume|capitalisation|variation|en\s+direct|dashboard|cartes?|kpi|metric|solana|bitcoin|btc|eth|token|crypto|march[eé]|market|ath|plus\s+haut|execute/i.test(lower)
    || /\b(issues?|commits?|pulls?|prs?|workflows?)\b/i.test(lower);

  const needsTimeSeries = /courbe|chart|historique|30\s*jours|7\s*jours|sparkline|série|serie|par\s+jour|par\s+semaine/i.test(lower);
  const needsRanking = /top\s*\d+|classement|ranking|par\s+capitalisation|les\s+\d+\s+(?:premiers|plus)/i.test(lower);

  const quoted = [...text.matchAll(/[«"]([^»"]{2,60})[»"]/g)].map((match) => match[1].trim());
  const dashboardName = quoted.find((label) => /en\s+direct|dashboard|pilotage|vue|board/i.test(label))
    || quoted.find((label) => !/coins?\s|market|chart|endpoint|method/i.test(label));
  const subject = (lower.match(/\b(solana|bitcoin|ethereum|btc|eth|sol)\b/i)?.[1])
    || dashboardName
    || (lower.match(/d[eé]p[oô]t\s+([a-z0-9_.-]+\/[a-z0-9_.-]+)/i)?.[1])
    || (lower.match(/mcp\s+([a-z0-9_-]+)/i)?.[1])
    || quoted[0]
    || 'la demande';

  const uiParts: string[] = [];
  if (/\b4\s*cartes?\b|metric|kpi|en\s+haut/i.test(lower)) uiParts.push('4 cartes KPI');
  if (needsTimeSeries) uiParts.push('courbe temporelle');
  if (needsRanking || /tableau/i.test(lower)) uiParts.push('tableau / top');
  if (/heure|mise\s+[aà]\s+jour|timestamp/i.test(lower)) uiParts.push('horodatage');
  if (!uiParts.length) uiParts.push(needsDocsCatalog ? 'catalogue de méthodes' : 'écran branché sur les données métier');

  const expectedFields: string[] = [];
  if (needsLiveData && !needsDocsCatalog) {
    if (/prix|price/i.test(lower)) expectedFields.push('price');
    if (/variation|change|24\s*h/i.test(lower)) expectedFields.push('change_24h');
    if (/volume/i.test(lower)) expectedFields.push('volume');
    if (/capitalisation|market\s*cap/i.test(lower)) expectedFields.push('market_cap');
    if (needsTimeSeries) expectedFields.push('date', 'price');
    if (needsRanking) expectedFields.push('name', 'market_cap');
    if (!expectedFields.length) expectedFields.push('champs métier (pas method/summary/endpoint)');
  } else if (needsDocsCatalog) {
    expectedFields.push('method', 'endpoint', 'summary');
  } else {
    expectedFields.push('champs renvoyés par la lecture métier');
  }

  const steps = [
    `1. Sujet : l’utilisateur parle de « ${subject} ».`,
    `2. Écran attendu : ${uiParts.join(' + ')}.`,
    needsDocsCatalog
      ? '3. Nature des données : catalogue / documentation d’API.'
      : needsLiveData
      ? '3. Nature des données : données métier / live (mesures, listes opérationnelles) — search_docs ne sert qu’à découvrir les méthodes SDK.'
      : '3. Nature des données : lecture métier adaptée au domaine.',
    `4. Champs utiles à l’UI : ${expectedFields.join(', ')}.`,
    needsTimeSeries ? '5. Une série temporelle est exigée (courbe), pas une répartition de libellés de doc.' : '5. Vérifier que chaque bloc UI a une colonne source dans les lignes lues.',
    '6. Décision : n’accepter que si les lignes observées peuvent nourrir cet écran sans inventer de champs.',
  ];

  return {
    subject: String(subject),
    ui: uiParts.join(' + '),
    needsLiveData: needsLiveData && !needsDocsCatalog,
    needsDocsCatalog,
    needsTimeSeries,
    needsRanking,
    expectedFields,
    steps,
  };
}

/** Doc API alors que l’UI demande des données live / métier. */
export function docsMismatchIntent(thought: DemandThought, fields: string[]): boolean {
  if (thought.needsDocsCatalog) return false;
  if (!thought.needsLiveData && !thought.needsTimeSeries && !thought.needsRanking) {
    // Même sans mot « prix » : un dashboard « en direct » + champs purement doc = non.
    if (!/dashboard|en\s+direct|cartes?|courbe|tableau/i.test(thought.ui)) return false;
  }
  if (!fields.length) return thought.needsLiveData;
  return fieldsLookLikeDocs(fields) && !fieldsLookLikeMetrics(fields);
}

function sampleScore(rows: Array<Record<string, unknown>>): number {
  const keys = rows[0] ? Object.keys(rows[0]) : [];
  if (keys.some((key) => METRIC_FIELD.test(key))) return 2;
  if (keys.every((key) => DOC_FIELD.test(key))) return 0;
  return 1;
}

function samplesOf(reads: OwnerRead[]): OwnerSample[] {
  return reads
    .filter((read) => read.ok && read.rows.length)
    .sort((a, b) => sampleScore(b.rows) - sampleScore(a.rows))
    .slice(0, 3)
    .map((read) => ({
      tool: read.tool,
      args: read.args,
      rows: keepSpan(read.rows, 240).map((row) => {
        const clipped: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row).slice(0, 12)) clipped[key] = typeof value === 'string' && value.length > 180 ? value.slice(0, 180) : value;
        return clipped;
      }),
    }));
}

function proofOf(reads: OwnerRead[]): ChainProof {
  const args: Record<string, unknown> = {};
  const values: unknown[] = [];
  const docs: string[] = [];
  for (const read of reads) {
    Object.assign(args, read.args);
    if (typeof read.args.code === 'string') docs.push(read.args.code);
    for (const row of read.rows) {
      const keys = Object.keys(row);
      const doc = keys.length > 0 && keys.every((key) => /^(method|endpoint|summary|description|params|response|query|language|path|url)$/i.test(key));
      if (doc) docs.push(Object.values(row).map((value) => String(value)).join(' '));
      else for (const value of Object.values(row)) if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') values.push(value);
    }
  }
  return { args, values, docs: docs.join('\n') };
}

function thoughtBlock(thought: DemandThought): string {
  return ['Product Owner — chaîne de pensée :', ...thought.steps].join('\n');
}

/**
 * Verdict du Product Owner sur les lectures, avant toute construction.
 * Rejette un mauvais serveur, un serveur exclu, ou une doc alors que la demande veut du live.
 */
export function reviewSource(
  prompt: string,
  tools: SourceTool[],
  reads: OwnerRead[],
): OwnerVerdict {
  const thought = thinkAboutDemand(prompt);
  const thinking = thoughtBlock(thought);
  const { use, skip } = mentionedServers(prompt, tools);
  const kept = keepNamedServer(prompt, tools, reads);
  const okReads = kept.filter((read) => read.ok && read.rows.length);
  const fields = fieldsOf(okReads);
  const samples = samplesOf(okReads);

  const linkDown = kept.filter((read) => {
    if (read.ok) return false;
    if (read.diagnostic === 'transport' || read.diagnostic === 'session' || read.diagnostic === 'availability') return true;
    const kind = classifyLink(read.error ?? '');
    return kind.obstacle === 'transport' || kind.obstacle === 'session' || kind.obstacle === 'availability';
  });
  if (!okReads.length && linkDown.length) {
    const detail = linkDown.map((read) => read.error).filter(Boolean).join(' ; ');
    const text = [
      thinking,
      '',
      'Product Owner : la liaison est interrompue. Ce n’est pas une absence de données.',
      detail,
      'La reprise reste autorisée.',
    ].filter(Boolean).join('\n');
    return { ok: false, text, brief: text, samples: [], thought, missing: ['liaison'], retryable: true };
  }

  if (use.length && !okReads.length) {
    const text = [
      thinking,
      '',
      'Product Owner : aucune lecture du serveur demandé.',
      `Serveur attendu : ${use.join(', ')}.`,
      skip.length ? `Serveur écarté : ${skip.join(', ')}.` : '',
      'Rien ne peut être généré tant que ce serveur ne renvoie pas de lignes.',
    ].filter(Boolean).join('\n');
    return { ok: false, text, brief: text, samples: [], thought, missing: ['lecture du serveur demandé'], retryable: false };
  }

  const wrong = okReads.filter((read) => {
    const server = serverOf(read.tool);
    if (skip.includes(server)) return true;
    if (use.length && server && !use.includes(server)) return true;
    return false;
  });
  if (wrong.length) {
    const text = [
      thinking,
      '',
      'Product Owner : les lectures ne respectent pas la demande.',
      `Outils refusés : ${wrong.map((read) => read.tool).join(', ')}.`,
      use.length ? `Serveur attendu : ${use.join(', ')}.` : '',
      skip.length ? `Serveur exclu : ${skip.join(', ')}.` : '',
      'Rien ne peut être généré avec ces lectures.',
    ].filter(Boolean).join('\n');
    return { ok: false, text, brief: text, samples: [], thought, missing: ['lecture hors demande'], retryable: false };
  }

  if (!okReads.length) {
    const text = [thinking, '', 'Product Owner : aucune ligne exploitable. Rien ne peut être généré.', 'Acquisitions manquantes : lecture métier.', 'Elles retournent au sourcing avant un refus définitif.'].join('\n');
    return { ok: false, text, brief: text, samples: [], thought, missing: ['lecture métier'], retryable: true };
  }

  const needles = claimsFromPrompt(prompt).filter((claim) => claim.kind === 'entite' || claim.kind === 'filtre').map((claim) => claim.text);
  const hits = okReads.filter((read) => read.rows.some((row) => !Object.keys(row).every((key) => /^(method|endpoint|summary|description|params|response|query|language|path|url)$/i.test(key)))).flatMap((read) => hitsInRows(read.rows, needles, read.tool));
  const proof: ChainProof = { ...proofOf(okReads), hits };
  const chain = linkChain(prompt, fields, proof);
  if (docsMismatchIntent(thought, fields) || !chain.ok) {
    const missing = chain.missing.length ? chain.missing : thought.expectedFields;
    const acquired = chain.links.filter((link) => {
      const claim = chain.claims.find((item) => item.id === link.claim);
      return link.state === 'tenu' && claim && !['meta', 'vue', 'action', 'operation'].includes(claim.kind);
    }).map((link) => link.text);
    const kinds = chain.claims.filter((claim) => missing.includes(claim.text)).map((claim) => claim.kind);
    const entityGap = kinds.length > 0 && kinds.every((kind) => kind === 'entite' || kind === 'filtre' || kind === 'champ');
    const text = [
      thinking,
      '',
      'Product Owner : écart intention / données.',
      docsMismatchIntent(thought, fields)
        ? `Champs observés : ${fields.join(', ') || '(aucun)'} — ce sont des métadonnées de documentation d’API.`
        : `Champs observés : ${fields.join(', ') || '(aucun)'} — ils ne témoignent pas de la demande.`,
      `L’utilisateur attend : ${thought.ui} sur « ${thought.subject} » (champs du type ${thought.expectedFields.join(', ')}).`,
      `Acquisitions manquantes : ${missing.join(' ; ')}.`,
      'Elles retournent au sourcing avant un refus définitif.',
      entityGap
        ? 'Une entité ou un filtre se cherche dans les valeurs des lignes déjà lues, ou dans un paramètre de recherche prévu pour cela. Un outil de validation ne les fournit pas.'
        : 'search_docs (ou équivalent) ne suffit pas : il faut une lecture métier (souvent execute / list / get) qui renvoie ces mesures.',
      globalShape(fields) ? 'Les champs observés décrivent un agrégat global, pas le périmètre demandé.' : '',
      'Interdit de poser un dashboard « répartition de method/summary ».',
      acquired.length
        ? `Données acquises : ${acquired.join(', ')}. Données manquantes : ${missing.join(', ')}. Une acquisition partielle reste disponible.`
        : 'Rien ne peut être généré tant que ces champs manquent.',
      '',
      chain.text,
    ].join('\n');
    return { ok: false, text, brief: text, samples: [], thought, missing, retryable: true };
  }

  const structure = [
    thinking,
    '',
    'Product Owner : lectures acceptées.',
    `Outils : ${okReads.map((read) => read.tool).join(', ')}.`,
    `Champs autorisés : ${chain.allowed.join(', ') || fields.join(', ')}.`,
    `Écran : ${thought.ui} — uniquement avec ces champs (sujet « ${thought.subject} »).`,
    'Interdit d’afficher un champ absent de cette liste. Interdit de remplacer des mesures par method/summary/endpoint.',
    '',
    chain.text,
  ].join('\n');

  return {
    ok: true,
    text: structure,
    brief: structure,
    samples,
    thought,
    missing: [],
    retryable: false,
  };
}
