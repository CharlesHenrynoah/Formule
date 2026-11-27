/**
 * Serveurs MCP « code mode » (un outil qui exécute du code) : Formule n'envoie JAMAIS de code écrit par le modèle.
 * Il n'envoie que des GABARITS relus, fournis par un pack (packs/*.json → codeTemplates), dont les paramètres
 * sont tirés de la demande par dictionnaires et motifs, puis validés. Le cœur ne connaît aucun fournisseur.
 */
import { norm } from '../semantic/lexicon.js';
import { activePacks, type Pack } from '../packs.js';
import type { CatalogServer, CatalogTool } from './catalog.js';

export interface CodeAdapterMatch { args: Record<string, unknown>; template: string; params: Record<string, string | number> }
type CT = NonNullable<Pack['codeTemplates']>;

export function codeTemplatesFor(serverName: string, tool: CatalogTool, catalog?: CatalogServer[]): CT | null {
  const packs = catalog ? activePacks(catalog) : [];
  for (const p of packs) {
    const ct = p.codeTemplates;
    if (!ct || ct.tool !== tool.name) continue;
    if (p.appliesTo.server && !new RegExp(p.appliesTo.server, 'i').test(`${serverName} ${tool.description}`)) continue;
    if (!(tool.inputSchema?.required ?? []).includes(ct.argument)) continue;
    return ct;
  }
  return null;
}

/** Remplit {{p}}, {{p|upper}} et les blocs {{#p}}…{{/p}} (présents seulement si p est défini). */
function render(tpl: string, params: Record<string, string | number>): string {
  return tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, k, body) => (params[k] !== undefined ? body : ''))
    .replace(/\{\{(\w+)(\|upper)?\}\}/g, (_m, k, up) => { const v = String(params[k] ?? ''); return up ? v.toUpperCase() : v; });
}

export function matchCodeTemplate(ct: CT, prompt: string): CodeAdapterMatch | null {
  const t = norm(prompt);
  const words = t.split(/[^a-z0-9-]+/).filter(Boolean);
  const params: Record<string, string | number> = {};
  for (const [name, p] of Object.entries(ct.params)) {
    let v: string | number | undefined;
    if (p.dictionary) v = words.map((w) => ct.dictionaries[p.dictionary!]?.[w]).find(Boolean);
    if (v === undefined && p.numbers) for (const n of p.numbers) { const m = t.match(new RegExp(n.re)); if (m) { v = n.value ?? Number(m.slice(1).find((g) => g && /^\d+$/.test(g)) ?? NaN) * (n.mul ?? 1); if (Number.isNaN(v)) v = undefined; else break; } }
    if (v === undefined && p.default !== undefined) v = p.default;
    if (v === undefined) continue;
    if (typeof v === 'number') v = Math.min(p.max ?? v, Math.max(p.min ?? v, v));
    // validation stricte : une valeur hors motif n'entre jamais dans le code
    if (p.pattern && !new RegExp(p.pattern).test(String(v))) return null;
    params[name] = v;
  }
  // plusieurs entités du dictionnaire « coin » : un gabarit mono-entité (historique d'un seul id) ne suffit pas
  const coinDict = ct.dictionaries.coin ?? {};
  const coins = [...new Set(words.map((w) => coinDict[w]).filter(Boolean))];
  const tpl = ct.templates.find((x) => {
    if (coins.length > 1 && x.requires.includes('coin')) return false;
    return (!x.when || new RegExp(x.when).test(t)) && x.requires.every((r) => params[r] !== undefined);
  });
  if (!tpl) return null;
  const used = { ...params };
  if (coins.length > 1 && !tpl.requires.includes('coin')) delete used.coin;
  return { template: tpl.name, params: used, args: { [ct.argument]: render(tpl.code, used), intent: `Formule : ${render(tpl.intent, used)}` } };
}
