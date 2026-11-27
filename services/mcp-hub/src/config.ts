import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataDir, findRepoRoot } from '@formule/service-kit';

export type Permission = 'read' | 'write' | 'off';
export interface ServerConfig {
  id: string;                 // identifiant stable, distinct du nom affiché
  name: string;
  transport: 'stdio' | 'http' | 'sse' | 'files';
  url?: string;
  command?: string;
  args?: string[];
  enabled: boolean;
  demo: boolean;
  hasToken?: boolean;
  tokenMask?: string;
  tools: Record<string, Permission>; // liste blanche ; non classé = refusé
  env?: Record<string, string>;      // variables non secrètes transmises au processus stdio
  secretEnv?: string[];              // noms de variables secrètes (valeurs dans secrets.json, chmod 600)
}

const file = () => path.join(dataDir('mcp'), 'servers.json');

function defaults(): ServerConfig[] {
  const root = findRepoRoot();
  return [
    {
      id: 'demo', name: 'Démo entreprise', transport: 'stdio', demo: true, enabled: true,
      command: process.execPath, args: ['--import', 'tsx', path.join(root, 'servers/demo-mcp/src/index.ts')],
      tools: {
        factures_lister: 'read', affaires_lister: 'read', campagnes_lister: 'read', inscriptions_serie: 'read',
        campagne_mettre_en_pause: 'write', affaire_changer_etape: 'write',
      },
    },
    { id: 'fichiers', name: 'Fichiers joints', transport: 'files', demo: false, enabled: true, tools: {} },
  ];
}

export function loadConfig(): ServerConfig[] {
  if (!existsSync(file())) saveConfig(defaults());
  const cfg = JSON.parse(readFileSync(file(), 'utf8')) as ServerConfig[];
  // le chemin du serveur démo suit l'emplacement du dépôt
  const demo = cfg.find((s) => s.id === 'demo');
  if (demo) { const d = defaults()[0]; demo.command = d.command; demo.args = d.args; }
  return cfg;
}

export function saveConfig(cfg: ServerConfig[]) { writeFileSync(file(), JSON.stringify(cfg, null, 2)); }
