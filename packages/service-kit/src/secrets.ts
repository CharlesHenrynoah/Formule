import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { dataDir } from './index.js';

/** Secrets isolés : fichier chmod 600 ou variables d'environnement. Jamais dans les logs, prompts ou bundles. */
interface SecretFile { servers: Record<string, string>; confirmSecret: string; humanKey: string }

const file = () => path.join(dataDir('secrets'), 'secrets.json');

export function loadSecrets(): SecretFile {
  const f = file();
  if (!existsSync(f)) {
    const init: SecretFile = { servers: {}, confirmSecret: randomBytes(32).toString('hex'), humanKey: randomBytes(24).toString('hex') };
    writeFileSync(f, JSON.stringify(init, null, 2), { mode: 0o600 });
  }
  chmodSync(f, 0o600);
  return JSON.parse(readFileSync(f, 'utf8'));
}

export function saveServerToken(serverId: string, token: string | null) {
  const s = loadSecrets();
  if (token) s.servers[serverId] = token; else delete s.servers[serverId];
  writeFileSync(file(), JSON.stringify(s, null, 2), { mode: 0o600 });
}

export function serverToken(serverId: string): string | undefined {
  const env = process.env[`FORMULE_SECRET_${serverId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  return env || loadSecrets().servers[serverId];
}

export const confirmSecret = () => process.env.FORMULE_CONFIRM_SECRET || loadSecrets().confirmSecret;
export const humanKey = () => process.env.FORMULE_HUMAN_KEY || loadSecrets().humanKey;

/** Variable d'environnement secrète d'un serveur stdio : FORMULE_SECRET_<ID>_<NOM> ou secrets.json (clé « id:NOM »). */
export function serverEnvSecret(serverId: string, name: string): string | undefined {
  const env = process.env[`FORMULE_SECRET_${serverId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${name.toUpperCase()}`];
  return env || loadSecrets().servers[`${serverId}:${name}`];
}
export function saveServerEnvSecret(serverId: string, name: string, value: string) { saveServerToken(`${serverId}:${name}`, value); }
