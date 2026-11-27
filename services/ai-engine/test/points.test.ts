import { describe, expect, it } from 'vitest';
import { datasetOf } from '../src/semantic/resolve.js';
import { matchPoints } from '../src/semantic/points.js';

const acq = (raw: unknown) => ({ raw, queryId: 'q', ref: { serverId: 'src', serverName: 'Source', demo: false, tool: { name: 'lire', description: '', permission: 'read', hint: '' } }, envelope: { id: 'env1', status: 'ok' }, args: {} }) as never;

describe('points reliés aux données', () => {
  const ds = datasetOf(acq({ rows: [
    { nom: 'Alpha', prix_eur: 10, variation: 1.2 },
    { nom: 'Beta', prix_eur: 4, variation: -0.3 },
  ] }));

  it('relie un point seulement s’il touche un champ ou une valeur lus', () => {
    const planned = matchPoints([
      { text: 'prix des éléments', lookFor: ['prix', 'eur'], confidence: 0.8 },
      { text: 'capital de départ imaginaire', lookFor: ['capital', 'depart'], confidence: 0.9 },
    ], new Map([['q', ds]]));
    expect(planned[0].status).toBe('covered');
    expect(planned[0].view?.kind === 'ranking' || planned[0].view?.kind === 'kpi').toBe(true);
    expect(planned[1].status).toBe('unavailable');
    expect(planned[1].view).toBeUndefined();
  });

  it('une valeur lue (un nom) suffit à lier le point', () => {
    const planned = matchPoints([{ text: 'fiche Alpha', lookFor: ['Alpha'], confidence: 0.6 }], new Map([['q', ds]]));
    expect(planned[0].status).toBe('covered');
  });
});
