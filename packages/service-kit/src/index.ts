import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { redactString } from '@formule/contracts';

// .env à la racine (ignoré par git, chmod 600) : chargé une fois, sans écraser l'environnement.
try { const f = path.resolve(new URL('.', import.meta.url).pathname, '../../../.env'); (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(f); } catch { /* absent */ }

export const PORTS = {
  'api-gateway': 4000, 'ai-engine': 4001, validator: 4002, storage: 4003,
  'mcp-hub': 4004, 'app-agents': 4005, 'voice-gateway': 4006,
} as const;
export type ServiceName = keyof typeof PORTS;

const ENV_KEY: Record<ServiceName, string> = {
  'api-gateway': 'FORMULE_GATEWAY_URL', 'ai-engine': 'FORMULE_AI_URL', validator: 'FORMULE_VALIDATOR_URL',
  storage: 'FORMULE_STORAGE_URL', 'mcp-hub': 'FORMULE_HUB_URL', 'app-agents': 'FORMULE_APPS_URL', 'voice-gateway': 'FORMULE_VOICE_URL',
};

export function serviceUrl(name: ServiceName): string {
  return process.env[ENV_KEY[name]] ?? `http://127.0.0.1:${PORTS[name]}`;
}

export function dataDir(...sub: string[]): string {
  const root = path.resolve(process.env.FORMULE_DATA_DIR ?? path.join(findRepoRoot(), 'data'));
  const p = path.join(root, ...sub);
  mkdirSync(p, { recursive: true });
  return p;
}

export function findRepoRoot(): string {
  // services/<x>/src → racine du monorepo
  return path.resolve(new URL('.', import.meta.url).pathname, '../../..');
}

export class ServiceError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

/** Appel interne JSON avec délai. Les erreurs gardent leur statut (428, 403…). */
export async function call<T = unknown>(svc: ServiceName, route: string, init: { method?: string; body?: unknown; timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 30_000);
  try {
    const res = await fetch(serviceUrl(svc) + route, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ServiceError(res.status, json?.code ?? 'error', json?.message ?? `${svc} ${res.status}`, json?.details);
    return json as T;
  } catch (e) {
    if (e instanceof ServiceError) throw e;
    if ((e as Error).name === 'AbortError') throw new ServiceError(504, 'timeout', `${svc} : délai dépassé`);
    throw new ServiceError(503, 'unavailable', `${svc} indisponible`);
  } finally { clearTimeout(timer); }
}

export async function createService(name: ServiceName, extraHealth?: () => Promise<Record<string, unknown>> | Record<string, unknown>, opts: { defaultHealth?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'warn',
      redact: ['req.headers.authorization', 'req.headers.cookie', '*.token', '*.bearer', '*.apiKey'],
      formatters: { log: (o) => JSON.parse(redactString(JSON.stringify(o))) },
    },
    bodyLimit: 2 * 1024 * 1024,
  });
  if (opts.defaultHealth !== false) app.get('/health', async () => ({ service: name, status: 'ok', time: new Date().toISOString(), ...(extraHealth ? await extraHealth() : {}) }));
  app.setErrorHandler((err, _req, reply) => {
    const e = err as Partial<ServiceError> & { statusCode?: number; validation?: unknown };
    const status = e.status ?? e.statusCode ?? 500;
    reply.status(status).send({ code: e.code ?? 'error', message: redactString(err.message), details: e.details });
  });
  return app;
}

export async function listen(app: FastifyInstance, name: ServiceName) {
  const port = Number(process.env.PORT ?? PORTS[name]);
  const host = (name === 'api-gateway' ? process.env.FORMULE_GATEWAY_HOST : undefined) ?? process.env.HOST ?? '127.0.0.1';
  await app.listen({ port, host });
  console.log(`[${name}] prêt sur http://${host}:${port}`);
}
