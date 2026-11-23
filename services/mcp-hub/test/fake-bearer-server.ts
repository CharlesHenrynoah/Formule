/** Serveur MCP local FACTICE qui exige `Authorization: Bearer <jeton>` (HTTP streamable sur /mcp, SSE sur /sse + /messages). */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

export type Fake = { url: string; seen: string[]; close: () => Promise<void> };

function mcp() {
  const s = new McpServer({ name: 'fake-bearer', version: '1.0.0' });
  s.registerTool('ping', { description: 'répond pong', annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  return s;
}

export async function startFake(token: string): Promise<Fake> {
  const seen: string[] = []; // valeur de l'en-tête Authorization reçue à chaque requête
  const sse = new Map<string, SSEServerTransport>();
  const authed = (req: IncomingMessage) => { const a = String(req.headers.authorization ?? ''); seen.push(a); return a === `Bearer ${token}`; };
  const srv: Server = createServer(async (req, res) => {
    if (!authed(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
      res.end(JSON.stringify({ message: req.headers.authorization ? 'Unauthorized: invalid token' : 'Unauthorized: Authorization header not sent' }));
      return;
    }
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/mcp') {
      const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void t.close(); });
      await mcp().connect(t);
      await t.handleRequest(req, res);
      return;
    }
    if (u.pathname === '/sse' && req.method === 'GET') {
      const t = new SSEServerTransport('/messages', res);
      sse.set(t.sessionId, t);
      res.on('close', () => sse.delete(t.sessionId));
      await mcp().connect(t);
      return;
    }
    if (u.pathname === '/messages' && req.method === 'POST') {
      const t = sse.get(u.searchParams.get('sessionId') ?? '');
      if (!t) { res.writeHead(404).end(); return; }
      await t.handlePostMessage(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}
