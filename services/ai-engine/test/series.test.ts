import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignPairSeries, keepSpan } from '../src/agent/engine/series.ts';

test('deux séries se rejoignent par horodatage, pas par leur indice', () => {
  const rows = alignPairSeries({
    prices: [[1, 10], [3, 30]],
    volumes: [[2, 5], [3, 8]],
  });
  assert.ok(rows);
  assert.equal(rows![0].date, 1);
  assert.equal(rows![0].prices, 10);
  assert.equal(rows![0].volumes, undefined);
  assert.equal(rows![1].date, 2);
  assert.equal(rows![1].volumes, 5);
  assert.equal(rows![2].date, 3);
  assert.equal(rows![2].prices, 30);
  assert.equal(rows![2].volumes, 8);
});

test('une série plus longue que le plafond garde la première et la dernière observation', () => {
  const points = Array.from({ length: 10 }, (_, index) => [index, index * 2]);
  const rows = alignPairSeries({ mesure: points }, 4);
  assert.deepEqual(rows?.map((row) => row.date), [0, 3, 6, 9]);
  assert.equal(rows?.at(-1)?.mesure, 18);
});

test('un horodatage en millisecondes garde l’heure', () => {
  const rows = alignPairSeries({ prices: [[1_700_000_000_000, 64.2]] });
  assert.equal(rows?.[0]?.date, '2023-11-14T22:13:20.000Z');
});

test('keepSpan sur une liste courte ne retire rien', () => {
  assert.deepEqual(keepSpan([1, 2, 3], 10), [1, 2, 3]);
});
