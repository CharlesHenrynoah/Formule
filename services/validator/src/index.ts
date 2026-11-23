/** Service de validation / build : contrôle syntaxique et sécurité des mini-apps générées. */
import { BIND_HOST } from './env.ts';
import Fastify from 'fastify';
import { validateHtml } from './validate.ts';

const PORT = Number(process.env.VALIDATOR_PORT ?? 4002);

const app = Fastify({ logger: { level: 'warn' }, bodyLimit: 5 * 1024 * 1024 });
app.get('/health', async () => ({ service: 'validator', status: 'ok' }));
app.post<{ Body: { code: string } }>('/validate', async (req, reply) => {
  if (typeof req.body?.code !== 'string') return reply.code(400).send({ error: 'code (string) requis' });
  return validateHtml(req.body.code);
});
app.listen({ port: PORT, host: BIND_HOST }).then(() => console.log(`[validator] prêt sur :${PORT}`));
