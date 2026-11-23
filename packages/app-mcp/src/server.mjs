#!/usr/bin/env node
/**
 * Serveur MCP (stdio) d'UNE app générée : expose ses outils métier.
 * Usage (lancé par mcp-hub) : node --permission --allow-fs-read=… --allow-fs-write=<data> server.mjs <tools.js> <dataDir>
 * Persistance : <dataDir>/db.json (écriture atomique). Pas de réseau : fetch & co. retirés du processus,
 * et le code de l'app tourne dans un contexte vm sans objet hôte (voir core.mjs).
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadBackend } from './core.mjs';

for (const k of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) { try { delete globalThis[k]; } catch { /* ignore */ } }

process.on('unhandledRejection', () => {});
process.on('uncaughtException', (e) => { console.error('[app-mcp]', e?.message ?? e); });

const [codeFile, dataDir0] = process.argv.slice(2);
if (!codeFile || !dataDir0) { console.error('usage : server.mjs <tools.js> <dataDir>'); process.exit(2); }
const dataDir = resolve(dataDir0);
const dbFile = join(dataDir, 'db.json');
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
let initial = {};
try { if (existsSync(dbFile)) initial = JSON.parse(readFileSync(dbFile, 'utf8')); } catch { initial = {}; }
const backend = loadBackend(readFileSync(resolve(codeFile), 'utf8'), initial);

const persist = () => { const tmp = dbFile + '.tmp'; writeFileSync(tmp, JSON.stringify(backend.data())); renameSync(tmp, dbFile); };

const server = new Server({ name: 'es-app-backend', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: backend.tools.map((t) => ({
    name: t.name, description: t.description, inputSchema: t.inputSchema,
    annotations: { readOnlyHint: !t.write, destructiveHint: t.write && !t.safe },
    _meta: { safe: t.safe },
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const t = backend.tools.find((x) => x.name === req.params.name);
  try {
    const r = backend.call(req.params.name, req.params.arguments ?? {});
    if (t?.write) persist();
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: String(e.message ?? e) }] };
  }
});
await server.connect(new StdioServerTransport());
