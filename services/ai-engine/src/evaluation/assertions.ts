import type { DataContract } from '../../../../packages/contracts/src/types.ts';
import { linkChain } from '../agent/engine/chain.ts';

export type Check = { id: string; ok: boolean; note: string };

export function testSchema(rows: Array<Record<string, unknown>>, contract: DataContract): Check {
  const missing = contract.fields.filter((field) => !field.nullable && rows.length > 0 && rows.every((row) => !(field.path in row)));
  return { id: 'schema', ok: missing.length === 0, note: missing.length ? `champs absents : ${missing.map((field) => field.path).join(', ')}` : 'schéma respecté' };
}

export function testDataIntegrity(raw: Array<Record<string, unknown>>, stored: Array<Record<string, unknown>>, contract: DataContract): Check {
  const measures = contract.fields.filter((field) => field.role === 'measure');
  for (const field of measures) {
    const origin = raw.find((row) => typeof row[field.path] === 'number')?.[field.path];
    if (typeof origin !== 'number') continue;
    const kept = stored.some((row) => row[field.path] === origin);
    if (!kept) return { id: 'integrite', ok: false, note: `${field.path} = ${origin} perdu après transformation` };
  }
  return { id: 'integrite', ok: true, note: 'mesures conservées' };
}

export function testIntentCoverage(prompt: string, fields: string[]): Check {
  if (!prompt.trim()) return { id: 'intention', ok: true, note: 'pas de demande à couvrir' };
  const chain = linkChain(prompt, fields);
  return { id: 'intention', ok: chain.ok, note: chain.ok ? 'exigences tenues' : 'exigence obligatoire ouverte' };
}

export function testRenderedFields(page: string, fields: string[]): Check {
  const missing = fields.filter((field) => !new RegExp(`(?:row|item|data)\\.${field}\\b|dataKey=["']${field}["']`).test(page));
  return { id: 'rendu', ok: missing.length === 0, note: missing.length ? `rendu sans ${missing.join(', ')}` : 'champs lus à l\'écran' };
}
