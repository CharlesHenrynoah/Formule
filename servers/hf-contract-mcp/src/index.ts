/**
 * Serveur MCP de TEST DE CONTRAT pour Hugging Face. Les noms d'outils, schémas d'entrée, descriptions (avec leurs
 * exemples) et formats de sortie suivent le code source public de huggingface/hf-mcp-server (repo-search.ts,
 * hf-fs.ts, hf-fs-contract.ts). Les VALEURS sont synthétiques : ce serveur doit être enregistré avec --demo true.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

let seed = 11; const r = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const orgs = ['meta-llama', 'mistralai', 'Qwen', 'google', 'openai', 'deepseek-ai', 'microsoft', 'stabilityai', 'black-forest-labs', 'nvidia'];
const tasks = ['text-generation', 'text-generation', 'image-text-to-text', 'automatic-speech-recognition', 'text-to-image', 'text-to-speech', 'image-classification', 'any-to-any', 'feature-extraction', 'object-detection'];
const libs = ['transformers', 'diffusers', 'gguf', 'mlx', 'sentence-transformers'];
const DAY = 86_400_000;
const models = Array.from({ length: 40 }, (_, i) => ({ id: `${orgs[i % orgs.length]}/modele-${i + 1}`, author: orgs[i % orgs.length], pipeline_tag: tasks[i % tasks.length], library_name: libs[i % libs.length], downloads: Math.round(5e3 + r() * 9e6), likes: Math.round(10 + r() * 6000), trendingScore: Math.round(r() * 900), tags: [libs[i % libs.length], tasks[i % tasks.length], `license:${['apache-2.0', 'mit', 'llama3.1', 'other'][i % 4]}`], createdAt: new Date(Date.now() - Math.round(r() * 300) * DAY).toISOString() }));
const datasets = Array.from({ length: 25 }, (_, i) => ({ id: `${orgs[(i + 3) % orgs.length]}/donnees-${i + 1}`, author: orgs[(i + 3) % orgs.length], downloads: Math.round(1e3 + r() * 2e6), likes: Math.round(r() * 3000), trendingScore: Math.round(r() * 400), description: `Jeu de données synthétique n°${i + 1} pour le test de contrat.`, gated: i % 5 === 0, tags: ['size_categories:10K<n<100K', 'format:parquet'], createdAt: new Date(Date.now() - Math.round(r() * 500) * DAY).toISOString() }));
const spaces = Array.from({ length: 20 }, (_, i) => ({ id: `${orgs[(i + 5) % orgs.length]}/app-${i + 1}`, author: orgs[(i + 5) % orgs.length], title: `Démo ${i + 1}`, emoji: '🚀', sdk: ['gradio', 'docker', 'streamlit', 'static'][i % 4], likes: Math.round(r() * 4000), trendingScore: Math.round(r() * 300), ai_short_description: `Application de démonstration ${i + 1}.`, disabled: i % 9 === 0, tags: i % 3 === 0 ? ['mcp-server'] : [], createdAt: new Date(Date.now() - Math.round(r() * 200) * DAY).toISOString() }));
const papers = Array.from({ length: 15 }, (_, i) => ({ type: 'paper', path: `papers/2511.${String(10000 + i)}`, uri: `hf://papers/2511.${String(10000 + i)}`, title: `Article de recherche synthétique ${i + 1}`, description: `Résumé synthétique : contribution ${i + 1} sur l'apprentissage ${['multimodal', 'par renforcement', 'efficace', 'auto-supervisé'][i % 4]}.`, upvotes: Math.round(r() * 300), published_at: new Date(Date.now() - i * DAY / 2).toISOString(), daily_papers_date: new Date(Date.now() - Math.floor(i / 5) * DAY).toISOString().slice(0, 10), arxiv_url: `https://arxiv.org/abs/2511.${String(10000 + i)}`, url: `https://huggingface.co/papers/2511.${String(10000 + i)}` }));

const fmtN = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
const fmtD = (iso: string) => { const d = new Date(iso); return `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}, ${d.getFullYear()}`; };
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

const server = new McpServer({ name: 'hf-mcp-contract', version: '1.0.0' });

server.registerTool('hub_repo_search', {
  title: 'Repo Search',
  description: 'Search and list Hugging Face models, datasets and Spaces (sort by downloads, likes, trending) with a shared query interface. You can target models, datasets, spaces, or aggregate across multiple repo types in one call. Include links to repositories in your response.',
  inputSchema: {
    query: z.string().optional().describe('Search term. Leave blank and specify sort + limit to browse trending or recent repositories.'),
    repo_types: z.array(z.enum(['model', 'dataset', 'space'])).min(1).max(3).optional().default(['model', 'dataset']).describe('Repository types to search. Defaults to ["model", "dataset"].'),
    author: z.string().optional(), filters: z.array(z.string()).optional().describe('Optional hub filter tags (e.g. ["text-generation"], ["mcp-server"]).'),
    sort: z.enum(['trendingScore', 'downloads', 'likes', 'createdAt', 'lastModified']).optional(),
    limit: z.number().min(1).max(100).optional().default(20),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ query, repo_types, author, filters, sort, limit }) => {
  const types = repo_types ?? ['model', 'dataset'];
  const pick = <T extends { trendingScore: number; likes: number; createdAt: string; downloads?: number; id: string; author: string; tags: string[] }>(list: T[]) => {
    let l = list.filter((x) => (!query || x.id.includes(query)) && (!author || x.author === author) && (!filters?.length || filters.every((f) => x.tags.includes(f) || (x as { pipeline_tag?: string }).pipeline_tag === f)));
    const key = sort ?? 'trendingScore';
    l = [...l].sort((a, b) => (key === 'createdAt' || key === 'lastModified' ? b.createdAt.localeCompare(a.createdAt) : ((b as Record<string, number>)[key] ?? 0) - ((a as Record<string, number>)[key] ?? 0)));
    return l.slice(0, limit ?? 20);
  };
  const lines: string[] = [];
  const groups = types.map((t) => ({ t, res: t === 'model' ? pick(models) : t === 'dataset' ? pick(datasets) : pick(spaces as never[]) as never[] }));
  const total = groups.reduce((a, g) => a + g.res.length, 0);
  lines.push(`Found ${total} repositories across ${types.join(', ')}${sort ? ` sorted by ${sort} (descending)` : ''}.`, '');
  for (const g of groups) {
    lines.push(`## ${{ model: 'Models', dataset: 'Datasets', space: 'Spaces' }[g.t]} (${g.res.length})`, '');
    for (const x of g.res as Record<string, unknown>[]) {
      lines.push(`### ${g.t === 'space' ? `${x.emoji} ${x.title} (\`${x.id}\`)` : `${x.id}`}`, '');
      if (g.t === 'dataset') lines.push(String(x.description), '');
      if (g.t === 'space') lines.push(String(x.ai_short_description), '');
      const info = [`**Author:** ${x.author}`];
      if (g.t === 'model') { info.push(`**Task:** ${x.pipeline_tag}`, `**Library:** ${x.library_name}`); }
      if (g.t === 'space') info.push(`**SDK:** ${x.sdk}`);
      if (typeof x.downloads === 'number') info.push(`**Downloads:** ${fmtN(x.downloads)}`);
      info.push(`**Likes:** ${x.likes}`, `**Trending Score:** ${x.trendingScore}`);
      lines.push(info.join(' | '), '', `**Tags:** ${(x.tags as string[]).join(', ')}`, '');
      if (x.gated) lines.push('🔒 Gated', '');
      if (x.disabled) lines.push('⛔ Disabled', '');
      lines.push(`**Created:** ${fmtD(String(x.createdAt))}`, '', `**Link:** [https://hf.co/${g.t === 'model' ? '' : `${g.t}s/`}${x.id}](https://hf.co/${g.t === 'model' ? '' : `${g.t}s/`}${x.id})`, '', '---', '');
    }
  }
  return text(lines.join('\n'));
});

server.registerTool('hub_repo_details', {
  title: 'Repo Details', description: 'Get details for one or more Hugging Face repos (model, dataset, space). Example: {"repo_ids":["meta-llama/modele-1"],"repo_type":"model"}',
  inputSchema: { repo_ids: z.array(z.string()).min(1).max(10), repo_type: z.enum(['model', 'dataset', 'space']).optional() }, annotations: { readOnlyHint: true },
}, async ({ repo_ids }) => text(repo_ids.map((id) => { const m = [...models, ...datasets].find((x) => x.id === id); return m ? `# ${id}\n\n**Author:** ${m.author} | **Downloads:** ${fmtN(m.downloads)} | **Likes:** ${m.likes}\n` : `# ${id}\n\nNot found.`; }).join('\n---\n')));

const HF_FS_DESCRIPTION = `When to use: Hugging Face Hub models, datasets, Spaces, collections, papers, daily papers, today's trending models, current paper leaderboard, docs; list and read repository files, model and dataset cards (README, license).

Examples:
  {"operations":[{"cmd":"ls","args":["hf://models/trending","--limit","10"]}]}
  {"operations":[{"cmd":"ls","args":["hf://papers/trending"]}]}
  {"operations":[{"cmd":"ls","args":["hf://papers/daily/latest"]}]}
  {"operations":[{"cmd":"cat","args":["hf://papers/2501.00001/paper.md"]}]}
  {"operations":[{"cmd":"search","args":["hf://models","--tag","base_model:finetune:org/repo"]}]}

Use hf_fs for Hugging Face Hub filesystem operations. Call it with operations, an array of {cmd, args} items; multiple operations may be submitted together.`;

server.registerTool('hf_fs', {
  title: 'Hugging Face Hub filesystem', description: HF_FS_DESCRIPTION,
  inputSchema: { operations: z.array(z.object({ cmd: z.enum(['ls', 'cat', 'attach', 'stat', 'find', 'search']), args: z.array(z.string()) })).min(1).max(10) },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ operations }) => {
  const results = operations.map((op) => {
    const uri = op.args[0] ?? '';
    const lim = Number(op.args[op.args.indexOf('--limit') + 1]) || 20;
    let entries: Record<string, unknown>[] | null = null;
    if (op.cmd === 'ls' && /^hf:\/\/papers\/(daily|trending)/.test(uri)) entries = papers.slice(0, lim);
    else if (op.cmd === 'ls' && uri === 'hf://models/trending') entries = [...models].sort((a, b) => b.trendingScore - a.trendingScore).slice(0, lim).map((m) => ({ type: 'repo', repo_type: 'model', path: `models/${m.id}`, uri: `hf://models/${m.id}`, downloads: m.downloads, likes: m.likes, task: m.pipeline_tag, library: m.library_name, trending_score: m.trendingScore, created_at: m.createdAt, url: `https://huggingface.co/${m.id}` }));
    else if (op.cmd === 'ls' && uri === 'hf://spaces/trending') entries = [...spaces].sort((a, b) => b.trendingScore - a.trendingScore).slice(0, lim).map((s) => ({ type: 'repo', repo_type: 'space', path: `spaces/${s.id}`, title: s.title, sdk: s.sdk, likes: s.likes, trending_score: s.trendingScore, url: `https://huggingface.co/spaces/${s.id}` }));
    return entries ? { status: 'success', op: op.cmd, uri, result: { op: 'ls', uri, entries, total: entries.length } } : { status: 'error', op: op.cmd, uri, error: { code: 'not_found', message: `${uri} : chemin non reproduit par le test de contrat` } };
  });
  const ok = results.filter((x) => x.status === 'success').length;
  return { content: [{ type: 'text' as const, text: `${ok}/${results.length} operation(s) succeeded.` }], structuredContent: { results } };
});

server.registerTool('hf_whoami', { title: 'Hugging Face User Info', description: 'Hugging Face tools are being used by authenticated user.', inputSchema: {}, annotations: { readOnlyHint: true } },
  async () => { throw new Error('hf_whoami ne devrait pas être appelé (exclu par la demande)'); });

await server.connect(new StdioServerTransport());
