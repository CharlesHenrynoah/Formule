import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAppShell, missingUiModules, repairChartUsage, repairPanelCalls, repairReactHooks, repairRechartsImports, repairTableColumnShape, repairToastImports, retargetChartImports } from '../src/agent/imports-check.ts';

test('ChartContainer quitte les molécules pour le module chart', () => {
  const src = `import type { ReactNode } from 'react';\nimport { ChartContainer } from '@/components/molecules';\nimport { KpiCard, ChartTooltip } from '@/components/molecules';\n`;
  const fixed = retargetChartImports(src);
  assert.equal(fixed.changed, true);
  assert.match(fixed.code, /import \{ ChartContainer \} from '@\/components\/ui\/chart';\n/);
  assert.doesNotMatch(fixed.code, /;;/);
  assert.match(fixed.code, /import \{ ChartTooltip \} from '@\/components\/ui\/chart'/);
  assert.match(fixed.code, /import \{ KpiCard \} from '@\/components\/molecules'/);
  assert.equal(retargetChartImports(fixed.code).changed, false);
});

test('les primitives ui absentes sont nommées pour installation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'es-ui-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src/App.tsx'), `import { Card } from '@/components/ui/card';\nimport { Skeleton } from '@/components/ui/skeleton';\nimport { Button } from '@/components/ui/button';\n`);
  await mkdir(join(dir, 'src/components/ui'), { recursive: true });
  await writeFile(join(dir, 'src/components/ui/button.tsx'), 'export function Button() { return null }\n');
  assert.deepEqual(missingUiModules(dir, ['card', 'skeleton', 'button']).sort(), ['card', 'skeleton']);
});

test('la page sans enveloppe reçoit AppShell une seule fois', () => {
  const src = `import { KpiCard } from '@/components/molecules';\nexport default function App() {\n  const x = 1;\n  return (\n    <div>{x}</div>\n  );\n}\n`;
  const fixed = ensureAppShell(src);
  assert.equal(fixed.changed, true);
  assert.match(fixed.code, /import \{ AppShell \} from '@\/components\/es\/app-shell';/);
  assert.match(fixed.code, /<AppShell title="Pilotage">\s*<div>\{x\}<\/div>\s*<\/AppShell>/);
  assert.equal(ensureAppShell(fixed.code).changed, false);
});

test('le ChartContainer fictif devient un graphique recharts', () => {
  const src = `import { Bar, BarChart, CartesianGrid, XAxis } from 'recharts';\nexport function ChartPanel({ data, xKey, yKey }) {\n  return <ChartContainer data={data} xKey={xKey} yKey={yKey} type="area" />;\n}\n`;
  const fixed = repairChartUsage(src);
  assert.equal(fixed.changed, true);
  assert.match(fixed.code, /<ChartContainer config=\{\{ serie:/);
  assert.match(fixed.code, /<BarChart data=\{data\}>/);
  assert.equal(repairChartUsage(fixed.code).changed, false);
});

test('un hook react utilisé est ajouté à l’import', () => {
  const src = `import { useState } from "react";\nconst n = useMemo(() => 1, []);\n`;
  const fixed = repairReactHooks(src);
  assert.match(fixed.code, /import \{ useState, useMemo \} from "react"/);
  assert.equal(repairReactHooks(fixed.code).changed, false);
  assert.equal(repairReactHooks(`import * as React from 'react';\nconst n = React.useMemo(() => 1, []);\n`).changed, false);
});

test('use-toast et toaster deviennent sonner', () => {
  const src = `import { useToast } from '@/components/ui/use-toast'\nimport { Toaster } from '@/components/ui/toaster'\nconst { toast } = useToast()\ntoast({ title: 'Sauvé', description: 'ok' })\nexport function App() { return <Toaster /> }\n`;
  const fixed = repairToastImports(src);
  assert.equal(fixed.changed, true);
  assert.doesNotMatch(fixed.code, /use-toast|ui\/toaster|useToast/);
  assert.match(fixed.code, /import \{ toast, Toaster \} from 'sonner'/);
  assert.match(fixed.code, /toast\('Sauvé'\)/);
  assert.equal(repairToastImports(fixed.code).changed, false);
});

test('les graphiques recharts utilisés sont importés', () => {
  const src = `export function ChartPanel() {\n  return <LineChart data={[]}><XAxis /><Line /></LineChart>;\n}\n`;
  const fixed = repairRechartsImports(src);
  assert.match(fixed.code, /import \{ LineChart, XAxis, Line \} from 'recharts'/);
  assert.equal(repairRechartsImports(fixed.code).changed, false);
});

test('TablePanel reçoit rows, pas data', () => {
  const src = `<TablePanel title="PR" columns={['a']} data={rows} rowKey={(r) => r.id} />\n`;
  const fixed = repairPanelCalls(src);
  assert.match(fixed.code, /rows=\{rows\}/);
  assert.doesNotMatch(fixed.code, /\bdata=/);
  assert.equal(repairPanelCalls(fixed.code).changed, false);
});

test('une colonne { key, label } s’affiche en texte', () => {
  const src = `export function TablePanel({ columns, rows }) {\n  return columns.map((col) => <th>{col}</th>);\n  return rows.map((row) => row[col]);\n}\n`;
  const fixed = repairTableColumnShape(src);
  assert.match(fixed.code, /col\.label/);
  assert.doesNotMatch(fixed.code, /\{col\}/);
});
