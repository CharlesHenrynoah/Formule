import { achromeSource } from './agent/theme-guard.ts';
import type { RuntimeTool } from './types.ts';

export const PLAN_SYSTEM = `Tu es l'architecte d'Everything Software. À partir d'une demande, tu écris un PLAN court (spécification) d'une mini-app web.
Format : un titre sur la 1re ligne commençant par "# ", puis 4 à 8 puces "- " (fonctionnalités, interface, données, interactions). Français, concis, pas de code.`;

export const PLAN_ITERATE_SYSTEM = `Tu es l'architecte d'Everything Software. On te donne une mini-app existante et une demande de modification.
Écris un PLAN court des changements : un titre "# " puis 2 à 6 puces "- ". Français, concis, pas de code.`;

export function runtimeToolsDoc(tools: RuntimeTool[]) {
  if (!tools.length) return "Aucun outil MCP n'est disponible à l'exécution : l'app doit être 100 % autonome.";
  return `Outils MCP disponibles À L'EXÉCUTION via le pont sécurisé injecté dans l'iframe :
  const data = await window.mcp.call('<id>', { ...arguments });   // renvoie le résultat JSON de l'outil (Promise)
  const liste = await window.mcp.tools();                          // liste des outils autorisés
Les outils marqués [écriture] déclenchent une confirmation de l'utilisateur ; gère le refus (Promise rejetée).
N'utilise un outil que s'il sert vraiment la demande. Prévois un message si window.mcp est absent.
${tools.map((t) => `- ${t.id}${t.write ? ' [écriture]' : ''} : ${t.description ?? ''} | arguments : ${JSON.stringify((t.inputSchema as { properties?: unknown })?.properties ?? {})}`).join('\n')}`;
}

export const CODE_RULES = `Règles de sortie :
- Réponds UNIQUEMENT avec un fichier HTML complet et autonome, de <!doctype html> à </html>, sans texte autour ni balises Markdown.
- CSS et JS inline. Bibliothèques externes autorisées seulement depuis unpkg.com, cdn.jsdelivr.net, cdnjs.cloudflare.com, cdn.tailwindcss.com ou esm.sh (React via CDN + Babel possible).
- Interface en français, noir et blanc, noir dominant : fond #111111, texte #f5f5f5, cartes #1c1c1c. Responsive, accessible. Pas de bleu, de vert, de jaune.
- GRAPHIQUE : l'hôte est un <canvas> avec une hauteur fixe (260px), jamais un div. new Chart reçoit ce canvas. Chaque série, dans cet ordre : #6eacd7, #79bb9e, #d5ba82, #9f8fbe. Les axes sont #8a8a8a, la grille au moins rgba(255,255,255,.2). Pas de trait de la couleur du fond. Pas de graphique sans points quand les lignes existent.
- Interdits : document.cookie, accès à window.top / window.parent (sauf via window.mcp), redirections, formulaires vers des sites externes, appels réseau vers des API tierces.
- localStorage autorisé pour persister l'état (avec try/catch).`;

export const codeSystem = (tools: RuntimeTool[]) =>
  `Tu es le moteur de génération d'Everything Software. Tu écris des mini-apps web fonctionnelles, interactives et soignées.\n${CODE_RULES}\n\n${runtimeToolsDoc(tools)}`;

export const TOOLS_SYSTEM = `Tu prépares la génération d'une mini-app. Tu peux appeler des outils MCP en lecture pour récupérer des données utiles à sa conception (exemples réels, formats, valeurs). Appelle au plus 3 outils, uniquement s'ils sont pertinents ; sinon réponds "aucun outil nécessaire".`;

export const FIX_SYSTEM = `Tu corriges une mini-app HTML générée par Everything Software. On te donne le code et les erreurs du validateur.
Corrige TOUTES les erreurs en changeant le moins possible.\n${CODE_RULES}`;

/** Extrait le document HTML d'une réponse de LLM (retire les blocs Markdown et le bavardage). */
export function extractHtml(raw: string): string {
  let s = raw.trim();
  const fence = /```(?:html)?\s*\n([\s\S]*?)(?:```|$)/i.exec(s);
  if (fence && !/^<!doctype|^<html/i.test(s)) s = fence[1].trim();
  const start = s.search(/<!doctype html|<html[\s>]/i);
  if (start > 0) s = s.slice(start);
  const end = s.toLowerCase().lastIndexOf('</html>');
  if (end >= 0) s = s.slice(0, end + 7);
  return repairChartHosts(achromeSource(s.trim()).code);
}

/** Chart.js ne dessine pas dans un div : l'hôte des new Chart devient un canvas. */
export function repairChartHosts(html: string): string {
  const ids = new Set<string>();
  for (const match of html.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (new RegExp(`new\\s+Chart\\(\\s*${match[1]}\\b`).test(html)) ids.add(match[2]);
  }
  for (const match of html.matchAll(/new\s+Chart\(\s*document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) ids.add(match[1]);
  let out = html;
  for (const id of ids) {
    const open = new RegExp(`<div(\\s[^>]*\\bid=["']${id}["'][^>]*)>`, 'i');
    if (!open.test(out)) continue;
    out = out.replace(open, '<canvas$1>');
    out = out.replace(new RegExp(`(<canvas\\s[^>]*\\bid=["']${id}["'][^>]*>)\\s*</div>`, 'i'), '$1</canvas>');
  }
  return out;
}

export const titleFromPlan = (plan: string, fallback: string) =>
  (/^#\s+(.+)$/m.exec(plan)?.[1] ?? fallback).trim().slice(0, 80);
