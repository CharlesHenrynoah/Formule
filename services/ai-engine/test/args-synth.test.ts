import { describe, expect, it } from 'vitest';
import { descriptionExamples, synthesizeFromSchema } from '../src/discovery/args-synth.js';

const repoSearch = {
  type: 'object', properties: {
    query: { type: 'string' }, repo_types: { type: 'array', items: { type: 'string', enum: ['model', 'dataset', 'space'] }, minItems: 1, maxItems: 3, default: ['model', 'dataset'] },
    author: { type: 'string' }, filters: { type: 'array', items: { type: 'string' } },
    sort: { type: 'string', enum: ['trendingScore', 'downloads', 'likes', 'createdAt', 'lastModified'] }, limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
  },
};
const hfFs = { type: 'object', required: ['operations'], properties: { operations: { type: 'array', minItems: 1, items: { type: 'object', required: ['cmd', 'args'], properties: { cmd: { type: 'string', enum: ['ls', 'cat', 'attach', 'stat', 'find', 'search'] }, args: { type: 'array', items: { type: 'string' } } } } } } };
const hfDesc = `Examples:
  {"operations":[{"cmd":"ls","args":["hf://models/trending","--limit","10"]}]}
  {"operations":[{"cmd":"ls","args":["hf://papers/trending"]}]}
  {"operations":[{"cmd":"ls","args":["hf://papers/daily/latest"]}]}`;

describe('synthèse d’arguments depuis le schéma', () => {
  it('énumérations FR→EN et « top N »', () => {
    expect(synthesizeFromSchema(repoSearch, '', 'Top 20 des modèles tendance, classement par téléchargements et likes').args).toEqual({ repo_types: ['model'], sort: 'trendingScore', limit: 20 });
    expect(synthesizeFromSchema(repoSearch, '', 'Classement des datasets populaires').args).toMatchObject({ repo_types: ['dataset'], sort: 'downloads' });
    expect(synthesizeFromSchema(repoSearch, '', 'Spaces Hugging Face tendance').args).toMatchObject({ repo_types: ['space'], sort: 'trendingScore' });
  });
  it('exemples publiés par le serveur, choisis selon l’intention', () => {
    expect(descriptionExamples(hfDesc, hfFs)).toHaveLength(3);
    const r = synthesizeFromSchema(hfFs, hfDesc, 'Dernières publications scientifiques');
    expect(r.missing).toEqual([]);
    expect(r.args).toEqual({ operations: [{ cmd: 'ls', args: ['hf://papers/daily/latest'] }] });
  });
  it('rien d’inventé quand rien ne correspond', () => {
    const r = synthesizeFromSchema({ type: 'object', required: ['location'], properties: { location: { type: 'string' } } }, '', 'météo');
    expect(r.missing).toEqual(['location']);
  });
});

import { isExcluded, parseSections } from '../src/semantic/sections.js';
describe('demandes en sections', () => {
  it('exclusion tolérante aux fautes', () => {
    expect(isExcluded('hf_whoami', 'f_whoami')).toBe(true);
    expect(isExcluded('hub_repo_search', 'f_whoami')).toBe(false);
  });
  it('sections, titre, directives, exclusions', () => {
    const p = parseSections('Crée un dashboard nommé **X**.\n\n**1. Indicateurs**\n- Nombre de modèles.\n\n**2. Radar**\n- Top 20.\n\n**3. Acquisition**\n- Utilise `hub_repo_search` pour les classements.\n- N\'utilise pas `f_whoami`, car public.\n\n**4. Design**\nAccents orange.');
    expect(p.title).toBe('X');
    expect(p.sections.map((s) => s.kind)).toEqual(['kpi', 'data', 'acquisition', 'design']);
    expect(p.directives).toEqual([{ tool: 'hub_repo_search', text: 'les classements' }]);
    expect(p.excluded).toEqual(['f_whoami']);
  });
});
