#!/usr/bin/env node
// Enregistre un serveur MCP stdio dans la configuration locale (l'ajout stdio depuis l'UI est désactivé par défaut).
// Usage :
//   node scripts/mcp-add.mjs --id fs --name "Fichiers" --read read_text_file,list_allowed_directories -- npx -y @modelcontextprotocol/server-filesystem /chemin/données
// Les outils non listés restent refusés. --write ajoute des outils d'écriture (confirmation humaine obligatoire).
// --env "A=1,B=2" : variables non secrètes. --secret-env NOM[,NOM2] : valeur lue dans TON environnement au moment
// de l'enregistrement, stockée dans data/secrets/secrets.json (chmod 600), jamais dans servers.json.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 0) { console.error('Usage : mcp-add.mjs --id <id> --name <nom> [--read a,b] [--write c] -- <commande> [args…]'); process.exit(1); }
const opts = {}; for (let i = 0; i < sep; i += 2) opts[argv[i].replace(/^--/, '')] = argv[i + 1];
const [command, ...args] = argv.slice(sep + 1);
if (!opts.id || !/^[a-z0-9-]{1,24}$/.test(opts.id)) { console.error('--id requis (a-z, 0-9, -)'); process.exit(1); }
const dir = path.resolve(process.env.FORMULE_DATA_DIR ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'data'), 'mcp');
mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'servers.json');
const cfg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
const tools = {};
for (const t of (opts.read ?? '').split(',').filter(Boolean)) tools[t] = 'read';
for (const t of (opts.write ?? '').split(',').filter(Boolean)) tools[t] = 'write';
const env = Object.fromEntries((opts.env ?? '').split(',').filter(Boolean).map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
const secretEnv = (opts['secret-env'] ?? '').split(',').filter(Boolean);
if (secretEnv.length) {
  const sdir = path.join(path.dirname(dir), 'secrets'); mkdirSync(sdir, { recursive: true });
  const sfile = path.join(sdir, 'secrets.json');
  const sec = existsSync(sfile) ? JSON.parse(readFileSync(sfile, 'utf8')) : { servers: {}, confirmSecret: randomBytes(32).toString('hex'), humanKey: randomBytes(24).toString('hex') };
  for (const n of secretEnv) { if (!process.env[n]) { console.error(`variable ${n} absente de l’environnement`); process.exit(1); } sec.servers[`${opts.id}:${n}`] = process.env[n]; }
  writeFileSync(sfile, JSON.stringify(sec, null, 2), { mode: 0o600 }); chmodSync(sfile, 0o600);
}
// --demo true : toutes les données de ce serveur sont marquées DÉMO (jeux synthétiques, tests de contrat)
const entry = { id: opts.id, name: opts.name ?? opts.id, transport: 'stdio', command, args, enabled: true, demo: opts.demo === 'true', tools, env, secretEnv };
const i = cfg.findIndex((s) => s.id === opts.id);
if (i >= 0) cfg[i] = { ...cfg[i], ...entry, tools: { ...cfg[i].tools, ...tools } }; else cfg.push(entry);
if (!existsSync(file) && !cfg.some((s) => s.id === 'demo')) console.warn('Note : le serveur démo sera ajouté au premier démarrage du hub.');
writeFileSync(file, JSON.stringify(cfg, null, 2));
console.log(`✓ ${opts.id} enregistré (${Object.keys(tools).length} outil(s) autorisé(s)) dans ${file}`);
