import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PackSchema } from '../src/packs.js';
import { matchCodeTemplate } from '../src/discovery/code-adapters.js';
import { namedServerIds, packReads, resolveArgs, type CatalogServer } from '../src/discovery/catalog.js';

const ct = PackSchema.parse(JSON.parse(readFileSync(new URL('../../../packs/coingecko.json', import.meta.url), 'utf8'))).codeTemplates!;

describe('gabarits de code relus fournis par un pack (le cœur ne connaît aucun fournisseur)', () => {
  it('marchés : top N, devise validée', () => {
    const m = matchCodeTemplate(ct, 'Crée une console des 10 premières cryptos en dollars')!;
    expect(m.template).toBe('marchés');
    expect(m.params).toMatchObject({ n: 10, vs: 'usd' });
    expect(String(m.args.code)).toContain("vs_currency: 'usd'");
    expect(String(m.args.code)).not.toContain('ids:');
  });
  it('historique : entité connue + durée', () => {
    const m = matchCodeTemplate(ct, 'Historique du bitcoin sur 90 jours en euros avec une simulation')!;
    expect(m).toMatchObject({ template: 'historique', params: { coin: 'bitcoin', vs: 'eur', days: 90 } });
    expect(String(m.args.code)).toContain("devise: 'EUR'");
  });
  it('injection dans la demande : rien ne passe dans le code', () => {
    const m = matchCodeTemplate(ct, "historique de « x'); fetch('http://evil') ; ('» sur 30 jours")!;
    expect(String(m.args.code)).not.toContain('evil');
  });
  it('plusieurs cryptos : liste des marchés, pas l’historique d’une seule', () => {
    const m = matchCodeTemplate(ct, 'Bitcoin, Ethereum et Solana, prix en euros, historique sur 30 jours')!;
    expect(m.template).toBe('marchés');
    expect(m.params.vs).toBe('eur');
    expect(String(m.args.code)).not.toContain('ids:');
  });
  it('un MCP nommé en mode code n’est pas confondu avec la démo', async () => {
    const execute = { name: 'execute', description: 'Runs JavaScript code to interact with the API. Example ids bitcoin.', permission: 'read' as const, hint: '', inputSchema: { properties: { code: { type: 'string' }, intent: { type: 'string' } }, required: ['code'] } };
    const factures = { name: 'factures_lister', description: 'Factures, montant en EUR', permission: 'read' as const, hint: '', inputSchema: { properties: {} } };
    const catalog: CatalogServer[] = [
      { serverId: 'demo', name: 'Démo entreprise', demo: true, status: 'connected', tools: [factures], resources: [], prompts: [] },
      { serverId: 'coingecko', name: 'CoinGecko', demo: false, status: 'connected', tools: [execute], resources: [], prompts: [] },
    ];
    const prompt = 'Utilise le MCP CoinGecko. Bitcoin, Ethereum et Solana, prix en euros, variation 24 h, capitalisation, historique 30 jours.';
    expect(namedServerIds(prompt, catalog)).toEqual(['coingecko']);
    const reads = await packReads(catalog.filter((s) => s.serverId === 'coingecko'), prompt);
    expect(reads.map((r) => r.serverId)).toEqual(['coingecko']);
    const resolved = await resolveArgs(reads[0], prompt, catalog);
    expect(resolved.missing).toEqual([]);
    expect(String(resolved.args.code)).toContain("vs_currency: 'eur'");
  });
  it('un outil exigeant du code sans pack est refusé', async () => {
    const r = await resolveArgs({ serverId: 's', serverName: 'Autre', demo: false, tool: { name: 'execute', description: 'run code', permission: 'read', hint: '', inputSchema: { properties: { code: { type: 'string' } }, required: ['code'] } } }, 'fais un graphique', []);
    expect(r.missing[0]).toMatch(/pas de code écrit par le modèle/);
  });
});
