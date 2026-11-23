/**
 * Garde-fous contre les erreurs d'exécution des mini-apps (« Minified React error #130 ») :
 * dé-minification, validation statique des imports, tsc « runtime », smoke render headless, boucle de correction.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeReactError, explainError } from '../src/agent/react-errors.ts';
import { checkImports, parseImports } from '../src/agent/imports-check.ts';
import { MAX_SMOKE_FIXES, Workspace, runtimeTscErrors } from '../src/agent/workspace.ts';
import { findChrome, smokeRender } from '../src/agent/smoke.ts';

const ERR130 = 'Uncaught Error: Minified React error #130; visit https://react.dev/errors/130?args[]=undefined&args[]= for the full message or use the non-minified dev environment for full errors and additional helpful warnings.';
const chrome = findChrome();

test('dé-minification : React #130 → composant undefined + piste de correction', () => {
  const d = decodeReactError(ERR130)!;
  assert.equal(d.code, '130');
  assert.deepEqual(d.args, ['undefined', '']);
  assert.match(d.message, /got: undefined/);
  assert.match(explainError(ERR130), /icône lucide-react inexistante.*export nommé\/par défaut/s);
  assert.equal(decodeReactError('TypeError: x is undefined'), null);
});

test('parseImports : défaut, nommés, alias et types', () => {
  const [a, b] = parseImports("import Badge, { X as Y, type T } from '@/components/ui/badge';\nimport type { Q } from 'x';");
  assert.equal(a.defaultName, 'Badge'); assert.deepEqual(a.names, ['X']); assert.equal(b.typeOnly, true);
});

function fakeApp(app: string) {
  const dir = mkdtempSync(join(tmpdir(), 'es-imports-'));
  mkdirSync(join(dir, 'src/components/ui'), { recursive: true });
  mkdirSync(join(dir, 'src/components/es'), { recursive: true });
  mkdirSync(join(dir, 'node_modules/lucide-react'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"x","private":true}');
  writeFileSync(join(dir, 'node_modules/lucide-react/package.json'), '{"name":"lucide-react","main":"index.js","types":"index.d.ts"}');
  writeFileSync(join(dir, 'node_modules/lucide-react/index.js'), 'exports.Activity = function Activity(){}; exports.ShieldAlert = function ShieldAlert(){};');
  writeFileSync(join(dir, 'node_modules/lucide-react/index.d.ts'), 'export type LucideIcon = any; export declare const Activity: LucideIcon;');
  writeFileSync(join(dir, 'src/components/ui/badge.tsx'), 'function Badge() { return null }\nexport { Badge }\n');
  writeFileSync(join(dir, 'src/components/es/actions.tsx'), "export const ACTION_COMPONENTS = ['Alert', 'Button'] as const;\nexport function ActionView() { return null }\n");
  writeFileSync(join(dir, 'src/App.tsx'), app);
  return dir;
}

test('imports : icône lucide inexistante et export par défaut manquant → détectés (cas React #130)', () => {
  const dir = fakeApp("import { Activity, ShieldWarning, type LucideIcon } from 'lucide-react';\nimport Badge from '@/components/ui/badge';\nimport { ActionView } from '@/components/es/actions';\nconst a = { component: 'Gauge' };\nexport default function App() { return <Badge><Activity /><ShieldWarning /></Badge>; }\n");
  const ps = checkImports(dir, ['src/App.tsx']);
  const kinds = ps.map((p) => `${p.kind}:${p.name}`).sort();
  assert.deepEqual(kinds, ['missing-default:Badge', 'unknown-action:Gauge', 'unknown-icon:ShieldWarning']);
  assert.match(ps.find((p) => p.kind === 'unknown-icon')!.message, /ShieldAlert/); // suggestion proche
  assert.match(ps.find((p) => p.kind === 'missing-default')!.message, /import \{ Badge \}/);
  // Version corrigée : plus aucun problème.
  const ok = fakeApp("import { Activity, ShieldAlert, type LucideIcon } from 'lucide-react';\nimport { Badge } from '@/components/ui/badge';\nexport default function App() { const I: LucideIcon = Activity; return <Badge><I /><ShieldAlert /></Badge>; }\n");
  assert.deepEqual(checkImports(ok, ['src/App.tsx']), []);
});

test('tsc « runtime » : <p.Icon /> (TS2551/TS2339 en balise JSX) bloquant, simple écart de typage toléré', () => {
  const src = 'const x = 1;\n    <span><p.Icon className="a" /></span>\nconst y = obj.foo;\n';
  const out = [
    "src/App.tsx(2,15): error TS2339: Property 'Icon' does not exist on type 'Pad'.",
    "src/App.tsx(3,15): error TS2339: Property 'foo' does not exist on type '{}'.",
    "src/App.tsx(9,70): error TS2551: Property 'Icon' does not exist on type 'Pad'. Did you mean 'icon'?",
    "src/App.tsx(4,1): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/App.tsx(5,1): error TS1192: Module '\"@/components/ui/badge\"' has no default export.",
  ].join('\n');
  const f = runtimeTscErrors(out, () => src);
  assert.equal(f.length, 3);
  assert.match(f[0], /TS2339.*Icon.*React #130/);
  assert.match(f[1], /TS2551/); assert.match(f[2], /TS1192/);
});

test('smoke render : erreur React minifiée détectée et dé-minifiée, écran blanc détecté, données factices servies', { skip: !chrome && 'Chrome absent' }, async () => {
  const bad = `<html><head></head><body><div id="root"></div><script>window.app.call('list').then(function(r){document.getElementById('root').textContent=JSON.stringify(r);setTimeout(function(){throw new Error(${JSON.stringify(ERR130.replace('Uncaught Error: ', ''))})})})</script></body></html>`;
  const r = await smokeRender(bad, { fixtures: { list: [1, 2] }, waitMs: 1200 });
  assert.equal(r.ok, false); assert.match(r.errors[0], /React #130.*got: undefined/s);
  const ok = await smokeRender('<html><head></head><body><div id="root"></div><script>window.app.call("list").then(function(r){document.getElementById("root").innerHTML="<p>"+r.length+"</p>"});window.app.call("absent").catch(function(){})</script></body></html>', { fixtures: { list: [1, 2, 3] }, waitMs: 1200 });
  assert.equal(ok.ok, true, ok.errors.join('\n'));
  const blank = await smokeRender('<html><body><div id="root"></div></body></html>', { waitMs: 800 });
  assert.equal(blank.ok, false); assert.match(blank.errors[0], /Écran blanc/);
});

test('build du workspace : #130 (icône inexistante + export par défaut manquant) détecté puis corrigé ; bug runtime pur attrapé par le smoke render', { skip: !Workspace.templateReady() && 'template absent', timeout: 300_000 }, async () => {
  const ws = await Workspace.create();
  await ws.write('src/App.tsx', "import { AppShell, Panel } from '@/components/es/app-shell';\nimport { Activity, ShieldWarningX } from 'lucide-react';\nimport Badge from '@/components/ui/badge';\nexport default function App() { return <AppShell title=\"T\"><Panel title=\"P\"><Badge><Activity /><ShieldWarningX /></Badge></Panel></AppShell>; }\n");
  const r1 = await ws.build();
  assert.equal(r1.ok, false);
  assert.match(r1.output, /icône lucide-react inexistante « ShieldWarningX »/);
  assert.match(r1.output, /import par défaut « Badge »/);
  // Correction (ce que fait le Développeur avec ce retour) → build vert + smoke render OK.
  await ws.write('src/App.tsx', "import { AppShell, Panel } from '@/components/es/app-shell';\nimport { Activity, ShieldAlert } from 'lucide-react';\nimport { Badge } from '@/components/ui/badge';\nexport default function App() { return <AppShell title=\"T\"><Panel title=\"P\"><Badge><Activity /><ShieldAlert /></Badge></Panel></AppShell>; }\n");
  const r2 = await ws.build();
  assert.equal(r2.ok, true, r2.output);
  if (chrome) assert.equal(r2.smoke?.ok, true, r2.smoke?.errors.join('\n'));
  // Le bug exact de la « Console de supervision n8n » : type Pad { icon } mais <p.Icon /> → bloqué par tsc (TS2551).
  await ws.write('src/App.tsx', "import { AppShell, Panel } from '@/components/es/app-shell';\nimport { Activity, type LucideIcon } from 'lucide-react';\ntype Pad = { key: string; icon: LucideIcon };\nconst pads: Pad[] = [{ key: '1', icon: Activity }];\nexport default function App() { return <AppShell title=\"T\"><Panel title=\"Pads\">{pads.map((p) => <p.Icon key={p.key} />)}</Panel></AppShell>; }\n");
  const rp = await ws.build();
  assert.equal(rp.ok, false); assert.match(rp.output, /TS2551: Property 'Icon' does not exist/);
  if (!chrome) return;
  // Bug invisible pour tsc (any) : seul le smoke render le voit ; l'error boundary du panneau le nomme.
  await ws.write('src/App.tsx', "import { AppShell, Panel } from '@/components/es/app-shell';\nimport { Activity } from 'lucide-react';\nconst pads: any[] = [{ key: '1', icon: Activity }];\nexport default function App() { return <AppShell title=\"T\"><Panel title=\"Pads\">{pads.map((p) => <p.Icon key={p.key} />)}</Panel></AppShell>; }\n");
  const r3 = await ws.build();
  assert.equal(r3.ok, false);
  assert.match(r3.output, /Panneau « Pads » : React #130/);
  assert.match(r3.output, /passe 1\//);
  // Boucle bornée : au-delà de MAX_SMOKE_FIXES passes, livrée avec avertissement (error boundaries en place).
  ws.smokeFails = MAX_SMOKE_FIXES;
  const r4 = await ws.build();
  assert.equal(r4.ok, true); assert.match(r4.output, /AVERTISSEMENT : smoke render toujours en échec/);
  assert.match(r4.html ?? '', /Ce panneau a une erreur/);
  assert.match(r4.html ?? '', /Demander au contremaître de corriger/);
});
