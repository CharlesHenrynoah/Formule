/**
 * Cas P0 vérifiables sans services lancés. Les cas qui exigent le hub (pagination, timeout d'écriture,
 * injection via ressource) sont dans integration.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { aggregate, certify, inferContract, simulateLinear, toSeries, getPath, AppSpecSchema, type GateResult } from '@formule/contracts';
import { makeEnvelope } from '@formule/contracts/node';
import { datasetOf, genericReqs, resolveRequirement } from '../../../services/ai-engine/src/semantic/resolve.js';
import { expectations } from '../../../services/ai-engine/src/evaluation/oracle.js';
import { contractGate, runDomCheck } from '../../../services/ai-engine/src/evaluation/gates.js';
import { untouchedEqual } from '../../../services/ai-engine/src/agent/delta.js';
import { buildWorkspace, createWorkspace, writeWorkspaceFile, cleanupWorkspace } from '../../../services/ai-engine/src/agent/workspace.js';
import type { Acquired } from '../../../services/ai-engine/src/discovery/catalog.js';

process.env.FORMULE_DATA_DIR ??= '/tmp/formule-bench-data';

const acq = (raw: unknown, tool = 'releve_lire', error?: boolean): Acquired => {
  const { envelope } = makeEnvelope({ serverId: 'inedit', serverName: 'Serveur inédit', demo: false, tool, args: {}, raw: error ? undefined : raw, observedAt: '2026-11-25T08:15:00Z', ...(error ? { error: { kind: 'permission' as const, message: '403' } } : {}) });
  return { queryId: 'q1', ref: { serverId: 'inedit', serverName: 'Serveur inédit', demo: false, tool: { name: tool, description: '', permission: 'read', hint: '' } }, args: {}, envelope, raw: error ? null : raw };
};
const gates = (passed = true): GateResult[] => (['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'] as const).map((gate) => ({ gate, passed, details: [] }));

describe('P0 — MCP inédit, objets imbriqués', () => {
  const raw = JSON.parse(readFileSync(new URL('../fixtures/inedit.json', import.meta.url), 'utf8'));
  const ds = datasetOf(acq(raw));
  it('valeurs, unités et relations préservées', () => {
    const t = ds.contract.fields.find((f) => f.path === 'mesure.temperature.valeur')!;
    expect(t).toMatchObject({ type: 'number', unit: '°C', role: 'measure' });
    expect(ds.contract.fields.find((f) => f.path === 'station.id')!.role).toBe('identifier');
    expect(ds.contract.fields.find((f) => f.path === 'capteurs[].etat')).toBeTruthy();
  });
});

describe('P0 — documentation seule', () => {
  it('aucune mesure inventée', () => {
    const ds = datasetOf(acq({ texte: 'Le chiffre d’affaires annuel est d’environ 2 millions.' }, 'guide'));
    expect(ds.docOnly).toBe(true);
    const r = resolveRequirement({ id: 'ca', label: 'CA', mandatory: true, tool: ['guide'], view: 'kpi', measure: ['chiffre'], agg: 'sum', title: 'CA' }, ds, 'v1', 'q1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/documentation.*aucune mesure/);
    expect(genericReqs(ds).every((g) => g.view === 'table')).toBe(true);
  });
  it('un échec de lecture ne devient pas une démo', () => {
    const a = acq(null, 'releve_lire', true);
    expect(a.envelope.status).toBe('error');
    expect(a.envelope.source.demo).toBe(false);
  });
});

describe('P0 — métrique présente dans le brut mais absente du DOM', () => {
  it('refus + diagnostic de liaison', async () => {
    const html = '<!doctype html><html><body><div id="root"><article data-view="v1" data-state="ready"><span data-binding="v1" data-value="10"></span></article></div></body></html>';
    const rep = await runDomCheck(html, [{ viewId: 'v1', kind: 'kpi', value: '64.82' }]);
    expect(rep.results[0].ok).toBe(false);
    expect(rep.results[0].diag).toBe('brut → 64.82 ; DOM → 10');
  });
});

describe('P0 — série irrégulière', () => {
  it("l'heure est gardée, pas de faux zéros", () => {
    const rows = [{ t: '2026-11-01T09:13:00Z', v: 3 }, { t: '2026-11-04T17:02:00Z', v: null }, { t: '2026-11-05T00:00:00Z', v: 0 }];
    const { points } = toSeries(rows, 't', 'v', getPath);
    expect(points.map((p) => p.v)).toEqual([3, null, 0]);
    expect(new Date(points[0].t).toISOString()).toBe('2026-11-01T09:13:00.000Z');
  });
});

describe('P0 — exigence obligatoire manquante', () => {
  it('pas de succès complet', () => {
    const r = certify(gates(), [{ id: 'a', label: 'revenu', mandatory: true, status: 'covered' }, { id: 'b', label: 'CAC', mandatory: true, status: 'unavailable' }], null);
    expect(r.certified).toBe(false);
    expect(r.message).toMatch(/Conformité 50 % \(1\/2 exigences\)\. Non satisfaites : CAC \(techniquement indisponible\)\. Non certifiée complète\./);
  });
});

describe('P0 — deux unités ou deux entités', () => {
  it('pas de fusion implicite', () => {
    const raw = { items: [{ m: { valeur: 10, devise: 'EUR' } }, { m: { valeur: 12, devise: 'USD' } }] };
    const r = aggregate(raw, { collection: 'items', agg: 'sum', measure: 'm.valeur', unitPath: 'm.devise', where: [], percent: false }, null, Date.now());
    expect(r.state).toBe('invalid');
    expect(r.value).toBeNull();
  });
});

describe('P0 — rupture de schéma', () => {
  it('seules les vues affectées sont signalées', () => {
    const raw = { items: [{ prix: '12', qte: 3 }] }; // prix devenu texte
    const a = acq(raw, 'ventes');
    const ds = datasetOf(a);
    const spec = AppSpecSchema.parse({
      specVersion: 1, title: 't', mission: '', demo: false, requirements: [], actions: [],
      queries: [{ id: 'q1', serverId: 'inedit', tool: 'ventes', args: {} }],
      views: [
        { kind: 'kpi', id: 'prix', title: 'Prix', queryId: 'q1', bindings: { unit: null, aggregate: { collection: 'items', agg: 'sum', measure: 'prix' } } },
        { kind: 'kpi', id: 'qte', title: 'Qté', queryId: 'q1', bindings: { unit: null, aggregate: { collection: 'items', agg: 'sum', measure: 'qte' } } },
      ],
    });
    const g = contractGate(spec, new Map([['q1', ds]]), { gate: 'G2', passed: true, details: [] });
    expect(g.passed).toBe(false);
    expect(g.details.join(' ')).toMatch(/prix : items\[\]\.prix de type string/);
    expect(g.details.join(' ')).not.toMatch(/qte :/);
  });
});

describe('P0 — simulation', () => {
  it('reproductible, hypothèses visibles, aucun effet externe', () => {
    const pts = [{ t: 0, v: 100 }, { t: 1000, v: 110 }, { t: 2000, v: null }, { t: 3000, v: 120 }];
    const a = simulateLinear(pts, { variation_pct: 5, horizon: 3 });
    expect(simulateLinear(pts, { variation_pct: 5, horizon: 3 })).toEqual(a);
    expect(a.scenario.at(-1)!.v).toBe(138.92);
    expect(a.assumptions.length).toBeGreaterThan(1);
    expect(a.base).toBe(pts); // la série réelle n'est pas modifiée
  });
});

describe('P0 — incrément', () => {
  it('le non demandé est inchangé', () => {
    const base = AppSpecSchema.parse({ specVersion: 1, title: 't', mission: '', demo: false, requirements: [], queries: [], actions: [], views: [{ kind: 'note', id: 'a', title: 'A', text: 'x' }, { kind: 'note', id: 'b', title: 'B', text: 'y' }] });
    const after = structuredClone(base); after.views[1] = { ...after.views[1], title: 'B modifiée' } as never;
    expect(untouchedEqual(base, after, new Set(['b']))).toEqual([]);
    expect(untouchedEqual(base, after, new Set())).toEqual(['vue « B » modifiée sans demande']);
  });
});

describe('P0 — panne runtime : obsolète étiqueté, vues indépendantes vivantes', () => {
  it('une actualisation en échec garde la dernière donnée marquée obsolète', async () => {
    const raw = { items: [{ id: 'a', montant: { valeur: 5, devise: 'EUR' } }, { id: 'b', montant: { valeur: 7, devise: 'EUR' } }], observe_a: '2026-11-25T10:00:00Z' };
    const a = acq(raw, 'ventes');
    const spec = AppSpecSchema.parse({
      specVersion: 1, title: 'Bench', mission: 'panne', demo: false, actions: [],
      requirements: [{ id: 'total', label: 'total', mandatory: true, status: 'covered' }],
      queries: [{ id: 'q1', serverId: 'inedit', tool: 'ventes', args: {} }],
      views: [
        { kind: 'kpi', id: 'k', title: 'Total', queryId: 'q1', requirementIds: ['total'], bindings: { unit: 'EUR', aggregate: { collection: 'items', agg: 'sum', measure: 'montant.valeur', unitPath: 'montant.devise' } } },
        { kind: 'note', id: 'n', title: 'Note', text: 'vue indépendante' },
      ],
    });
    const data = { builtAt: a.envelope.fetchedAt, certification: { certified: false, message: '', label: 'aperçu' }, queries: { q1: { envelope: { id: a.envelope.id, status: 'ok', observedAt: a.envelope.observedAt, fetchedAt: a.envelope.fetchedAt, coverage: a.envelope.coverage, source: { serverName: 'Serveur inédit', demo: false }, hash: a.envelope.hash }, raw } } };
    const ws = createWorkspace('bench_panne');
    writeWorkspaceFile(ws, 'src/app.spec.json', JSON.stringify(spec));
    writeWorkspaceFile(ws, 'src/app.data.json', JSON.stringify(data));
    const built = await buildWorkspace(ws);
    cleanupWorkspace(ws);
    expect(built.ok).toBe(true);
    expect(expectations(spec.views, { q1: raw }, { q1: Date.parse(raw.observe_a) })[0]).toEqual({ viewId: 'k', kind: 'kpi', value: '12' });
    const scripts: string[] = [];
    const html = built.html!.replace(/<script type="module"( crossorigin)?>([\s\S]*?)<\/script>/g, (_m, _c, b: string) => { scripts.push(b); return ''; }).replace('</body>', () => `${scripts.map((b) => `<script>${b}</script>`).join('')}</body>`);
    const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://app.formule.invalid/' });
    // hors iframe, le pont est indisponible : l'actualisation échoue comme une panne fournisseur
    await new Promise((r) => setTimeout(r, 300));
    const doc = dom.window.document;
    expect(doc.querySelector('[data-binding="k"]')!.getAttribute('data-value')).toBe('12');
    (Array.from(doc.querySelectorAll('button')).find((b) => b.textContent === 'Actualiser') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 300));
    expect(doc.querySelector('[data-view="k"]')!.getAttribute('data-state')).toBe('stale');
    expect(doc.querySelector('[data-binding="k"]')!.getAttribute('data-value')).toBe('12');
    expect(doc.body.textContent).toMatch(/actualisation en échec/);
    expect(doc.querySelector('[data-view="n"]')).toBeTruthy();
    dom.window.close();
  });
});
