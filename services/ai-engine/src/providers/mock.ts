/**
 * Provider MOCK : aucune clé requise. Choisit une mini-app réaliste selon des mots-clés,
 * la diffuse token par token (ou par étapes de "débruitage" en mode diffusion, comme Mercury),
 * simule le tool calling MCP et l'itération.
 * Astuce de démo : ajoutez « [bug] » au prompt pour produire une erreur que le validateur fera corriger.
 */
import type { ChatMessage, LLMProvider, StreamOptions, ToolDef, ToolCall, TaskHint } from '../types.ts';
import { pickApp, appHtml, appPlan, applyIteration } from '../mock/catalog.ts';
import { answerSpec, chartForSource, considerSources, fallbackSpec } from '../dashboards/spec.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NOISE = '▒░▓#@%&*$?!~^';

/** Texte "bruité" : une proportion `ratio` des caractères non blancs est remplacée par du bruit. */
export function noisy(text: string, ratio: number, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return [...text].map((c) => (/\s/.test(c) || rnd() >= ratio ? c : NOISE[Math.floor(rnd() * NOISE.length)])).join('');
}

export function mockText(hint: TaskHint): string {
  if (hint.task === 'dashboard') {
    if (hint.dashboardMode === 'filters') return JSON.stringify({ filters: [{ id: 'periode', label: 'Période', arg: 'period', options: ['7j', '30j', '90j'] }] });
    if (hint.dashboardMode === 'chart' || hint.dashboardMode === 'add') {
      const spec = fallbackSpec(hint.prompt, hint.tools ?? []);
      const chart = spec.charts[0];
      return JSON.stringify(hint.dashboardMode === 'chart' ? { ...(chart ?? {}), id: hint.chartId ?? chart?.id } : (chart ?? {}));
    }
    const { kept } = considerSources(hint.prompt, hint.tools ?? []);
    return JSON.stringify(answerSpec(hint.prompt, kept.map((k, i) => chartForSource(hint.prompt, k, null, i))));
  }
  const app = pickApp(hint.prompt);
  const bug = /\[bug\]/i.test(hint.prompt);
  if (hint.task === 'plan') {
    let plan = hint.previousCode
      ? `# Modification de l'app\n- Appliquer la demande : « ${hint.prompt} »\n- Conserver les fonctionnalités et l'état existants\n- Ne modifier que le style ou le contenu concerné`
      : appPlan(app, hint.prompt.replace(/\[bug\]/gi, '').trim());
    if (hint.toolResults?.length) plan += `\n- Données pré-chargées via MCP : ${hint.toolResults.map((t) => t.name).join(', ')}`;
    return plan;
  }
  if (hint.task === 'code') {
    if (hint.previousCode) return applyIteration(hint.previousCode, hint.prompt).code;
    let html = appHtml(app, hint.prompt.replace(/\[bug\]/gi, '').trim());
    const weather = hint.toolResults?.find((t) => /get_weather/.test(t.name))?.result as { ville?: string } | undefined;
    if (app?.id === 'meteo' && weather?.ville) {
      const v = weather.ville.replace(/['"<>\\]/g, '');
      html = html.replace("useState('Paris')", `useState('${v}')`).replace("load('Paris');", `load('${v}');`);
    }
    if (bug) html = html.replace(/<\/body>/i, '<script>\n  // erreur volontaire (démo du validateur)\n  var resultat = ;\n</script>\n</body>');
    return html;
  }
  if (hint.task === 'fix') {
    let code = hint.previousCode ?? '';
    code = code.replace(/<script>\s*\/\/ erreur volontaire[\s\S]*?<\/script>\s*/i, '');
    if (!/<\/html>/i.test(code)) code += '\n</body>\n</html>';
    return code;
  }
  return '';
}

export class MockProvider implements LLMProvider {
  readonly name = 'mock';
  readonly model = 'mock-catalogue-v1';
  readonly supportsDiffusion = true;
  readonly supportsTools = true;
  constructor(private delayMs = Number(process.env.MOCK_DELAY_MS ?? 8)) {}

  async stream(_messages: ChatMessage[], opts: StreamOptions): Promise<string> {
    const text = mockText(opts.hint);
    if (opts.diffusing && opts.hint.task !== 'plan') {
      const steps = 14;
      for (let k = steps; k >= 1; k--) {
        if (opts.signal?.aborted) throw new Error('annulé');
        opts.onSnapshot?.(noisy(text, (k / steps) * 0.9, k));
        await sleep(this.delayMs * 12);
      }
      opts.onSnapshot?.(text);
      return text;
    }
    let i = 0;
    let n = 0;
    while (i < text.length) {
      if (opts.signal?.aborted) throw new Error('annulé');
      const size = 3 + ((n++ * 7) % 11);
      opts.onDelta?.(text.slice(i, i + size));
      i += size;
      if (this.delayMs > 0) await sleep(this.delayMs);
    }
    return text;
  }

  async chatWithTools(messages: ChatMessage[], tools: ToolDef[], opts: { hint: TaskHint }) {
    await sleep(this.delayMs * 10);
    const already = messages.some((m) => m.role === 'tool');
    if (already) return { content: 'Données récupérées, je peux concevoir l\'app.', toolCalls: [] };
    const p = opts.hint.prompt;
    const calls: ToolCall[] = [];
    const weather = tools.find((t) => /__get_weather$/.test(t.name));
    if (weather && /m[ée]t[ée]o|weather|temp[ée]rature/i.test(p)) {
      const city = /(?:\s[àa]|pour|de|sur)\s+([A-ZÉÈ][\p{L}\-' ]+)/u.exec(p)?.[1]?.trim() ?? 'Paris';
      calls.push({ id: 'call_meteo', name: weather.name, arguments: JSON.stringify({ city }) });
    }
    const time = tools.find((t) => /__get_time$/.test(t.name));
    if (time && /heure|horloge|fuseau|time/i.test(p)) calls.push({ id: 'call_time', name: time.name, arguments: JSON.stringify({ timezone: 'Europe/Paris' }) });
    return { content: calls.length ? '' : 'aucun outil nécessaire', toolCalls: calls };
  }
}
