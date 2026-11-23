/**
 * Charge ../../.env (racine du dépôt) en DONNANT LA PRIORITÉ au fichier sur les variables déjà présentes,
 * sauf pour les valeurs vides du fichier (qui ne masquent rien). ENV_FILE permet de choisir un autre fichier.
 * Dans Docker, le fichier n'existe pas : seules les variables d'environnement comptent.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const path = resolve(process.env.ENV_FILE ?? '../../.env');
try {
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (value !== '') process.env[key] = value;
  }
} catch { /* pas de .env : valeurs par défaut / environnement */ }

export const BIND_HOST = process.env.BIND_HOST ?? '0.0.0.0';
