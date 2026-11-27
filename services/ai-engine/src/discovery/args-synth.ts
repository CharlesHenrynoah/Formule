/**
 * Synthèse d'arguments à partir du SCHÉMA de l'outil (générique, sans connaissance du fournisseur) :
 *  1. valeurs tirées de la demande : énumérations (avec synonymes FR→EN), nombres (« top 20 »), texte entre guillemets ;
 *  2. valeurs par défaut du schéma ;
 *  3. exemples publiés par le serveur dans la description de l'outil, validés contre le schéma, choisis selon l'intention ;
 *  4. proposition du LLM (si configuré), validée contre le schéma.
 * Rien n'est inventé : si un argument obligatoire reste inconnu, il est nommé.
 */
import { norm } from '../semantic/lexicon.js';

type Schema = { type?: string | string[]; enum?: unknown[]; items?: Schema; properties?: Record<string, Schema>; required?: string[]; default?: unknown; minimum?: number; maximum?: number; minItems?: number; maxItems?: number; description?: string; anyOf?: Schema[]; const?: unknown };

/** Vocabulaire FR → jetons EN fréquents dans les schémas MCP. */
const SYN: [RegExp, string[]][] = [
  [/\bmodeles?\b|\bmodels?\b|\bllm\b/, ['model', 'models']],
  [/\bdatasets?\b|jeux? de donnees/, ['dataset', 'datasets']],
  [/\bspaces?\b|\bapplications?\b|\bapps?\b|demos?/, ['space', 'spaces']],
  [/tendances?|trending|en vogue|populaires? du moment/, ['trending', 'trendingscore']],
  [/telechargements?|downloads?/, ['downloads']],
  [/\blikes?\b|aimes?|favoris/, ['likes']],
  [/populaires?/, ['downloads', 'likes']],
  [/recent(e|es|s)?|dernier(e|es|s)?|nouveaux?|nouvelles?|latest/, ['latest', 'recent', 'createdat', 'daily', 'new']],
  [/publications?|articles?|papiers?|papers?|recherche scientifique|research/, ['paper', 'papers']],
  [/quotidien(ne)?s?|du jour|daily/, ['daily']],
  [/serveurs? mcp|mcp/, ['mcp', 'mcp-server']],
  [/collections?/, ['collection', 'collections']],
  [/modifi(e|es|cation)s?/, ['lastmodified']],
  [/auteurs?|organisations?/, ['author']],
];

export function intentTokens(text: string): { tokens: Set<string>; pos: Map<string, number> } {
  const t = norm(text);
  const tokens = new Set(t.split(/[^a-z0-9-]+/).filter((w) => w.length > 1));
  const pos = new Map<string, number>();
  for (const [re, en] of SYN) {
    const m = re.exec(t);
    if (m) for (const e of en) { tokens.add(e); if (!pos.has(e) || pos.get(e)! > m.index) pos.set(e, m.index); }
  }
  for (const w of tokens) if (!pos.has(w)) pos.set(w, t.indexOf(w));
  return { tokens, pos };
}

const parts = (v: string) => norm(v.replace(/([a-z])([A-Z])/g, '$1 $2')).split(/[^a-z0-9]+/).filter(Boolean);
const joined = (v: string) => norm(v).replace(/[^a-z0-9-]/g, '');

/** Meilleure valeur d'énumération : présente dans l'intention, la plus tôt citée. */
function pickEnum(values: unknown[], it: ReturnType<typeof intentTokens>, many: boolean): unknown[] {
  const scored = values.map((v) => {
    const s = String(v);
    const cands = [joined(s), ...parts(s)];
    const hits = cands.filter((c) => it.tokens.has(c));
    const p = Math.min(...hits.map((h) => it.pos.get(h) ?? 1e9));
    return { v, hit: hits.length > 0 && (hits.includes(joined(s)) || hits.length >= Math.ceil(parts(s).length / 2)), p };
  }).filter((x) => x.hit).sort((a, b) => a.p - b.p);
  return many ? scored.map((x) => x.v) : scored.slice(0, 1).map((x) => x.v);
}

function typeOf(s: Schema): string | undefined { return Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type ?? (s.anyOf?.find((x) => x.type && x.type !== 'null')?.type as string | undefined); }

/** Validation légère JSON Schema (types, enum, required, bornes) — suffisante pour refuser une proposition hors contrat. */
export function validate(v: unknown, s: Schema, path = '$'): string[] {
  const errs: string[] = [];
  const t = typeOf(s);
  if (s.const !== undefined && v !== s.const) errs.push(`${path} ≠ const`);
  if (s.enum && !s.enum.includes(v)) errs.push(`${path} hors énumération`);
  if (t === 'object' || s.properties) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return [`${path} : objet attendu`];
    for (const r of s.required ?? []) if ((v as Record<string, unknown>)[r] === undefined) errs.push(`${path}.${r} manquant`);
    for (const [k, sub] of Object.entries(s.properties ?? {})) { const x = (v as Record<string, unknown>)[k]; if (x !== undefined) errs.push(...validate(x, sub, `${path}.${k}`)); }
  } else if (t === 'array') {
    if (!Array.isArray(v)) return [`${path} : tableau attendu`];
    if (s.minItems !== undefined && v.length < s.minItems) errs.push(`${path} : trop court`);
    if (s.maxItems !== undefined && v.length > s.maxItems) errs.push(`${path} : trop long`);
    if (s.items) v.forEach((x, i) => errs.push(...validate(x, s.items!, `${path}[${i}]`)));
  } else if (t === 'number' || t === 'integer') {
    if (typeof v !== 'number' || !Number.isFinite(v)) errs.push(`${path} : nombre attendu`);
    else { if (s.minimum !== undefined && v < s.minimum) errs.push(`${path} < min`); if (s.maximum !== undefined && v > s.maximum) errs.push(`${path} > max`); }
  } else if (t === 'string' && typeof v !== 'string') errs.push(`${path} : texte attendu`);
  else if (t === 'boolean' && typeof v !== 'boolean') errs.push(`${path} : booléen attendu`);
  return errs;
}

/** Objets JSON présents dans la description (exemples publiés par le serveur). */
export function descriptionExamples(desc: string, schema: Schema): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = desc.indexOf('{'); i >= 0; i = desc.indexOf('{', i + 1)) {
    let depth = 0;
    for (let j = i; j < desc.length; j++) {
      if (desc[j] === '{') depth++;
      else if (desc[j] === '}' && --depth === 0) {
        try { const o = JSON.parse(desc.slice(i, j + 1)); if (o && typeof o === 'object' && !Array.isArray(o) && validate(o, schema).length === 0 && !out.some((x) => JSON.stringify(x) === JSON.stringify(o))) out.push(o); } catch { /* pas un exemple JSON */ }
        break;
      }
    }
  }
  return out;
}

export interface Synth { args: Record<string, unknown>; missing: string[]; how: string[] }

export function synthesizeFromSchema(schema: Schema, description: string, text: string): Synth {
  const it = intentTokens(text);
  const props = schema.properties ?? {};
  const required = schema.required ?? [];
  const args: Record<string, unknown> = {}; const how: string[] = [];
  const quoted = [...text.matchAll(/[«"“]\s*([^»"”]+?)\s*[»"”]/g)].map((m) => m[1]);
  const topN = norm(text).match(/\btop\s*(\d{1,3})\b|\b(\d{1,3})\s*(premiers?|premieres?|derniers?|dernieres?|plus|meilleurs?)\b/);
  for (const [k, p] of Object.entries(props)) {
    const t = typeOf(p);
    const items = p.items ?? {};
    if (p.enum) { const v = pickEnum(p.enum, it, false); if (v.length) { args[k] = v[0]; how.push(`${k} ← demande`); } }
    else if (t === 'array' && items.enum) { const v = pickEnum(items.enum, it, true).slice(0, p.maxItems ?? 99); if (v.length) { args[k] = v; how.push(`${k} ← demande`); } }
    else if ((t === 'number' || t === 'integer') && topN && /limit|max|count|top|size|n$|per_page|number/.test(k.toLowerCase())) {
      const n = Number(topN[1] ?? topN[2]);
      args[k] = Math.min(p.maximum ?? n, Math.max(p.minimum ?? n, n)); how.push(`${k} ← « top ${n} »`);
    } else if (t === 'string' && quoted.length && /query|search|q$|term|name|location|topic/.test(k.toLowerCase())) { args[k] = quoted.shift(); how.push(`${k} ← guillemets`); }
  }
  for (const r of required) if (args[r] === undefined && props[r]?.default !== undefined) { args[r] = props[r].default; how.push(`${r} ← défaut du schéma`); }
  let missing = required.filter((r) => args[r] === undefined);
  // exemples publiés par le serveur : seulement s'il manque encore un argument obligatoire
  if (missing.length) {
    const ex = descriptionExamples(description, schema);
    const best = ex.map((e) => {
      const toks = new Set(norm(JSON.stringify(e)).split(/[^a-z0-9-]+/).filter((w) => w.length > 1));
      // un exemple qui cite un identifiant précis absent de la demande (org/nom, 2501.00001) n'est pas une intention
      const strings: string[] = []; JSON.stringify(e, (_k, v) => { if (typeof v === 'string') strings.push(v); return v; });
      const specific = strings.filter((v) => (/\d{4}\.\d{4,5}/.test(v) || (!/^[a-z]+:\/\//i.test(v) && /^[\w-]+\/[\w.-]+$/.test(v))) && !norm(text).includes(norm(v)));
      return { e, s: [...toks].filter((w) => it.tokens.has(w)).length - specific.length * 3, specific: specific.length };
    }).sort((a, b) => b.s - a.s)[0];
    if (best && best.specific === 0 && (best.s > 0 || ex.length === 1)) {
      let ex = best.e;
      if (topN) { const n = String(topN[1] ?? topN[2]); ex = JSON.parse(JSON.stringify(ex).replace(/"--limit","\d+"/g, `"--limit","${n}"`)); }
      for (const [k, v] of Object.entries(ex)) if (args[k] === undefined) args[k] = v;
      how.push(`exemple publié par le serveur : ${JSON.stringify(best.e).slice(0, 120)}`);
      missing = required.filter((r) => args[r] === undefined);
    }
  }
  const errs = validate(args, schema).filter((e) => !missing.some((m) => e === `$.${m} manquant`));
  if (errs.length) return { args, missing: [...new Set([...missing, ...errs])], how };
  return { args, missing, how };
}
