import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonicalJson, deepFreeze } from '../canonical.js';
import { redact } from '../redact.js';
import type { AcquisitionEnvelope, Coverage, FailureKind } from '../envelope.js';

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export interface EnvelopeInput {
  serverId: string; serverName: string; demo: boolean; tool: string; args: Record<string, unknown>;
  requestId?: string; schemaVersion?: string; observedAt?: string | null; coverage?: Coverage;
  raw?: unknown; error?: { kind: FailureKind; message: string };
}

/** Enveloppe immuable. L'empreinte porte sur les octets canoniques du brut. */
export function makeEnvelope(input: EnvelopeInput): { envelope: AcquisitionEnvelope; rawBytes: string | null } {
  const id = newId('acq');
  const rawBytes = input.raw === undefined ? null : canonicalJson(input.raw);
  const isEmpty = input.raw !== undefined && (input.raw === null || (Array.isArray(input.raw) && input.raw.length === 0));
  const coverage = input.coverage ?? { complete: true, pages: 1 };
  const status: AcquisitionEnvelope['status'] = input.error ? 'error' : isEmpty ? 'empty' : coverage.complete ? 'ok' : 'partial';
  const envelope: AcquisitionEnvelope = {
    id,
    source: { serverId: input.serverId, serverName: input.serverName, demo: input.demo },
    tool: input.tool,
    args: redact(input.args),
    status,
    ...(input.error ? { error: input.error } : {}),
    requestId: input.requestId ?? newId('req'),
    schemaVersion: input.schemaVersion ?? 'inconnue',
    fetchedAt: new Date().toISOString(),
    observedAt: input.observedAt ?? null,
    coverage,
    rawRef: rawBytes ? `snapshot:${id}` : '',
    hash: rawBytes ? sha256(rawBytes) : null,
  };
  return { envelope: deepFreeze(envelope) as AcquisitionEnvelope, rawBytes };
}

export function verifyRawHash(env: AcquisitionEnvelope, rawBytes: string): boolean {
  return env.hash !== null && sha256(rawBytes) === env.hash;
}

// ---- Confirmations liées à l'opération exacte ----
export interface Operation { serverId: string; tool: string; args: Record<string, unknown> }
export const operationHash = (op: Operation) => sha256(canonicalJson({ s: op.serverId, t: op.tool, a: op.args }));

export function issueConfirmation(op: Operation, secret: string, ttlMs = 120_000, now = Date.now()) {
  const payload = { h: operationHash(op), exp: now + ttlMs, n: randomUUID() };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return { token: `${body}.${sig}`, opHash: payload.h, expiresAt: new Date(payload.exp).toISOString(), nonce: payload.n };
}

export type ConfirmCheck = { ok: true; nonce: string } | { ok: false; reason: 'missing' | 'bad_signature' | 'expired' | 'mismatch' };

export function verifyConfirmation(token: string | undefined, op: Operation, secret: string, now = Date.now()): ConfirmCheck {
  if (!token) return { ok: false, reason: 'missing' };
  const [body, sig] = token.split('.');
  if (!body || !sig) return { ok: false, reason: 'bad_signature' };
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'bad_signature' };
  const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as { h: string; exp: number; n: string };
  if (p.exp < now) return { ok: false, reason: 'expired' };
  if (p.h !== operationHash(op)) return { ok: false, reason: 'mismatch' };
  return { ok: true, nonce: p.n };
}
