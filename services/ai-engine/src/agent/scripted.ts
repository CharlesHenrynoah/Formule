/**
 * Équipe SCRIPTÉE (mode démo, sans clé) : mêmes rôles, mêmes outils RÉELS (MCP en lecture, CLI shadcn,
 * écriture de fichiers, vite build), mais décisions déterministes au lieu d'un LLM.
 * Astuce : ajoutez « [revue] » au prompt pour voir le PO renvoyer une première version au Développeur.
 */
import type { McpClient } from '../mcp.ts';
import { appPlan, applyIteration, genericTitle, pickApp, appHtml } from '../mock/catalog.ts';
import { Toolbox } from './toolbox.ts';
import { ROLE_LABEL, importsOf, inferSchema, profileDatasets, type AgentEvent, type AgentRole } from './events.ts';
import { Workspace } from './workspace.ts';
import { coherenceCriteria, specTitle, type AppBundle, type CrewInput } from './crew.ts';
import { readFileSync } from 'node:fs';
import { buildAgentDef, parseContract, type Contract } from '../../../../packages/app-mcp/src/core.mjs';

/** App démo complète (front + backend MCP + agent co-DJ) : « Console ventes » — monitoring live, simulation, actions. */
const SMART_DIR = new URL('../mock/smart/', import.meta.url);
export const MONITORING_RE = /ventes?|monitoring|surveill|suivi|tableau de bord|dashboard|kpi|console|trafic|[ée]nergie|simulation|what-?if/i;
const smartMonitoring = () => ({
  spec: readFileSync(new URL('monitoring.spec.md', SMART_DIR), 'utf8').trim(),
  tools: readFileSync(new URL('monitoring.tools.ts', SMART_DIR), 'utf8'),
  app: readFileSync(new URL('monitoring.App.tsx', SMART_DIR), 'utf8'),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DELAY = Number(process.env.MOCK_DELAY_MS ?? 8);

async function streamText(text: string, emit: (e: Record<string, unknown>) => void) {
  for (let i = 0; i < text.length; i += 12) { emit({ type: 'plan_delta', text: text.slice(i, i + 12) }); if (DELAY) await sleep(DELAY); }
}

/** Convertit une app démo (HTML + <script type="text/jsx">) en src/App.tsx de workspace. */
function appSource(html: string) {
  const jsx = /<script type="text\/jsx">([\s\S]*?)<\/script>/i.exec(html)?.[1]?.trim() ?? 'export default function App() { return null; }';
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? 'Mini-app';
  const usesToast = /from 'sonner'/.test(jsx);
  return { app: jsx + '\n', title, usesToast };
}

const MAIN_WITH_TOASTER = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <App />
      <Toaster theme="dark" position="bottom-right" />
    </TooltipProvider>
  </StrictMode>,
);
`;

function briefFrom(samples: Array<{ tool: string; args: unknown; result: unknown }>, toolsDesc: Array<{ id: string; ecriture: boolean; description: string }>) {
  const s = samples[0];
  const schema = inferSchema(s.result).slice(0, 14);
  const arrays = schema.filter((f) => f.type.startsWith('array'));
  const writes = toolsDesc.filter((t) => t.ecriture);
  return `## Sources utiles
${samples.map((x) => `- \`${x.tool}\` (lecture) — échantillonné avec ${JSON.stringify(x.args)}`).join('\n')}
${writes.map((t) => `- \`${t.id}\` (**écriture**, confirmation utilisateur) — ${t.description}`).join('\n')}

## Schéma des données
| champ | type | exemple |
|---|---|---|
${schema.map((f) => `| ${f.champ} | ${f.type} | ${f.exemple.replace(/\|/g, '/')} |`).join('\n')}

## Volumes et relations
- 1 objet par appel${arrays.length ? ` ; ${arrays.map((a) => `\`${a.champ}\` = ${a.type}`).join(', ')}` : ''}
- Clé de rattachement : le paramètre d'entrée (${Object.keys((s.args as object) ?? {}).join(', ') || '—'})

## Contraintes
- Pas de pagination ; données simulées par le serveur de démo (champ \`source\`)
- Quota du pont : 60 appels/min ; les outils en écriture exigent la confirmation de l'utilisateur
- Prévoir l'absence de \`window.mcp\` (app ouverte hors du studio)

## Fenêtre et disponibilité
| vue | période demandée | période couverte | lignes | décision |
|---|---|---|---|---|
| échantillon ${s.tool} | fenêtre de l'appel | observée dans l'échantillon | présente | afficher |
Omettre toute vue sans ligne. Disponible : ${s.tool}. À ne pas afficher : séries absentes de l'échantillon.

## Recommandations d'usage
- À l'exécution : \`await window.mcp.call('${s.tool}', ${JSON.stringify(s.args)})\` au chargement puis à chaque recherche
${writes[0] ? `- Sauvegarde : \`window.mcp.call('${writes[0].id}', { text })\` derrière un bouton explicite, gérer le refus` : ''}
- Afficher un Skeleton pendant le chargement, une Alert en cas d'erreur`;
}

export async function runScriptedCrew(input: CrewInput, ctx: { mcp?: McpClient; emit: (e: AgentEvent | Record<string, unknown>) => void; signal?: AbortSignal }) {
  const emit = ctx.emit as (e: AgentEvent) => void;
  const t0 = Date.now();
  const prompt = input.prompt.replace(/\[revue\]/gi, '').trim();
  const reviewDemo = /\[revue\]/i.test(input.prompt);
  const ws = await Workspace.create({ files: input.previous?.files, components: input.previous?.components });
  const tb = new Toolbox(ws, input.useTools === false ? undefined : ctx.mcp, emit);
  const role = (r: AgentRole, iteration?: number) => emit({ type: 'agent', kind: 'role', role: r, label: ROLE_LABEL[r], iteration });
  const app = pickApp(prompt);

  // 1) Data Engineer : exploration réelle des outils MCP
  role('data');
  let brief = 'Aucune source MCP pertinente : aucun serveur MCP connecté ou aucun outil autorisé.';
  if (tb.mcp) {
    const tools = await tb.listMcpTools('data');
    const weather = tools.find((t) => /__get_weather$/.test(t.id));
    const notes = tools.find((t) => /__list_notes$/.test(t.id));
    const time = tools.find((t) => /__get_time$/.test(t.id));
    const metrics = tools.find((t) => /__get_metrics$/.test(t.id));
    const samples: Array<{ tool: string; args: unknown; result: unknown }> = [];
    const city = /(?:\s[àa]|pour|de|sur)\s+([A-ZÉÈ][\p{L}\-' ]+)/u.exec(prompt)?.[1]?.trim() ?? 'Paris';
    try {
      if (metrics && MONITORING_RE.test(prompt)) {
        const source = /trafic/i.test(prompt) ? 'trafic' : /[ée]nergie/i.test(prompt) ? 'energie' : 'ventes';
        samples.push({ tool: metrics.id, args: { source, days: 30 }, result: await tb.sampleMcp('data', metrics.id, { source, days: 30 }) });
      }
      if (weather && /m[ée]t[ée]o|weather|temp[ée]rature|pr[ée]vision/i.test(prompt)) samples.push({ tool: weather.id, args: { city }, result: await tb.sampleMcp('data', weather.id, { city }) });
      if (notes && /note|m[ée]mo/i.test(prompt)) samples.push({ tool: notes.id, args: {}, result: await tb.sampleMcp('data', notes.id, {}) });
      if (time && /heure|horloge|fuseau/i.test(prompt)) samples.push({ tool: time.id, args: { timezone: 'Europe/Paris' }, result: await tb.sampleMcp('data', time.id, { timezone: 'Europe/Paris' }) });
    } catch { /* l'échec d'un échantillon n'arrête pas la chaîne */ }
    brief = samples.length
      ? briefFrom(samples, tools)
      : `Aucune source MCP pertinente : ${tools.length} outil(s) disponibles (${tools.map((t) => t.id).join(', ')}) mais aucun ne sert « ${prompt.slice(0, 60)} ».`;
  }
  const profile = profileDatasets(input.datasets);
  if (profile) brief = /^aucune source mcp pertinente/i.test(brief) ? profile : `${brief}\n\n${profile}`;
  const relevant = !/^aucune source mcp pertinente/i.test(brief);
  emit({ type: 'agent', kind: 'brief', role: 'data', text: brief, relevant });

  // 2) Product Owner : mini-spec
  role('po');
  ctx.emit({ type: 'phase', phase: 'plan', label: 'Product Owner : spécification' });
  const smart = !input.previous?.files && MONITORING_RE.test(prompt) ? smartMonitoring() : null;
  const html = input.previous?.files || smart ? '' : appHtml(app, prompt);
  const src = input.previous?.files ? null : smart ? { app: smart.app, title: specTitle(smart.spec, 'Console ventes'), usesToast: true } : appSource(html);
  let contract: Contract | null = smart ? parseContract(smart.spec) : (input.previous?.contract ?? null);
  const comps = smart ? [...new Set([...importsOf(smart.app), 'sonner', 'tooltip'])] : src ? [...new Set([...importsOf(src.app), 'sonner', 'tooltip'])] : (input.previous?.components ?? []);
  const plan = input.previous?.files ? `# Évolution de l'app\n- ${prompt}` : appPlan(app, prompt);
  const title = /^#\s+(.+)$/m.exec(plan)?.[1] ?? genericTitle(prompt);
  const bullets = plan.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  const spec = smart ? smart.spec : input.previous?.files && contract ? `${input.previous.spec ?? `# ${title}`}\n\n<!-- itération : ${prompt.replace(/-->/g, '')} -->` : `# ${title}
## User stories
${bullets.slice(0, 4).map((b) => `- En tant qu'utilisateur, je veux ${b.charAt(0).toLowerCase() + b.slice(1)}`).join('\n')}
## Critères d'acceptation
${bullets.map((b, i) => `- CA${i + 1} : ${b}`).join('\n')}
- CA${bullets.length + 1} : interface en français, composants shadcn/ui, build vert
## Écrans
- Écran principal « ${title} » (carte centrée, responsive)
## Composants shadcn
${comps.join(', ') || 'button'}
## Contrat de données
${relevant ? brief.split('## Recommandations d\'usage')[1]?.trim() ?? 'voir brief' : 'aucun'}`;
  await streamText(spec, ctx.emit);
  ctx.emit({ type: 'plan_done', plan: spec });
  emit({ type: 'agent', kind: 'spec', role: 'po', text: spec, components: comps });
  if (contract) emit({ type: 'agent', kind: 'contract', role: 'po', contract, ok: true });

  // 3) Développeur ↔ revue
  const reviews: Array<{ iteration: number; verdict: string; remarks: string[] }> = [];
  let iteration = 0;
  for (;;) {
    iteration++;
    role('dev', iteration);
    ctx.emit({ type: 'phase', phase: 'code', label: iteration === 1 ? 'Développeur : construction' : `Développeur : reprise n°${iteration - 1}` });
    if (comps.length) await tb.shadcnAdd(comps);
    if (src) {
      let code = src.app;
      const w = tb.mcpSamples.find((x) => /get_weather/.test(x.tool))?.result as { ville?: string } | undefined;
      if (w?.ville) { const v = w.ville.replace(/['"<>\\{}]/g, ''); code = code.replace("useState('Paris')", `useState('${v}')`).replace("load('Paris');", `load('${v}');`); }
      if (reviewDemo && iteration === 1) code = code.replace(/(<(CardTitle|h1)\b[^>]*>)((?:<[A-Z]\w*[^>]*\/>)?)[^<{]*(<\/\2>)/, '$1$3Mini-app$4'); // oubli volontaire
      if (smart && iteration === 1) { await tb.writeFile('server/tools.ts', smart.tools); await tb.testBackend('dev', contract); }
      await tb.writeFile('src/App.tsx', code);
      if (iteration === 1) await tb.writeFile('src/main.tsx', MAIN_WITH_TOASTER);
      if (iteration === 1) { const idx = await tb.readFile('dev', 'index.html'); await tb.writeFile('index.html', idx.replace(/<title>[\s\S]*?<\/title>/, `<title>${src.title}</title>`)); }
    } else {
      // Itération : modification des fichiers existants
      const idx = await tb.readFile('dev', 'index.html');
      const itIdx = applyIteration(idx, prompt);
      await tb.writeFile('index.html', itIdx.code);
      const appCode = await tb.readFile('dev', 'src/App.tsx');
      const itApp = applyIteration(`<html><head></head><body>${appCode}</body></html>`, /titre/i.test(prompt) ? prompt : '');
      const newApp = itApp.code.replace(/^<html><head>(<style[\s\S]*?<\/style>\n)?<\/head><body>/, '').replace(/(<div data-iteration[\s\S]*?<\/div>\n)?<\/body><\/html>$/, '');
      if (newApp !== appCode) await tb.writeFile('src/App.tsx', newApp);
      emit({ type: 'agent', kind: 'message', role: 'dev', text: `Modifications : ${itIdx.changes.join(', ')}` });
    }
    await tb.build();
    if (contract) await tb.testBackend('po', contract);
    if (DELAY) await sleep(DELAY * 10);
    if (iteration > 2) break;
    role('po', iteration);
    ctx.emit({ type: 'phase', phase: 'validate', label: `Product Owner : revue n°${iteration}` });
    const appCode = ws.files.get('src/App.tsx') ?? (await tb.readFile('po', 'src/App.tsx'));
    const used = importsOf(appCode);
    const criteria = [
      { id: 'CA1', ok: !!tb.lastBuild?.ok, note: tb.lastBuild?.ok ? 'build vert' : 'build en échec' },
      { id: 'CA2', ok: used.every((c) => ws.components.has(c)), note: `composants : ${used.join(', ')}` },
      { id: 'CA3', ok: !(src && />Mini-app</.test(appCode)), note: src && />Mini-app</.test(appCode) ? `titre générique au lieu de « ${title} »` : 'titre conforme' },
      { id: 'CA4', ok: !relevant || /(mcp|app)\.call\(/.test(appCode) || !src, note: relevant ? 'données via window.mcp.call / window.app.call' : 'pas de données externes' },
    ];
    if (contract) criteria.push(...coherenceCriteria(contract, appCode, tb.lastBackendTest));
    const verdict = criteria.every((c) => c.ok) ? 'ok' : 'a_corriger';
    const remarks = criteria.filter((c) => !c.ok).map((c) => `${c.id} : ${c.note}`);
    emit({ type: 'agent', kind: 'review', role: 'po', iteration, verdict, criteria, remarks });
    reviews.push({ iteration, verdict, remarks });
    if (verdict === 'ok') break;
  }
  if (!tb.lastBuild?.ok || !tb.lastBuild.html) throw new Error(`Build en échec : ${tb.lastBuild?.output.slice(-600)}`);
  let appBundle: AppBundle | undefined;
  if (contract && ws.files.has('server/tools.ts')) {
    const t = specTitle(spec, title);
    const agentDef = buildAgentDef(contract, { title: t, spec });
    emit({ type: 'agent', kind: 'app_agent', role: 'po', agent: agentDef });
    appBundle = { contract, agent: agentDef, backend: 'server/tools.ts', backendOk: !!tb.lastBackendTest?.ok, title: t };
  }
  const files = Object.fromEntries(ws.files);
  emit({ type: 'agent', kind: 'summary', framework: 'scripté (démo)', ms: Date.now() - t0, iterations: iteration, files: Object.keys(files), components: [...ws.components], cliCalls: tb.cliCalls, builds: tb.builds });
  return { code: tb.lastBuild.html, plan: spec, brief, files, components: [...ws.components], workspace: ws.id, iterations: iteration, reviews, toolResults: tb.mcpSamples.map((s) => ({ name: s.tool, result: s.result })), framework: 'scripté (démo)', app: appBundle };
}
