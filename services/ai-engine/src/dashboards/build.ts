/**
 * Constructeur de tableaux : le data engineer lit les sources qui répondent à la question,
 * la conception n'en garde que celles-là, le développeur pose chaque graphique dès qu'il est nourri.
 */
import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '../types.ts';
import type { McpClient } from '../mcp.ts';
import {
  answerSpec, appendChart, applyChart, argsForPrompt, considerSources, dashMode, extractJson, faceCharts, normalizeChart, normalizeFilters, normalizeSpec, promptDensity, questionTitle, targetChart, titleRespects,
  type ChartSpec, type DashboardSpec, type ToolLike,
} from './spec.ts';

type Emit = (e: Record<string, unknown>) => void;
type Ctx = { provider: LLMProvider; mcp?: McpClient; emit: Emit; signal?: AbortSignal };

const SYSTEM = `Tu composes des tableaux vivants pour Everything Software. Réponds par UN objet JSON, sans prose.
La question de l'utilisateur est la seule consigne : chaque graphique doit y répondre. N'utilise aucun outil hors de la liste.
Reprends les "args" indiqués : ils satisfont les champs requis. N'invente ni ville, ni expression, ni dépôt.
Types de graphique : kpi, line, bar, area, pie, table. "x" et "y" sont des champs présents dans l'échantillon.`;

const pause = (ms: number, signal?: AbortSignal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('annulé')); }, { once: true });
});

const toolName = (t: ToolLike) => t.name ?? t.id.split('__').pop() ?? t.id;

function seal(chart: ChartSpec, prompt: string, tools: ToolLike[]): ChartSpec {
  const tool = tools.find((t) => t.id === chart.tool);
  if (!tool) return chart;
  const required = (tool.inputSchema as { required?: string[] } | undefined)?.required ?? [];
  const needed = argsForPrompt(tool, prompt) ?? {};
  const args = { ...needed, ...chart.args };
  for (const k of required) if (needed[k] !== undefined && needed[k] !== '') args[k] = needed[k];
  const missing = required.filter((k) => args[k] === undefined || args[k] === '');
  if (missing.length) throw new Error(`${toolName(tool)} exige ${missing.join(', ')}, et la question ne les donne pas.`);
  return { ...chart, args, title: titleRespects(chart.title, prompt, tool) };
}

export async function buildDashboard(
  input: { prompt: string; dashboardId?: string; spec?: DashboardSpec | null },
  ctx: Ctx,
) {
  let tools: Awaited<ReturnType<McpClient['listTools']>> = [];
  try { tools = (await ctx.mcp?.listTools()) ?? []; } catch { tools = []; }
  const reads = tools.filter((t) => !t.write);
  const current = input.spec && input.spec.charts?.length ? input.spec : null;
  const mode = dashMode(input.prompt, current);
  const focus = mode === 'chart' ? targetChart(input.prompt, current) : null;
  const id = mode === 'create' || !input.dashboardId ? randomUUID() : input.dashboardId;
  if (mode === 'create') return compose(input.prompt, id, reads, ctx);
  return retouch(input.prompt, id, mode, focus, current, reads, ctx);
}

async function compose(prompt: string, id: string, reads: ToolLike[], ctx: Ctx) {
  const { kept, skipped } = considerSources(prompt, reads);
  const density = promptDensity(prompt);
  const title = questionTitle(prompt);
  ctx.emit({ type: 'agent', kind: 'role', role: 'data', label: 'Analyse des données' });
  ctx.emit({ type: 'agent', kind: 'message', role: 'data', text: `Question retenue : « ${title} ». Densité ${density.level}, ${density.slots} emplacement${density.slots > 1 ? 's' : ''}.` });
  for (const s of skipped) ctx.emit({ type: 'agent', kind: 'message', role: 'data', text: `${toolName(s.tool)} écarté — ${s.reason}.` });

  ctx.emit({ type: 'agent', kind: 'role', role: 'po', label: 'Conception' });
  if (!kept.length) {
    const why = skipped.slice(0, 4).map((s) => `${toolName(s.tool)} ${s.reason}`).join(' · ');
    ctx.emit({ type: 'agent', kind: 'message', role: 'po', text: `Rien de branché ne répond à « ${title} ». ${why}` });
    throw new Error(`Aucune source ne répond à « ${title} ». ${why}`);
  }
  ctx.emit({ type: 'agent', kind: 'message', role: 'po', text: `Le visage répond à la question avec ${kept.map((k) => toolName(k.tool)).join(', ')}, sur ${density.slots} emplacement${density.slots > 1 ? 's' : ''}.` });

  ctx.emit({ type: 'dashboard_open', id, mode: 'create', chartId: null, title, description: `Réponse à « ${title} ».` });
  ctx.emit({ type: 'dashboard_layout', id, spec: answerSpec(prompt, []) });

  ctx.emit({ type: 'agent', kind: 'role', role: 'dev', label: 'Construction' });
  const samples: Array<{ tool: string; data: unknown }> = [];
  const sampleOf = new Map<string, unknown>();
  for (const pick of kept) {
    if (ctx.signal?.aborted) throw new Error('annulé');
    ctx.emit({ type: 'agent', kind: 'message', role: 'dev', text: `${toolName(pick.tool)} sert la question (${pick.reason}). Lecture avec ${JSON.stringify(pick.args)}.` });
    ctx.emit({ type: 'agent', kind: 'tool', role: 'dev', id: `s-${pick.tool.id}`, tool: 'mcp_call', args: { tool: pick.tool.id, ...pick.args } });
    if (!ctx.mcp) continue;
    try {
      const r = await ctx.mcp.call(pick.tool.id, pick.args);
      sampleOf.set(pick.tool.id, r.data);
      samples.push({ tool: pick.tool.id, data: r.data });
      ctx.emit({ type: 'agent', kind: 'tool_result', role: 'dev', id: `s-${pick.tool.id}`, tool: 'mcp_call', ok: true, summary: pick.tool.id, ms: r.ms });
    } catch (e) {
      ctx.emit({ type: 'agent', kind: 'tool_result', role: 'dev', id: `s-${pick.tool.id}`, tool: 'mcp_call', ok: false, summary: (e as Error).message });
    }
  }
  const charts = faceCharts(prompt, kept, sampleOf);
  for (const [i, chart] of charts.entries()) {
    if (ctx.signal?.aborted) throw new Error('annulé');
    ctx.emit({ type: 'agent', kind: 'message', role: 'dev', text: `Élément ${i + 1}/${charts.length} — ${chart.title}.` });
    ctx.emit({ type: 'chart_ready', id, chart });
    if (i < charts.length - 1) await pause(40, ctx.signal);
  }
  ctx.emit({ type: 'agent', kind: 'brief', role: 'data', text: `${charts.length} élément${charts.length > 1 ? 's' : ''} pour « ${title} », densité ${density.level}.`, relevant: true });

  const catalog = kept.map((k) => `- ${k.tool.id} : ${(k.tool.description ?? '').slice(0, 160)}\n  args : ${JSON.stringify(k.args)}`).join('\n');
  let text = '';
  try {
    text = await ctx.provider.stream([
      { role: 'system', content: `${SYSTEM}\n\nOutils retenus pour cette question :\n${catalog}` },
      { role: 'user', content: `La question est de densité ${density.level} : le tableau a exactement ${charts.length} éléments, du plus synthétique au plus détaillé. JSON : {"title","description","filters":[],"charts":[{"id","title","type","tool","args","x","y"}]}. Même nombre, mêmes outils.\n\nQuestion : ${prompt}\n\nÉchantillons :\n${JSON.stringify(samples).slice(0, 6000)}` },
    ], { hint: { task: 'dashboard', prompt, tools: kept.map((k) => k.tool), dashboardMode: 'create' }, signal: ctx.signal, maxTokens: 2500 });
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    text = '';
  }
  const allowed = kept.map((k) => k.tool.id);
  const modeled = normalizeSpec(extractJson(text), allowed);
  const aligned = modeled?.charts.length === charts.length
    ? charts.map((chart, i) => seal({ ...chart, title: modeled.charts[i].title || chart.title, type: modeled.charts[i].type }, prompt, reads))
    : charts.map((chart) => seal(chart, prompt, reads));
  const spec = answerSpec(prompt, aligned);
  if (modeled?.charts.length === charts.length) {
    for (const chart of spec.charts) ctx.emit({ type: 'chart_ready', id, chart });
  }
  const reply = `Tableau « ${spec.title} » · ${spec.charts.map((c) => c.title).join(', ')}.`;
  ctx.emit({ type: 'agent', kind: 'message', role: 'dev', text: reply });
  ctx.emit({ type: 'dashboard_spec', id, spec, reply, mode: 'create' });
  return { id, spec, mode: 'create' as const, reply };
}

async function retouch(
  prompt: string,
  id: string,
  mode: 'chart' | 'add' | 'filters',
  focus: ChartSpec | null,
  current: DashboardSpec | null,
  reads: ToolLike[],
  ctx: Ctx,
) {
  if (!current) throw new Error('aucun tableau à retoucher');
  const allowed = reads.map((t) => t.id);
  ctx.emit({ type: 'agent', kind: 'role', role: 'data', label: 'Analyse des données' });
  ctx.emit({
    type: 'dashboard_open', id, mode, chartId: focus?.id ?? null,
    title: current.title, description: current.description ?? '',
  });
  const pool = mode === 'chart' && focus ? reads.filter((t) => t.id === focus.tool) : reads.slice(0, 3);
  const samples: Array<{ tool: string; data: unknown }> = [];
  if (ctx.mcp) for (const t of pool) {
    if (ctx.signal?.aborted) throw new Error('annulé');
    const args = argsForPrompt(t, prompt) ?? { limit: 5 };
    ctx.emit({ type: 'agent', kind: 'tool', role: 'data', id: `s-${t.id}`, tool: 'mcp_call', args: { tool: t.id } });
    try {
      const r = await ctx.mcp.call(t.id, args);
      samples.push({ tool: t.id, data: r.data });
      ctx.emit({ type: 'agent', kind: 'tool_result', role: 'data', id: `s-${t.id}`, tool: 'mcp_call', ok: true, summary: t.id, ms: r.ms });
    } catch (e) {
      ctx.emit({ type: 'agent', kind: 'tool_result', role: 'data', id: `s-${t.id}`, tool: 'mcp_call', ok: false, summary: (e as Error).message });
    }
  }
  ctx.emit({ type: 'agent', kind: 'brief', role: 'data', text: samples.length ? `${samples.length} source(s) lue(s).` : 'Aucune source lisible.', relevant: samples.length > 0 });
  ctx.emit({ type: 'agent', kind: 'role', role: 'po', label: 'Conception' });
  ctx.emit({ type: 'agent', kind: 'message', role: 'po', text: `La retouche reste dans le tableau « ${current.title} » et suit « ${questionTitle(prompt)} ».` });
  const ask = mode === 'chart'
    ? `Réécris UNIQUEMENT ce graphique, sans changer son sujet s'il répond déjà à la question. JSON : {"id":"${focus?.id}","title","type","tool","args","x","y"}.\nGraphique actuel : ${JSON.stringify(focus)}`
    : mode === 'add'
      ? `Ajoute UN graphique qui répond à la demande. JSON : {"id","title","type","tool","args","x","y"}.`
      : `Propose des filtres pour ce tableau. JSON : {"filters":[{"id","label","arg","options":["…"]}]}. Ne change aucun graphique.`;
  ctx.emit({ type: 'agent', kind: 'role', role: 'dev', label: 'Construction' });
  const catalog = reads.map((t) => `- ${t.id} : ${(t.description ?? '').slice(0, 160)}`).join('\n') || '(aucun outil en lecture)';
  let text = '';
  try {
    text = await ctx.provider.stream([
      { role: 'system', content: `${SYSTEM}\n\nOutils en lecture :\n${catalog}` },
      { role: 'user', content: `${ask}\n\nDemande : ${prompt}\n\nÉchantillons :\n${JSON.stringify(samples).slice(0, 6000)}` },
    ], { hint: { task: 'dashboard', prompt, tools: reads, dashboardMode: mode, chartId: focus?.id }, signal: ctx.signal, maxTokens: 2500 });
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
  }
  const parsed = extractJson(text);
  let spec: DashboardSpec;
  let reply: string;
  if (mode === 'chart' && focus) {
    const chart = normalizeChart(parsed, allowed, focus.id) ?? normalizeSpec(parsed, allowed)?.charts[0] ?? null;
    if (!chart) throw new Error('graphique illisible');
    const sealed = seal({ ...chart, id: focus.id }, prompt, reads);
    spec = applyChart(current, sealed);
    reply = `Graphique « ${spec.charts.find((c) => c.id === focus.id)?.title ?? focus.title} » reconstruit. Le reste du tableau est inchangé.`;
    ctx.emit({ type: 'chart_ready', id, chart: spec.charts.find((c) => c.id === focus.id) });
  } else if (mode === 'add') {
    const chart = normalizeChart(parsed, allowed, 'ajout') ?? normalizeSpec(parsed, allowed)?.charts[0] ?? null;
    if (!chart) throw new Error('graphique illisible');
    spec = appendChart(current, seal(chart, prompt, reads));
    reply = `Graphique « ${spec.charts.at(-1)?.title} » ajouté. Les autres n’ont pas bougé.`;
    ctx.emit({ type: 'chart_ready', id, chart: spec.charts.at(-1) });
  } else {
    const filters = normalizeFilters(parsed);
    spec = { ...current, filters: filters.length ? filters : current.filters };
    reply = filters.length ? 'Filtres mis à jour. Les graphiques restent en place.' : 'Filtres inchangés.';
  }
  ctx.emit({ type: 'agent', kind: 'message', role: 'dev', text: reply });
  ctx.emit({ type: 'dashboard_spec', id, spec, reply, mode });
  return { id, spec, mode, reply };
}
