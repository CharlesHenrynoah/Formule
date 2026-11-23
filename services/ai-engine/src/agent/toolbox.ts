/** Fonctions d'outils partagées par l'équipe réelle (Agents SDK) et l'équipe scriptée (mode démo). */
import type { McpClient } from '../mcp.ts';
import type { RuntimeTool } from '../types.ts';
import { inferSchema, type AgentEvent, type AgentRole } from './events.ts';
import { compactSample, compactToolSchema, isMcpDataError, isSizeError, prepareCallArgs, slimArgs } from './mcp-sample.ts';
import { Workspace } from './workspace.ts';
import { testBackend, type BackendTest, type Contract } from '../../../../packages/app-mcp/src/core.mjs';

const short = (v: unknown, n = 4000) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…(tronqué)' : s; };
let seq = 0;

export class Toolbox {
  cliCalls = 0;
  builds = 0;
  lastBuild: { ok: boolean; html?: string; output: string } | null = null;
  mcpSamples: Array<{ tool: string; args: unknown; result: unknown; full?: unknown }> = [];
  private tools: RuntimeTool[] | null = null;
  private mcpTail: Promise<unknown> = Promise.resolve();
  constructor(readonly ws: Workspace, readonly mcp: McpClient | undefined, readonly emit: (e: AgentEvent) => void) {}

  /** Un seul appel MCP à la fois : le modèle peut en demander plusieurs dans le même tour. */
  private enqueueMcp<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mcpTail.then(fn, fn);
    this.mcpTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async traced<T>(role: AgentRole, tool: string, args: unknown, fn: () => Promise<T>, summarize: (r: T) => string): Promise<T> {
    const id = `t${++seq}`;
    this.emit({ type: 'agent', kind: 'tool', role, id, tool, args });
    const t0 = Date.now();
    try {
      const r = await fn();
      this.emit({ type: 'agent', kind: 'tool_result', role, id, tool, ok: true, summary: summarize(r).slice(0, 400), ms: Date.now() - t0 });
      return r;
    } catch (e) {
      this.emit({ type: 'agent', kind: 'tool_result', role, id, tool, ok: false, summary: (e as Error).message.split(this.ws.dir + '/').join('').slice(0, 400), ms: Date.now() - t0 });
      throw e;
    }
  }

  async mcpTools(): Promise<RuntimeTool[]> {
    if (this.tools && this.tools.length > 0) return this.tools;
    if (!this.mcp) return [];
    const listed = await this.mcp.listTools();
    if (listed.length > 0) this.tools = listed;
    return listed;
  }

  // ---- Data Engineer / Développeur : MCP en lecture seule ----
  async listMcpTools(role: AgentRole) {
    return this.traced(role, 'mcp_list_tools', {}, async () => (await this.mcpTools()).map((t) => ({
      id: t.id, serveur: t.server, description: (t.description ?? '').slice(0, 240), ecriture: t.write, schema: compactToolSchema(t.inputSchema ?? {}),
    })), (r) => `${r.length} outil(s) : ${r.map((t) => t.id + (t.ecriture ? ' [écriture]' : '')).join(', ')}`);
  }

  async sampleMcp(role: AgentRole, tool: string, args: unknown) {
    return this.enqueueMcp(() => this.sampleMcpNow(role, tool, args));
  }

  private async sampleMcpNow(role: AgentRole, tool: string, args: unknown) {
    const t = (await this.mcpTools()).find((x) => x.id === tool);
    const prepared = prepareCallArgs(args, t?.inputSchema);
    return this.traced(role, 'mcp_call', { tool, args: prepared.args, argsTrimmed: prepared.trimmed || undefined }, async () => {
      if (!t) throw new Error(`Outil MCP inconnu ou non autorisé : ${tool}`);
      if (t.write) throw new Error(`Outil en écriture interdit pendant la conception : ${tool} (il ne peut être appelé qu'à l'exécution, avec confirmation)`);
      if (this.mcpSamples.length >= 3) throw new Error('Quota d\'échantillonnage atteint (3 appels) — la Liaison s\'arrête');
      const call = async (a: Record<string, unknown>) => this.mcp!.call(tool, a);
      let used = prepared.args;
      let r: { data: unknown; resolvedTool?: string } | undefined;
      try {
        r = await call(used);
      } catch (e) {
        const msg = (e as Error).message ?? '';
        // Retry progressif : args allégés → défauts schéma → {} (échantillon minimal).
        // Hub GitHub réécrit déjà search→list ; ici on gère taille / args invalides.
        if (!isSizeError(msg) && !/invalid|required|missing|schema|argument|Validation Failed|cannot be searched|rate limit/i.test(msg)) throw e;
        const fallbacks = [slimArgs(used, 2_000).args, prepareCallArgs({}, t.inputSchema).args, {}];
        let last: Error = e as Error;
        for (const fb of fallbacks) {
          try { used = fb; r = await call(fb); break; }
          catch (e2) {
            last = e2 as Error;
            const m2 = last.message ?? '';
            if (!isSizeError(m2) && !/invalid|required|missing|schema|argument|Validation Failed|cannot be searched|rate limit/i.test(m2)) throw e2;
          }
        }
        if (!r) throw last;
      }
      const soft = isMcpDataError(r!.data, false);
      if (soft) throw new Error(soft);
      const compact = compactSample(r!.data);
      const resolved = r!.resolvedTool;
      this.mcpSamples.push({ tool: resolved ?? tool, args: used, result: compact.echantillon, full: r!.data });
      // Schéma observé collé à l'échantillon : le brief et le front doivent s'y caler (pas de champs inventés).
      const schema = inferSchema(r!.data).slice(0, 40);
      return {
        outil: tool,
        ...(resolved && resolved !== tool ? { outil_resolu: resolved } : {}),
        args_utilises: used,
        ...(prepared.trimmed || compact.truncated || resolved ? { note: [prepared.trimmed || compact.truncated ? 'args/échantillon allégés' : '', resolved ? `réécrit → ${resolved}` : ''].filter(Boolean).join(' · ') } : {}),
        schema,
        echantillon: compact.echantillon,
      };
    }, (r) => `${(r as { schema?: unknown[] }).schema?.length ?? 0} champ(s) · ${short((r as { echantillon?: unknown }).echantillon, 220)}`);
  }

  // ---- Développeur : workspace + CLI shadcn + build ----
  async dashboardAdd(blocks: string[]) {
    return this.traced('dev', 'dashboard_add', { blocks }, async () => {
      const r = await this.ws.dashboardAdd(blocks);
      this.cliCalls++;
      this.emit({ type: 'agent', kind: 'cli', role: 'dev', command: r.command, ok: r.ok, output: r.output.slice(-1500), ms: r.ms });
      if (!r.ok) throw new Error(r.output.slice(-800));
      return { ajoutes: r.added, sortie: r.output.slice(-1200) };
    }, (r) => `shadcn-dashboard : ${r.ajoutes.join(', ') || '(rien)'}`);
  }

  async shadcnAdd(components: string[]) {
    return this.traced('dev', 'shadcn_add', { components }, async () => {
      const r = await this.ws.shadcnAdd(components);
      this.cliCalls++;
      this.emit({ type: 'agent', kind: 'cli', role: 'dev', command: r.command, ok: r.ok, output: r.output.slice(-1500), ms: r.ms });
      if (!r.ok) throw new Error(r.output.slice(-800));
      return { ajoutes: r.added, disponibles: [...this.ws.components], horsLigne: !!r.offline };
    }, (r) => `ajoutés : ${r.ajoutes.join(', ') || '(déjà présents)'}`);
  }

  async writeFile(path: string, content: string) {
    return this.traced('dev', 'write_file', { path, bytes: content?.length ?? 0 }, async () => {
      const r = await this.ws.write(path, content);
      this.metrics.writes++; this.metrics.writtenLines += r.lines;
      this.emit({ type: 'agent', kind: 'file', role: 'dev', op: 'write', ...r });
      return r;
    }, (r) => `${r.path} (${r.lines} lignes)`);
  }

  async readFile(role: AgentRole, path: string) {
    return this.traced(role, 'read_file', { path }, async () => {
      const text = await this.ws.read(path);
      this.metrics.reads++; this.metrics.readLines += text.split('\n').length;
      this.emit({ type: 'agent', kind: 'file', role, op: 'read', path, bytes: text.length, lines: text.split('\n').length });
      return text;
    }, (t) => `${t.split('\n').length} lignes`);
  }

  /** Métriques de la passe (affichées dans le résumé : mesure du mode incrémental). */
  metrics = { reads: 0, readLines: 0, writes: 0, writtenLines: 0, edits: 0, editedLines: 0, searches: 0 };

  async editFile(path: string, edits: Array<{ find?: string; replace?: string; after?: string; before?: string; insert?: string }>) {
    return this.traced('dev', 'edit_file', { path, edits: edits?.length ?? 0 }, async () => {
      const r = await this.ws.edit(path, edits);
      this.metrics.edits++; this.metrics.editedLines += r.changedLines;
      this.emit({ type: 'agent', kind: 'file', role: 'dev', op: 'edit', path: r.path, bytes: r.bytes, lines: r.lines, changed: r.changedLines } as never);
      return r;
    }, (r) => `${r.path} : ${r.edits} retouche(s), ${r.changedLines} ligne(s) modifiée(s)`);
  }

  async readRange(role: AgentRole, path: string, from?: number, to?: number) {
    return this.traced(role, 'read_file', { path, from, to }, async () => {
      const r = await this.ws.readRange(path, from, to);
      this.metrics.reads++; this.metrics.readLines += r.to - r.from + 1;
      this.emit({ type: 'agent', kind: 'file', role, op: 'read', path, bytes: r.text.length, lines: r.to - r.from + 1 });
      return r;
    }, (r) => `lignes ${r.from}-${r.to} / ${r.total}`);
  }

  async searchCode(role: AgentRole, pattern: string) {
    return this.traced(role, 'search_code', { pattern }, async () => { this.metrics.searches++; return this.ws.search(pattern); }, (r) => `${r.length} occurrence(s)`);
  }

  async listFiles(role: AgentRole) {
    return this.traced(role, 'list_files', {}, async () => [...await this.ws.list('src'), ...(this.ws.files.has('server/tools.ts') ? ['server/tools.ts'] : [])], (r) => `${r.length} fichiers`);
  }

  lastBackendTest: BackendTest | null = null;
  /** Backend MCP de l'app : transpile server/tools.ts, vérifie le contrat du PO et exerce chaque outil (base jetable). */
  async testBackend(role: AgentRole, contract: Contract | null) {
    return this.traced(role, 'test_backend', {}, async () => {
      const src = this.ws.files.get('server/tools.ts');
      const r: BackendTest = src ? await testBackend(src, contract) : { ok: false, problems: ['server/tools.ts absent : écris le backend MCP avec write_file'], tools: [], smoke: [] };
      this.lastBackendTest = r;
      this.emit({ type: 'agent', kind: 'backend_test', role, ok: r.ok, problems: r.problems, tools: r.tools, smoke: r.smoke.map((x) => ({ tool: x.tool, ok: x.ok, error: x.error })) } as never);
      return r;
    }, (r) => (r.ok ? `backend OK : ${r.tools.join(', ')}` : `backend KO : ${r.problems.slice(0, 3).join(' ; ')}`));
  }

  async build() {
    return this.traced('dev', 'build', {}, async () => {
      // Données factices du smoke render : résultats des lectures du test backend (base jetable).
      const fixtures = Object.fromEntries((this.lastBackendTest?.smoke ?? []).filter((x: any) => x.ok && 'data' in x).map((x: any) => [x.tool, x.data]));
      const r = await this.ws.build({ fixtures });
      this.builds++;
      this.lastBuild = { ok: r.ok, html: r.html, output: r.output };
      this.emit({ type: 'agent', kind: 'cli', role: 'dev', command: 'vite build', ok: r.ok, output: r.output.slice(-1500), ms: r.ms });
      this.emit({ type: 'agent', kind: 'build', role: 'dev', ok: r.ok, ms: r.ms, bytes: r.bytes, output: r.output.slice(-1500) });
      return { ok: r.ok, sortie: r.ok ? `Build réussi : dist/index.html (${Math.round((r.bytes ?? 0) / 1024)} Ko)` : r.output.slice(-2500) };
    }, (r) => (r.ok ? 'build OK' : 'build en échec'));
  }
}
