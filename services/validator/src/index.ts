import { createService, listen } from '@formule/service-kit';
import { checkHtml, checkSpec } from './checks.js';

const app = await createService('validator');
app.post<{ Body: { html: string; dataHosts?: string[] } }>('/validate/html', async (r) => { const findings = checkHtml(String(r.body.html ?? ''), (r.body.dataHosts ?? []).map(String).slice(0, 200)); return { ok: !findings.some((f) => f.severity === 'error'), findings }; });
app.post<{ Body: { spec: unknown; catalog: never[] } }>('/validate/spec', async (r) => { const findings = checkSpec(r.body.spec, r.body.catalog ?? []); return { ok: findings.length === 0, findings }; });
await listen(app, 'validator');
