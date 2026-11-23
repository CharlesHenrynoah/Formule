import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactSample, compactToolSchema, defaultsFromSchema, isSizeError, jsonSize, prepareCallArgs, slimArgs,
} from '../src/agent/mcp-sample.ts';

test('defaultsFromSchema : pagination → 5, page → 1', () => {
  const d = defaultsFromSchema({
    type: 'object',
    properties: {
      limit: { type: 'integer' },
      page: { type: 'integer' },
      city: { type: 'string' },
      mode: { type: 'string', enum: ['live', 'hist'] },
    },
  });
  assert.equal(d.limit, 5);
  assert.equal(d.page, 1);
  assert.equal(d.mode, 'live');
  assert.equal(d.city, undefined);
});

test('slimArgs : dump massif → ids + pagination seulement', () => {
  const huge = { owner: 'acme', limit: 50, payload: 'x'.repeat(50_000), items: Array.from({ length: 200 }, (_, i) => ({ i, blob: 'y'.repeat(200) })) };
  const { args, trimmed, bytes } = slimArgs(huge, 18_000);
  assert.ok(trimmed);
  assert.ok(bytes <= 18_000);
  assert.equal(args.owner, 'acme');
  assert.ok(!args.payload || String(args.payload).length < 500);
});

test('prepareCallArgs : fusionne défauts et allège', () => {
  const schema = { properties: { per_page: { type: 'integer' }, q: { type: 'string' } } };
  const { args } = prepareCallArgs({ q: 'prs' }, schema);
  assert.equal(args.q, 'prs');
  assert.equal(args.per_page, 5);
});

test('compactSample : tableau → 5 items + _plus', () => {
  const data = Array.from({ length: 40 }, (_, i) => ({ id: i, name: `n${i}` }));
  const { echantillon, truncated } = compactSample(data);
  assert.ok(truncated);
  assert.ok(Array.isArray(echantillon));
  assert.ok((echantillon as unknown[]).length <= 6);
  assert.ok(jsonSize(echantillon) < jsonSize(data));
});

test('compactToolSchema : schéma énorme tronqué', () => {
  const props: Record<string, unknown> = {};
  for (let i = 0; i < 80; i++) props[`field_${i}`] = { type: 'string', description: 'd'.repeat(200) };
  const c = compactToolSchema({ type: 'object', properties: props }, 800) as { truncated?: boolean; keys?: number };
  assert.equal(c.truncated, true);
  assert.equal(c.keys, 80);
});

test('isSizeError détecte le message gateway', () => {
  assert.ok(isSizeError('arguments trop volumineux'));
  assert.ok(isSizeError('HTTP 413'));
  assert.ok(!isSizeError('outil inconnu'));
});
