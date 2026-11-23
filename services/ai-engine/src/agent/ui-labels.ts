/**
 * Libellés métier : l'analogie « console DJ » est un PRINCIPE DE CONCEPTION interne (live, simulation instantanée,
 * actions en un geste, comparaison réel/scénario, assistant qui recommande) — jamais un libellé visible.
 * Ce module : table de renommage DJ → métier, détection des libellés DJ dans le TEXTE VISIBLE d'un App.tsx
 * (texte JSX + chaînes affichables), et renommage ciblé (sans toucher aux identifiants ni au code dans ${…}).
 */

/** Termes DJ interdits dans le texte visible. */
export const DJ_TERM_RE = /\bco[- ]?dj\b|\bdj\b|\bmindset\b|\bvu[- ]?m[eè]tres?\b|\bknobs?\b|\bcrossfader\b|\bfaders?\b|\bmixer\b|\bpads?\b|\bdecks?\b|\bwaveform\b|\bcue\b|\bscènes?\s+vivantes?\b|\bconsole\s+live\b|\bprochain\s+mouvement\b|\bscènes?\b|🎧|🎛️?/i;

/** Table de renommage appliquée (ordre = du plus spécifique au plus général). [motif, remplacement, libellé de la table] */
export const BUSINESS_RENAMES: Array<[RegExp, string]> = [
  [/🎧\s*|🎛️?\s*/g, ''],
  [/\bMémoire personnelle\s*·\s*Scènes\b/gi, 'Vues enregistrées'],
  [/\bSuggestions Co-?DJ\b/gi, 'Recommandations de l’assistant'],
  [/\bCo-?DJ\s*·\s*prochain mouvement\b/gi, 'Assistant · recommandations'],
  [/\b(?:question|parler) au co-?DJ\b/gi, "$&"], // remplacé juste après (préserve le verbe)
  [/\bau co-?DJ\b/gi, 'à l’assistant'],
  [/\ble co-?DJ\b/gi, 'l’assistant'],
  [/\bdu co-?DJ\b/gi, 'de l’assistant'],
  [/\bCo-?DJ\b/g, 'Assistant'],
  [/\bco-?DJ\b/g, 'assistant'],
  [/\bQuel est le prochain mouvement recommandé/g, 'Quelle est la prochaine action recommandée'],
  [/\ble prochain mouvement\b/g, 'la prochaine action'],
  [/\bProchain mouvement\b/g, 'Prochaine action'],
  [/\bprochain mouvement suggéré/gi, 'recommandation suivante'],
  [/\bprochain mouvement recommandé/gi, 'prochaine action recommandée'],
  [/\bprochain mouvement\b/gi, 'prochaine action'],
  [/\bVU-?mètres\b/gi, 'Indicateurs clés'],
  [/\bKnobs\s*&\s*mixer\b/gi, 'Simulation'],
  [/\bKnobs\s*·\s*Simulation\b/gi, 'Simulation'],
  [/\bRéinitialiser les knobs\b/gi, 'Réinitialiser la simulation'],
  [/\bavec les knobs et le flux\b/gi, 'avec la simulation et les données'],
  [/\bles knobs\b/gi, 'les curseurs'],
  [/\bKnobs\b/g, 'Simulation'],
  [/\bknobs\b/g, 'curseurs'],
  [/\bknob\b/gi, 'curseur'],
  [/\bCrossfader réel ↔ scénario\b/gi, 'Comparer réel / scénario'],
  [/\bCrossfader\s*:/g, 'Comparaison :'],
  [/\bCrossfader\b/g, 'Comparer réel / scénario'],
  [/\bcrossfader\b/gi, 'comparaison'],
  [/\bMixer\b/g, 'Comparaison'],
  [/\bmixer\b/g, 'comparaison'],
  [/\bPads\s*&\s*raccourcis\b/gi, 'Actions rapides'],
  [/\bPads\b/g, 'Actions rapides'],
  [/\bLe pad\b/g, 'L’action'],
  [/\ble pad\b/g, 'l’action'],
  [/\bpads\b/gi, 'actions rapides'],
  [/\bpad\b/gi, 'action'],
  [/\bla console LIVE\b/g, 'l’actualisation en direct'],
  [/\bconsole LIVE\b/g, 'actualisation en direct'],
  [/\bConsole live\b/gi, 'Actualisation des données'],
  [/\bdecks\s*·\s*cadence\s*·\s*rafraîchir\b/gi, 'sources · cadence · actualisation'],
  [/\bDeck branché/gi, 'Source active'],
  [/\bBrancher\/couper les decks\b/gi, 'Activer/couper les sources'],
  [/\baucun deck alimenté\b/gi, 'aucune source alimentée'],
  [/\bDecks\b/g, 'Sources de données'],
  [/\bdecks\b/gi, 'sources'],
  [/\bdeck\b/gi, 'source'],
  [/\bCue \(rafraîchir\)/gi, 'Actualiser'],
  [/\bCue\b/g, 'Actualiser'],
  [/\bWaveform\b/g, 'Tendance'],
  [/\bwaveform\b/g, 'tendance'],
  [/\bScènes? vivantes?\b/gi, 'Visualisation animée'],
  [/\bSauver la scène\b/gi, 'Enregistrer la vue'],
  [/\bAucune scène sauvegardée\b/gi, 'Aucune vue enregistrée'],
  [/\bScène rappelée\b/g, 'Vue rappelée'],
  [/\bScènes\s*:/g, 'Vues :'],
  [/\bScènes\b/g, 'Vues enregistrées'],
  [/\bscènes\b/g, 'vues enregistrées'],
  [/\bScène\b/g, 'Vue'],
  [/\bla scène\b/g, 'la vue'],
  [/\bscène\b/g, 'vue'],
  [/\bMindset DJ\b/gi, ''],
  [/\bDJ\b/g, ''],
];
// « question au co-DJ » / « parler au co-DJ » sont couverts par « au co-DJ » → « à l'assistant ».

/** Table lisible (rapport / tests) : ancien libellé → nouveau. */
export const RENAME_TABLE: Array<[string, string]> = [
  ['Co-DJ / Prochain mouvement', 'Assistant / Recommandations'],
  ['VU-mètres', 'Indicateurs clés'],
  ['Knobs (· Simulation, & mixer)', 'Simulation'],
  ['Crossfader réel ↔ scénario', 'Comparer réel / scénario'],
  ['Pads & raccourcis', 'Actions rapides'],
  ['Decks / Console live', 'Sources de données / Actualisation des données'],
  ['Deck branché', 'Source active'],
  ['Cue', 'Actualiser'],
  ['Waveform', 'Tendance'],
  ['Scènes / Mémoire personnelle · Scènes', 'Vues enregistrées'],
  ['Sauver la scène', 'Enregistrer la vue'],
  ['Scène vivante', 'Visualisation animée'],
  ['Journal des actions', 'Journal des actions (inchangé)'],
];

/** Corrections grammaticales (aussi pour des apps déjà renommées par une version antérieure de la table). */
export const GRAMMAR_FIXES: Array<[RegExp, string]> = [
  [/\ble assistant\b/g, 'l’assistant'],
  [/\bLe assistant\b/g, 'L’assistant'],
  [/\bdu assistant\b/g, 'de l’assistant'],
  [/\bau assistant\b/g, 'à l’assistant'],
  [/\bla Actualisation des données\b/g, 'l’actualisation en direct'],
  [/\bQuel est le prochaine action recommandée/g, 'Quelle est la prochaine action recommandée'],
  [/\ble prochaine action\b/g, 'la prochaine action'],
  [/^(\s*)prochaine action \?/, '$1Prochaine action ?'],
];
const GRAMMAR_RE = /\b(?:le|Le|du|au) assistant\b|\bla Actualisation\b|\ble prochaine action\b|^\s*prochaine action \?/;
export const relabelText = (t: string) => GRAMMAR_FIXES.reduce((s, [re, to]) => s.replace(re, to), BUSINESS_RENAMES.reduce((s, [re, to]) => s.replace(re, to), t)).replace(/ {2,}/g, ' ');

type Span = { start: number; end: number; kind: 'jsx' | 'str' | 'tpl' };
const looksLikeClasses = (s: string) => /\s/.test(s) && s.trim().split(/\s+/).every((w) => /^[a-z0-9:\-\/\[\]\.%_!()#,]+$/.test(w)) && /-/.test(s);
const displayable = (s: string) => !!s.trim() && !s.startsWith('@/') && !s.startsWith('./') && !looksLikeClasses(s) && (/\s/.test(s.trim()) || /^[A-ZÀ-Ý🎧🎛]/u.test(s.trim()));

/** Repère les zones de texte VISIBLE : texte JSX, chaînes '…' "…" affichables, parties texte des templates `…${}…`. */
export function visibleSpans(code: string): Span[] {
  const spans: Span[] = [];
  const blank = code.split('');
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i], d = code[i + 1];
    if (c === '/' && d === '/') { const j = code.indexOf('\n', i); const e = j < 0 ? n : j; for (let k = i; k < e; k++) blank[k] = ' '; i = e; continue; }
    if (c === '/' && d === '*') { const j = code.indexOf('*/', i + 2); const e = j < 0 ? n : j + 2; for (let k = i; k < e; k++) if (blank[k] !== '\n') blank[k] = ' '; i = e; continue; }
    // Apostrophe dans du texte JSX (l'instant, d'échec) : jamais un début de chaîne après une lettre.
    if (c === "'" && i > 0 && /[A-Za-zÀ-ÿ]/.test(code[i - 1])) { i++; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1; while (j < n && code[j] !== c && code[j] !== '\n') { if (code[j] === '\\') j++; j++; }
      const inner = code.slice(i + 1, j);
      if (displayable(inner)) spans.push({ start: i + 1, end: j, kind: 'str' });
      for (let k = i; k <= j && k < n; k++) blank[k] = ' ';
      i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1; let segStart = j;
      const segs: Array<[number, number]> = [];
      while (j < n && code[j] !== '`') {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === '$' && code[j + 1] === '{') {
          segs.push([segStart, j]); let depth = 1; j += 2;
          while (j < n && depth) { if (code[j] === '{') depth++; else if (code[j] === '}') depth--; else if (code[j] === '`') { j++; while (j < n && code[j] !== '`') j++; } j++; }
          segStart = j; continue;
        }
        j++;
      }
      segs.push([segStart, j]);
      const whole = code.slice(i + 1, j);
      if (displayable(whole.replace(/\$\{[\s\S]*?\}/g, ' x '))) for (const [a, b] of segs) if (b > a) spans.push({ start: a, end: b, kind: 'tpl' });
      for (let k = i; k <= j && k < n; k++) if (blank[k] !== '\n') blank[k] = ' ';
      i = j + 1; continue;
    }
    i++;
  }
  // Texte JSX : entre > et < dans le code (chaînes et commentaires neutralisés), sans syntaxe de code.
  const flat = blank.join('');
  const re = /([>}])([^<>{}]+)(?=[<{])/g; let m: RegExpExecArray | null;
  while ((m = re.exec(flat))) {
    const t = m[2]; const after = flat[m.index + m[0].length];
    if (!/[A-Za-zÀ-ÿ]/.test(t) || /[;=&|]|\.\w|=>|\breturn\b|\bconst\b|\bif\b|\belse\b/.test(t)) continue;
    if (m[1] === '}' && (after !== '<' || /[()?:,]/.test(t))) continue; // `}texte<` seulement (texte après une expression JSX)
    if (m[1] === '>' && after === '{' && /[()]/.test(t) && !/\s\S+\s/.test(t)) continue;
    spans.push({ start: m.index + 1, end: m.index + 1 + t.length, kind: 'jsx' });
    re.lastIndex = m.index + m[0].length;
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** Libellés DJ trouvés dans le texte visible (pour la revue PO et les tests). */
export function findDjLabels(code: string): string[] {
  const out: string[] = [];
  for (const s of visibleSpans(code)) {
    const t = code.slice(s.start, s.end);
    const m = new RegExp(DJ_TERM_RE.source, 'giu');
    let k: RegExpExecArray | null;
    while ((k = m.exec(t))) out.push(`${k[0]} — « ${t.trim().slice(0, 60)} »`);
  }
  return out;
}

/** Renomme les libellés DJ du texte visible (identifiants, clés et code dans ${…} intacts). */
export function relabelVisible(code: string): { code: string; changed: number } {
  let changed = 0; let out = ''; let last = 0;
  for (const s of visibleSpans(code)) {
    if (s.start < last) continue;
    const t = code.slice(s.start, s.end);
    const r = DJ_TERM_RE.test(t) || GRAMMAR_RE.test(t) ? relabelText(t) : t;
    if (r !== t) changed++;
    out += code.slice(last, s.start) + r; last = s.end;
  }
  return { code: out + code.slice(last), changed };
}
