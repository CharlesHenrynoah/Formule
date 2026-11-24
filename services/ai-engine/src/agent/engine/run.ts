import { buildAgentDef, normalizeContract } from '../../../../../packages/app-mcp/src/core.mjs';
import { OpenAICompatibleProvider } from '../../providers/openai.ts';
import type { LLMProvider } from '../../types.ts';
import type { AgentEvent } from '../events.ts';
import { importsOf, profileDatasets, type Dataset } from '../events.ts';
import { ensureAppShell } from '../imports-check.ts';
import { seedFromSamples } from '../seed-from-samples.ts';
import { Toolbox } from '../toolbox.ts';
import { Workspace } from '../workspace.ts';
import type { AppBundle, CrewConfig, CrewInput } from '../crew.ts';
import { buildAgents } from './agents/all.ts';
import { textOf } from './agents/shared.ts';
import type { AgentName, SessionMessage } from './agents/types.ts';
import { collectionsInScreen, readsForCollections, type SourceTool } from '../../app-agents/ingest.ts';
import { runAgentLoop } from './loop.ts';
import { bindCharts } from './bind-charts.ts';
import { dropIncomplete, liaisonMission, poseRequest, repairDateSort, routeDemand } from './pose.ts';
import { collectSource } from './source-offer.ts';
import { reviewSource } from './product-owner.ts';
import { alignCalls, alignObserved, interfaceChecklist, observedFields } from './align-calls.ts';
import type { SpawnAgent } from './tools/types.ts';

const MAIN_STEPS = 24;

function cleanSourceSamples(raw: unknown): Array<{ tool: string; args: Record<string, unknown>; rows: Array<Record<string, unknown>> }> {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 6).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as { tool?: unknown; args?: unknown; rows?: unknown };
    const tool = String(row.tool ?? '').slice(0, 120);
    const args = row.args && typeof row.args === 'object' && !Array.isArray(row.args) ? row.args as Record<string, unknown> : {};
    const rows = (Array.isArray(row.rows) ? row.rows : []).filter((line): line is Record<string, unknown> => !!line && typeof line === 'object' && !Array.isArray(line)).slice(0, 40);
    return tool && rows.length ? [{ tool, args, rows }] : [];
  });
}
const LIAISON_STEPS = 6;

function providerFor(cfg: CrewConfig): LLMProvider {
  const inception = /inceptionlabs\.ai/.test(cfg.baseUrl);
  return new OpenAICompatibleProvider({
    name: inception ? 'inception' : 'openai',
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    supportsDiffusion: false,
    maxTokensField: inception ? 'max_completion_tokens' : 'max_tokens',
    extraBody: cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : undefined,
  });
}

/**
 * Session de construction. Même structure que Quests :
 * l'agent principal tient la boucle, l'outil task lance la liaison,
 * les outils s'exécutent un par un, la fin vérifie le projet.
 */
export async function runEngine(input: CrewInput, cfg: CrewConfig, ctx: { mcp?: ConstructorParameters<typeof Toolbox>[1]; emit: (event: AgentEvent | Record<string, unknown>) => void; signal?: AbortSignal }) {
  const emit = ctx.emit as (event: AgentEvent | Record<string, unknown>) => void;
  const note = (component: string, step: string, text: string, level: 'info' | 'ok' | 'error' = 'info') =>
    emit({ type: 'log', at: new Date().toISOString(), component, step, level, text });
  if (input.phase === 'source' && ctx.mcp) {
    note('Sélecteur', 'ouverture', 'Choix du moteur');
    emit({ type: 'agent', kind: 'role', role: 'data', label: 'Sélecteur' });
    const page = input.previous?.files?.['src/App.tsx'] ?? '';
    const llm = providerFor(cfg);
    const offer = await collectSource(
      input.prompt,
      page,
      () => ctx.mcp!.listTools(),
      async (tool, args) => (await ctx.mcp!.call(tool, args)).data,
      (mission) => llm.stream(
        [{
          role: 'system',
          content: [
            'Tu es le Sélecteur. Chaque serveur MCP est un moteur interchangeable, l’app est le véhicule.',
            'Tu choisis le moteur branché dont les outils couvrent la demande. Pas de marque par défaut.',
            'Tu n’utilises pas la démo si un autre moteur couvre la demande. Tu n’inventes aucun outil.',
            'Réponds uniquement par le JSON demandé.',
          ].join(' '),
        }, { role: 'user', content: mission }],
        { hint: { task: 'tools', prompt: input.prompt }, maxTokens: 700, signal: ctx.signal },
      ),
      (mission) => llm.stream(
        [{
          role: 'system',
          content: [
            'Tu génères le corps d’un outil MCP « execute » pour n’importe quel serveur.',
            'Réponds uniquement par du JavaScript : async function run(client) { … }.',
            'client est le SDK du fournisseur, jamais le hub MCP : n’appelle pas search_docs, execute, list_tools sur client.',
            'Utilise les méthodes SDK indiquées dans la mission. Pas de markdown.',
          ].join(' '),
        }, { role: 'user', content: mission }],
        { hint: { task: 'tools', prompt: input.prompt }, maxTokens: 2500, signal: ctx.signal },
      ),
    );
    emit({ type: 'agent', kind: 'message', role: 'data', text: offer.text.slice(0, 500) });
    emit({ type: 'agent', kind: 'role', role: 'po', label: 'Product Owner' });
    emit({ type: 'agent', kind: 'message', role: 'po', text: (offer.canBuild ? 'Lectures acceptées.' : 'Lectures refusées.') + ' ' + offer.text.slice(0, 400) });
    ctx.emit({ type: 'source', canBuild: offer.canBuild, text: offer.text, brief: offer.brief, samples: offer.samples });
    return {
      sourced: true, code: '', plan: input.prompt, brief: offer.brief, files: {}, components: [], workspace: '',
      iterations: 0, reviews: [] as Array<{ iteration: number; verdict: string; remarks: string[] }>, toolResults: [], framework: 'sourcing',
    };
  }
  const t0 = Date.now();
  note('Espace', 'ouverture', input.previous?.files && !input.fullRebuild ? 'reprise incrémentale' : 'construction complète');
  const ws = await Workspace.create({ files: input.previous?.files, components: input.previous?.components });
  const tb = new Toolbox(ws, input.useTools === false ? undefined : ctx.mcp, emit);
  const llm = providerFor(cfg);
  const incremental = !!input.previous?.files && !input.fullRebuild;
  const pageBefore = ws.files.get('src/App.tsx') ?? '';
  const datasets = profileDatasets((input.datasets ?? []) as Dataset[]);
  let liaisonReport = '';
  let toolCalls = 0;
  const counted = (event: AgentEvent) => {
    if (event.kind === 'tool') toolCalls += 1;
    emit(event);
  };
  const agentsLive = buildAgents(counted);

  const spawnAgent: SpawnAgent = async ({ agentName, prompt, signal }) => {
    if (agentName === 'main') throw new Error('La liaison ne relance pas l\'agent principal.');
    const child = agentsLive[agentName as AgentName];
    const result = await runAgentLoop({
      agent: child,
      opening: child.getMessages({ prompt, files: [...ws.files.keys()], incremental, datasets: '' }),
      llm, toolbox: tb, spawnAgent, signal, maxStepCount: LIAISON_STEPS,
      onText: (text) => counted({ type: 'agent', kind: 'message', role: 'data', text: text.slice(0, 500) }),
      onTrace: (line) => note(line.component, line.step, line.text, line.level ?? 'info'),
    });
    const last = [...result.messages].reverse().find((message) => message.role === 'assistant');
    const text = last ? textOf(last) : '';
    if (agentName === 'router' || agentName === 'liaison') liaisonReport = text;
    return { text, messages: result.messages };
  };

  const finish = async () => {
    note('Finition', 'page', 'Vérification de src/App.tsx');
    const page = ws.files.get('src/App.tsx');
    if (!page) throw new Error("Le Développeur n'a pas écrit src/App.tsx");
    const shell = ensureAppShell(page);
    if (shell.changed) { await ws.write('src/App.tsx', shell.code); note('Finition', 'coque', 'Coque imposée', 'ok'); }
    else note('Finition', 'coque', 'déjà en place', 'ok');
    if (!ws.files.has('server/tools.ts')) throw new Error("Le backend n'a pas été écrit (server/tools.ts)");
    note('Finition', 'backend', 'server/tools.ts présent', 'ok');
    await tb.testBackend('dev', null);
    if (!tb.lastBackendTest?.ok) throw new Error(`Backend non conforme : ${(tb.lastBackendTest?.problems ?? []).slice(0, 3).join(' ; ') || '0 outil'}`);
    let patched = shell.changed;
    const cleaned = dropIncomplete(ws.files.get('src/App.tsx') ?? '');
    if (cleaned.changed) { await ws.write('src/App.tsx', cleaned.code); patched = true; note('Finition', 'nettoyage', 'Éléments incomplets retirés', 'ok'); }
    else note('Finition', 'nettoyage', 'rien à retirer', 'ok');
    const aligned = alignCalls(ws.files.get('src/App.tsx') ?? '', ws.files.get('server/tools.ts') ?? '');
    if (aligned.changed) { await ws.write('src/App.tsx', aligned.code); patched = true; note('Finition', 'alignement', 'Appels alignés sur les outils', 'ok'); }
    else note('Finition', 'alignement', 'appels déjà alignés', 'ok');
    const observed = alignObserved(
      ws.files.get('src/App.tsx') ?? '',
      ws.files.get('server/tools.ts') ?? '',
      input.prompt,
      cleanSourceSamples(input.sourceSamples),
    );
    if (observed.changed) { await ws.write('src/App.tsx', observed.code); patched = true; note('Finition', 'champs', 'Champs alignés sur l’échantillon', 'ok'); }
    else note('Finition', 'champs', 'champs déjà alignés', 'ok');
    if (incremental && (ws.files.get('src/App.tsx') ?? '') === pageBefore) {
      const posed = poseRequest(ws.files.get('src/App.tsx') ?? '', input.prompt);
      if (posed.changed) { await ws.write('src/App.tsx', posed.code); patched = true; note('Finition', 'pose', 'Élément demandé posé', 'ok'); }
    }
    const beforeCharts = ws.files.get('src/App.tsx') ?? '';
    const bound = bindCharts(beforeCharts);
    const measureKept = /Number\(\s*row\.[A-Za-z_][\w]*\s*\)/.test(beforeCharts);
    const becameCount = measureKept && /buckets\.set\(wk/.test(bound.code) && !/buckets\.set\(wk/.test(beforeCharts);
    if (bound.changed && !becameCount) { await ws.write('src/App.tsx', bound.code); patched = true; note('Finition', 'graphiques', 'Graphiques reliés aux lectures', 'ok'); }
    else if (becameCount) note('Finition', 'graphiques', 'Mesure conservée : un comptage ne la remplace pas', 'ok');
    else note('Finition', 'graphiques', 'graphiques déjà reliés', 'ok');
    const dated = repairDateSort(ws.files.get('src/App.tsx') ?? '');
    if (dated.changed) { await ws.write('src/App.tsx', dated.code); patched = true; note('Finition', 'dates', 'Tri des dates réparé', 'ok'); }
    else note('Finition', 'dates', 'dates déjà triées', 'ok');
    if (incremental && (ws.files.get('src/App.tsx') ?? '') === pageBefore) throw new Error("L'élément demandé n'a pas été posé : la page est inchangée.");
    if (patched || !tb.lastBuild?.ok) { note('Finition', 'build', 'Build final'); await tb.build(); }
    if (!tb.lastBuild?.ok || !tb.lastBuild.html) throw new Error(`Build final en échec : ${tb.lastBuild?.output.slice(-600) ?? 'aucun build'}`);
  };
  agentsLive.main.onFinish = async () => {};

  if (!incremental && input.sourceBrief) liaisonReport = input.sourceBrief;
  const sourceRows = cleanSourceSamples(input.sourceSamples);
  if (sourceRows.length && ctx.mcp) {
    try {
      const listed = await ctx.mcp.listTools();
      const catalog: SourceTool[] = listed.filter((tool: { write?: boolean; ecriture?: boolean }) => !(tool.write || tool.ecriture)).map((tool: { id: string; description?: string; serverName?: string; schema?: unknown }) => ({
        id: tool.id,
        name: tool.id.includes('__') ? tool.id.split('__').slice(1).join('__') : tool.id,
        description: tool.description,
        serverName: tool.serverName,
        write: false,
        inputSchema: (tool.schema ?? {}) as SourceTool['inputSchema'],
      }));
      const owner = reviewSource(input.prompt, catalog, sourceRows.map((sample) => ({ tool: sample.tool, args: sample.args, ok: true, rows: sample.rows })));
      emit({ type: 'agent', kind: 'role', role: 'po', label: 'Product Owner' });
      emit({ type: 'agent', kind: 'message', role: 'po', text: owner.text.slice(0, 500) });
      if (!owner.ok) throw new Error(owner.text);
      liaisonReport = [liaisonReport, owner.brief].filter(Boolean).join('\n\n');
    } catch (error) {
      if ((error as Error).message.startsWith('Product Owner')) throw error;
    }
  }
  const fields = observedFields(sourceRows);
  if (fields.length) liaisonReport = [liaisonReport, interfaceChecklist(fields, input.prompt)].filter(Boolean).join('\n\n');

  if (incremental) {
    const route = routeDemand(input.prompt);
    const subject = route.collections.length > 1 ? `collections ${route.collections.join(', ')}` : `collection ${route.collection}`;
    counted({ type: 'agent', kind: 'message', role: 'data', text: `Routeur : ${route.kind} « ${route.title} », ${subject}${route.data ? '' : ', sans lecture'}.` });
    if (input.sourceBrief) {
      liaisonReport = input.sourceBrief;
    } else if (!route.data) {
      liaisonReport = `Routeur : ${route.kind} « ${route.title} ». Aucune collection à lire.`;
    } else {
    let reads: Array<{ tool: string; args: Record<string, unknown> }> = [];
    try {
      const listed = await tb.listMcpTools('data');
      const catalog: SourceTool[] = listed.filter((tool) => !tool.ecriture).map((tool) => ({
        id: tool.id,
        name: tool.id.includes('__') ? tool.id.split('__').slice(1).join('__') : tool.id,
        write: false,
        inputSchema: (tool.schema ?? {}) as SourceTool['inputSchema'],
      }));
      reads = readsForCollections(route.collections, `${input.prompt}\n${pageBefore}`, catalog).slice(0, 3);
    } catch { /* la mission reste sans outil imposé */ }
    try {
      await spawnAgent({
        agentName: 'router',
        prompt: liaisonMission(input.prompt, reads),
        signal: ctx.signal ?? new AbortController().signal,
      });
    } catch (error) {
      liaisonReport = liaisonReport || `La liaison n'a pas pu échantillonner : ${(error as Error).message}`;
    }
    }
  }

  const opening = agentsLive.main.getMessages({
    prompt: input.prompt, files: [...ws.files.keys()], incremental, datasets,
    page: incremental ? pageBefore.split('\n').slice(-160).join('\n').slice(-7000) : '',
    liaison: liaisonReport,
  });
  let result = await runAgentLoop({
    agent: agentsLive.main,
    opening,
    llm, toolbox: tb, spawnAgent, signal: ctx.signal, maxStepCount: MAIN_STEPS, maxTokens: 16000,
    onText: (text) => counted({ type: 'agent', kind: 'message', role: 'dev', text: text.slice(0, 500) }),
    onTrace: (line) => note(line.component, line.step, line.text, line.level ?? 'info'),
  });
  if (!ctx.signal?.aborted && !ws.files.get('src/App.tsx')) {
    const nudge: SessionMessage = {
      role: 'user',
      parts: [{ type: 'text', text: "src/App.tsx n'est pas écrit. Le prochain outil est write_file, path src/App.tsx, content le fichier complet. Ensuite test_backend, puis build." }],
    };
    result = await runAgentLoop({
      agent: agentsLive.main,
      opening: [...result.messages, nudge],
      llm, toolbox: tb, spawnAgent, signal: ctx.signal, maxStepCount: 8, maxTokens: 16000,
      onText: (text) => counted({ type: 'agent', kind: 'message', role: 'dev', text: text.slice(0, 500) }),
      onTrace: (line) => note(line.component, line.step, line.text, line.level ?? 'info'),
    });
  }
  if (!ctx.signal?.aborted) await finish();

  const defs = tb.lastBackendTest?.defs ?? [];
  const contract = normalizeContract({
    tools: defs,
    agent: { name: 'Assistant', persona: 'Pilote de l\'interface', tools: tb.lastBackendTest?.tools ?? defs.map((tool: { name: string }) => tool.name) },
  });
  if (!contract) throw new Error('Contrat vide après la construction.');
  const title = input.prompt.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Interface';
  const agentDef = buildAgentDef(contract, { title, spec: input.prompt });
  if (liaisonReport) counted({ type: 'agent', kind: 'brief', role: 'data', text: liaisonReport.slice(0, 1500), relevant: true });
  counted({ type: 'agent', kind: 'contract', role: 'po', contract, ok: true });
  counted({ type: 'agent', kind: 'app_agent', role: 'po', agent: agentDef });

  const sampled = seedFromSamples(
    ws.files.get('server/tools.ts') ?? '',
    [
      ...cleanSourceSamples(input.sourceSamples).map((sample) => ({ tool: sample.tool, args: sample.args, result: sample.rows })),
      ...tb.mcpSamples.map((sample) => ({ tool: sample.tool, args: sample.args, result: sample.full ?? sample.result })),
    ],
    [...new Set([...collectionsInScreen(ws.files.get('src/App.tsx') ?? ''), ...routeDemand(input.prompt).collections])],
  );
  const app: AppBundle = { contract, agent: agentDef, backend: 'server/tools.ts', backendOk: !!tb.lastBackendTest?.ok, title };
  if (Object.keys(sampled).length) app.seed = sampled;
  const files = Object.fromEntries(ws.files);
  const components = [...new Set([...ws.components, ...importsOf(files['src/App.tsx'] ?? '')])];
  const before = input.previous?.files ?? {};
  const filesChanged = Object.keys(files).filter((path) => before[path] !== files[path]);
  counted({
    type: 'agent', kind: 'summary', framework: 'moteur agentique', ms: Date.now() - t0,
    iterations: result.steps, files: Object.keys(files), components, cliCalls: tb.cliCalls, builds: tb.builds,
    mode: incremental ? 'incrémental' : 'complet', filesChanged, toolCalls,
  });
  return {
    code: tb.lastBuild?.html ?? '',
    plan: input.prompt,
    brief: liaisonReport,
    files, components, workspace: ws.id,
    iterations: result.steps,
    reviews: [] as Array<{ iteration: number; verdict: string; remarks: string[] }>,
    toolResults: tb.mcpSamples.map((sample) => ({ name: sample.tool, result: sample.result })),
    framework: 'moteur agentique',
    app,
    memory: { mode: incremental ? 'incrémental' as const : 'complet' as const, features: [], filesChanged, ms: Date.now() - t0, toolCalls, metrics: { ...tb.metrics } },
  };
}
