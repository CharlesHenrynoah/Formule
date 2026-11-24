import type { DataContract } from '../../../../packages/contracts/src/types.ts';
import { linkChain } from '../agent/engine/chain.ts';
import { testDataIntegrity, testRenderedFields, testSchema, type Check } from './assertions.ts';

export type Report = { passed: boolean; failures: Check[]; checks: Check[] };

/** Preuves indépendantes du message du modèle. Un build réussi n'entre pas dans ce rapport. */
export function evaluate(input: {
  prompt?: string;
  page?: string;
  raw?: Array<Record<string, unknown>>;
  stored?: Array<Record<string, unknown>>;
  contract?: DataContract;
}): Report {
  const raw = input.raw ?? [];
  const stored = input.stored ?? raw;
  const checks: Check[] = [];
  if (input.contract) checks.push(testSchema(stored, input.contract), testDataIntegrity(raw, stored, input.contract));
  const keys = [...new Set([...raw, ...stored].flatMap((row) => Object.keys(row)))];
  if (input.prompt) {
    const chain = linkChain(input.prompt, keys);
    checks.push({ id: 'intention', ok: chain.ok, note: chain.ok ? 'exigences tenues' : 'exigence obligatoire ouverte' });
    if (input.page) {
      const measures = new Set(chain.claims.filter((claim) => claim.kind === 'mesure').map((claim) => claim.id));
      const held = [...new Set(chain.links.filter((link) => link.state === 'tenu' && link.field && measures.has(link.claim)).map((link) => link.field!))];
      if (held.length) checks.push(testRenderedFields(input.page, held));
    }
  }
  const failures = checks.filter((check) => !check.ok);
  return { passed: failures.length === 0, failures, checks };
}
