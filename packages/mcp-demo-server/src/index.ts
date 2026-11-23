#!/usr/bin/env -S npx tsx
/**
 * Serveur MCP de démo (aucune clé requise) :
 *   - get_weather  : météo factice mais déterministe pour une ville
 *   - get_time     : heure courante dans un fuseau
 *   - calculate    : calcul arithmétique sécurisé
 *   - list_notes   : lit les notes en mémoire
 *   - add_note     : ÉCRIT une note (outil d'écriture → confirmation requise côté UI)
 *   - get_metrics  : séries de métriques FACTICES qui évoluent dans le temps (ventes, trafic, énergie) + point « live »
 *   - list_alerts  : alertes envoyées
 *   - send_alert   : ACTION — envoie une alerte (écriture, confirmation requise)
 *   - get_sales_by_product : ventes par produit pour une date
 *   - get_funnel   : tunnel de conversion (visites → commande)
 *   - ressources demo://catalogue/produits (prix, stock) et demo://objectifs/ventes
 *   - set_price    : ACTION — change le prix moyen (écriture, effet sur les ventes futures)
 *
 * Transports : stdio (par défaut) ou HTTP streamable (`--http`, port MCP_DEMO_PORT=4010, chemin /mcp).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { z } from 'zod';
import { fakeMetrics, alerts, setPriceFactor, PRODUCTS, OBJECTIFS, salesByProduct, funnel } from './metrics.ts';

const notes: Array<{ id: number; text: string; at: string }> = [];

const CONDITIONS = ['Ensoleillé', 'Nuageux', 'Averses', 'Orageux', 'Brumeux', 'Venteux', 'Neige légère'];
const hash = (s: string) => [...s.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export function fakeWeather(city: string, date = new Date()) {
  const seed = hash(city + date.toISOString().slice(0, 10));
  const temp = Math.round(((seed % 3000) / 100) - 3); // -3 .. 27 °C
  return {
    ville: city,
    temperature_c: temp,
    ressenti_c: temp - (seed % 4),
    condition: CONDITIONS[seed % CONDITIONS.length],
    humidite_pct: 40 + (seed % 55),
    vent_kmh: 5 + (seed % 40),
    previsions: Array.from({ length: 5 }, (_, i) => {
      const s = hash(city + i + date.toISOString().slice(0, 10));
      return { jour: i + 1, min_c: temp - 4 + (s % 5) - 2, max_c: temp + 3 + (s % 4), condition: CONDITIONS[s % CONDITIONS.length] };
    }),
    source: 'mcp-demo (données factices)',
  };
}

export function safeCalc(expression: string): number {
  if (!/^[0-9+\-*/().,\s%^]+$/.test(expression)) throw new Error('Expression non autorisée');
  const js = expression.replace(/,/g, '.').replace(/\^/g, '**');
  const v = Function(`"use strict"; return (${js});`)();
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Résultat invalide');
  return v;
}

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });

function buildServer() {
  const server = new McpServer({ name: 'mcp-demo', version: '0.1.0' });
  server.registerTool('get_weather', {
    title: 'Météo (démo)',
    description: "Météo actuelle et prévisions 5 jours (factices, déterministes) pour une ville",
    inputSchema: { city: z.string().describe('Nom de la ville, ex. Paris') },
    annotations: { readOnlyHint: true },
  }, async ({ city }) => json(fakeWeather(city)));

  server.registerTool('get_time', {
    title: 'Heure',
    description: "Heure et date courantes dans un fuseau IANA (défaut Europe/Paris)",
    inputSchema: { timezone: z.string().optional().describe('Fuseau IANA, ex. Europe/Paris') },
    annotations: { readOnlyHint: true },
  }, async ({ timezone }) => {
    const tz = timezone || 'Europe/Paris';
    const d = new Date();
    return json({ fuseau: tz, iso: d.toISOString(), local: d.toLocaleString('fr-FR', { timeZone: tz }) });
  });

  server.registerTool('calculate', {
    title: 'Calcul',
    description: 'Évalue une expression arithmétique (+ - * / % ^ et parenthèses)',
    inputSchema: { expression: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ expression }) => {
    try { return json({ expression, resultat: safeCalc(expression) }); }
    catch (e) { return { isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] }; }
  });

  server.registerTool('list_notes', {
    title: 'Lister les notes',
    description: 'Liste les notes enregistrées sur le serveur de démo',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => json({ notes }));

  server.registerTool('add_note', {
    title: 'Ajouter une note',
    description: 'Enregistre une note texte sur le serveur de démo (action en écriture)',
    inputSchema: { text: z.string().min(1).max(500) },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ text }) => {
    const note = { id: notes.length + 1, text, at: new Date().toISOString() };
    notes.push(note);
    return json({ ajoutee: note, total: notes.length });
  });
  server.registerTool('get_metrics', {
    title: 'Métriques (démo)',
    description: "Série quotidienne de métriques factices qui évoluent dans le temps (source : ventes | trafic | energie) + point live du jour. Ventes : commandes, prix_moyen, ca_eur, visiteurs, conversion_pct",
    inputSchema: { source: z.enum(['ventes', 'trafic', 'energie']).optional().describe('Source de données (défaut ventes)'), days: z.number().int().min(3).max(90).optional().describe('Nombre de jours (défaut 30)') },
    annotations: { readOnlyHint: true },
  }, async ({ source, days }) => json(fakeMetrics(source ?? 'ventes', days ?? 30)));

  server.registerTool('get_sales_by_product', {
    title: 'Ventes par produit (démo)',
    description: 'Répartition des commandes par produit (sku) pour une date YYYY-MM-DD (défaut : aujourd’hui)',
    inputSchema: { date: z.string().optional().describe('Date YYYY-MM-DD') },
    annotations: { readOnlyHint: true },
  }, async ({ date }) => json(salesByProduct(date)));

  server.registerTool('get_funnel', {
    title: 'Tunnel de conversion (démo)',
    description: 'Volumes par étape du tunnel (visites → fiche produit → panier → paiement → commande) pour une date YYYY-MM-DD (défaut : aujourd’hui)',
    inputSchema: { date: z.string().optional().describe('Date YYYY-MM-DD') },
    annotations: { readOnlyHint: true },
  }, async ({ date }) => json(funnel(date)));

  // Ressources MCP (lecture) : catalogue et objectifs
  server.registerResource('catalogue', 'demo://catalogue/produits', { title: 'Catalogue produits', description: 'Produits avec prix et stock', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ produits: PRODUCTS.map(({ part: _p, ...x }) => x) }) }] }));
  server.registerResource('objectifs', 'demo://objectifs/ventes', { title: 'Objectifs de ventes', description: 'Objectifs personnels du mois', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(OBJECTIFS) }] }));

  server.registerTool('list_alerts', {
    title: 'Alertes envoyées', description: 'Liste les alertes envoyées par send_alert', inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => json({ alertes: alerts }));

  server.registerTool('send_alert', {
    title: 'Envoyer une alerte',
    description: "ACTION : envoie une alerte (démo : enregistrée sur le serveur). Écriture → confirmation de l'utilisateur",
    inputSchema: { message: z.string().min(1).max(500), niveau: z.enum(['info', 'attention', 'critique']).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async ({ message, niveau }) => {
    const a = { id: alerts.length + 1, message, niveau: niveau ?? 'attention', at: new Date().toISOString() };
    alerts.push(a);
    return json({ envoyee: a, total: alerts.length });
  });

  server.registerTool('set_price', {
    title: 'Changer le prix',
    description: "ACTION : applique une variation du prix moyen en % (ex. 5 = +5 %), effet sur les ventes du jour. Écriture → confirmation",
    inputSchema: { percent: z.number().min(-50).max(50) },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, async ({ percent }) => {
    const priceFactor = setPriceFactor(percent);
    return json({ prix_facteur: priceFactor, applique_pct: percent, at: new Date().toISOString() });
  });
  return server;
}

if (process.argv.includes('--http')) {
  const port = Number(process.env.MCP_DEMO_PORT ?? 4010);
  // Mode stateless : un serveur + un transport par requête. Les notes restent partagées (module).
  createServer(async (req, res) => {
    if (req.url?.startsWith('/health')) { res.end(JSON.stringify({ service: 'mcp-demo', status: 'ok' })); return; }
    if (!req.url?.startsWith('/mcp')) { res.statusCode = 404; res.end(); return; }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }).listen(port, () => console.error(`[mcp-demo] HTTP streamable sur :${port}/mcp`));
} else {
  await buildServer().connect(new StdioServerTransport());
  console.error('[mcp-demo] prêt (stdio)');
}
