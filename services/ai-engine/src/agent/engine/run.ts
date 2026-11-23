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
import type { AgentName } from './agents/types.ts';
import { collectionsInScreen } from '../../app-agents/ingest.ts';
import { runAgentLoop } from './loop.ts';
import { collectionForPrompt, poseRequest } from './pose.ts';
import type { SpawnAgent } from './tools/types.ts';

const MAIN_STEPS = 24;
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
  const emit = ctx.emit as (event: AgentEvent) => void;
  const t0 = Date.now();
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
    });
    const last = [...result.messages].reverse().find((message) => message.role === 'assistant');
    const text = last ? textOf(last) : '';
    if (agentName === 'liaison') liaisonReport = text;
    return { text, messages: result.messages };
  };

  agentsLive.main.onFinish = async () => {
    const page = ws.files.get('src/App.tsx');
    if (!page) throw new Error("Le Développeur n'a pas écrit src/App.tsx");
    const shell = ensureAppShell(page);
    if (shell.changed) await ws.write('src/App.tsx', shell.code);
    if (!ws.files.has('server/tools.ts')) throw new Error("Le backend n'a pas été écrit (server/tools.ts)");
    await tb.testBackend('dev', null);
    if (!tb.lastBackendTest?.ok) throw new Error(`Backend non conforme : ${(tb.lastBackendTest?.problems ?? []).slice(0, 3).join(' ; ') || '0 outil'}`);
    if (incremental && (ws.files.get('src/App.tsx') ?? '') === pageBefore) {
      const posed = poseRequest(ws.files.get('src/App.tsx') ?? '', input.prompt);
      if (posed.changed) await ws.write('src/App.tsx', posed.code);
    }
    if (incremental && (ws.files.get('src/App.tsx') ?? '') === pageBefore) throw new Error("L'élément demandé n'a pas été posé : la page est inchangée.");
    if (shell.changed || !tb.lastBuild?.ok) await tb.build();
    if (!tb.lastBuild?.ok || !tb.lastBuild.html) throw new Error(`Build final en échec : ${tb.lastBuild?.output.slice(-600) ?? 'aucun build'}`);
  };

  if (incremental) {
    const collection = collectionForPrompt(input.prompt);
    try {
      await spawnAgent({
        agentName: 'liaison',
        prompt: `L'interface existe déjà. On ajoute un élément ou des données : ce n'est pas seulement de la conception.\nDemande : ${input.prompt}\nCollection visée : ${collection}.\nÉchantillonne l'outil MCP en lecture qui alimente cette collection. Rapport court : outil, arguments, champs observés. N'invente aucun champ. Tu n'écris pas la page.`,
        signal: ctx.signal ?? new AbortController().signal,
      });
    } catch (error) {
      liaisonReport = liaisonReport || `La liaison n'a pas pu échantillonner : ${(error as Error).message}`;
    }
  }

  const result = await runAgentLoop({
    agent: agentsLive.main,
    opening: agentsLive.main.getMessages({
      prompt: input.prompt, files: [...ws.files.keys()], incremental, datasets,
      page: incremental ? pageBefore.split('\n').slice(-160).join('\n').slice(-7000) : '',
      liaison: liaisonReport,
    }),
    llm, toolbox: tb, spawnAgent, signal: ctx.signal, maxStepCount: MAIN_STEPS,
    onText: (text) => counted({ type: 'agent', kind: 'message', role: 'dev', text: text.slice(0, 500) }),
  });

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
    tb.mcpSamples.map((sample) => ({ tool: sample.tool, args: sample.args, result: sample.full ?? sample.result })),
    [...new Set([...collectionsInScreen(ws.files.get('src/App.tsx') ?? ''), collectionForPrompt(input.prompt)])],
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
