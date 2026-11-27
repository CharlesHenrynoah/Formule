import { describe, expect, it } from 'vitest';
import type { ViewSpec } from '@formule/contracts';
import { datasetOf } from '../src/semantic/resolve.js';
import { intents, profile, recommend } from '../src/semantic/charts.js';

const acq = (raw: unknown) => ({ raw, ref: { serverId: 'x', serverName: 'Inconnu', demo: false, tool: { name: 'list_things', description: '', permission: 'read', hint: '' } }, envelope: { id: 'env1', status: 'ok' }, args: {} }) as never;
const rnd = (i: number) => ((i * 9301 + 49297) % 233280) / 233280;

// Un MCP jamais vu : aucun nom de champ connu du moteur.
const things = { items: Array.from({ length: 40 }, (_, i) => ({ code: `T${i}`, label: `Objet ${i}`, family: ['alpha', 'beta', 'gamma', 'delta'][i % 4], weight_kg: Math.round(rnd(i) * 100 * (i % 7 === 0 ? 8 : 1)), delta: Math.round((rnd(i + 3) - 0.5) * 40), score: Math.round(rnd(i + 9) * 10) })) };
const series = { points: Array.from({ length: 60 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), temp: 10 + Math.sin(i / 5) * 5, rain: Math.round(rnd(i) * 9) })) };

describe('moteur de graphiques générique', () => {
  it('lit les intentions de la demande', () => {
    expect([...intents('Montre la répartition par famille et le top 10')]).toEqual(expect.arrayContaining(['share', 'rank']));
    expect(intents('évolution dans le temps').has('trend')).toBe(true);
  });
  it('profile un schéma inconnu (mesures, catégories, signe)', () => {
    const p = profile(datasetOf(acq(things)))!;
    expect(p.fields.find((f) => f.rel === 'family')?.kind).toBe('category');
    expect(p.fields.find((f) => f.rel === 'delta')?.signed).toBe(true);
    expect(p.name?.rel).toBe('label');
  });
  it('adapte les graphiques à la demande et varie les formes', () => {
    const ds = datasetOf(acq(things)); const views: ViewSpec[] = [];
    recommend(views, new Map([['q1', ds]]), ['q1'], 'Répartition du poids par famille, et la relation entre poids et score');
    const kinds = views.map((v) => v.kind);
    expect(kinds).toEqual(expect.arrayContaining(['donut', 'scatter']));
    expect(kinds.every((k) => k === 'donut' || k === 'scatter')).toBe(true);
    expect(JSON.stringify(views.find((v) => v.kind === 'donut'))).toContain('"label":"family"');
    expect(views.length).toBeLessThanOrEqual(5);
  });
  it('sans intention de graphique, aucun tableau de bord n’est ajouté', () => {
    const views: ViewSpec[] = [];
    recommend(views, new Map([['q1', datasetOf(acq(things))]]), ['q1'], 'liste des objets');
    expect(views).toEqual([]);
  });
  it('série temporelle → courbe demandée, pas de calendrier non demandé, jamais de camembert sur la date', () => {
    const views: ViewSpec[] = [];
    recommend(views, new Map([['q2', datasetOf(acq(series))]]), ['q2'], 'évolution de la température');
    expect(views.map((v) => v.kind)).toEqual(['line']);
    expect(JSON.stringify(views)).not.toMatch(/"label":"date"/);
  });
  it('le calendrier n’apparaît que s’il est demandé', () => {
    const views: ViewSpec[] = [];
    recommend(views, new Map([['q2', datasetOf(acq(series))]]), ['q2'], 'évolution et calendrier de la température');
    expect(views.map((v) => v.kind)).toEqual(expect.arrayContaining(['line', 'heatmap']));
  });
});
