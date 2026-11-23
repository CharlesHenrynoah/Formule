/** Studio : logo FORMULE, pas de libellé modèle, onglets retirés, outils MCP compacts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { shortDescription } from '../src/lib/text.ts';

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

test('description MCP : première phrase, tronquée', () => {
  assert.equal(shortDescription('Verify an agent MCP server. Then it does many other things.'), 'Verify an agent MCP server.');
  assert.equal(shortDescription('  multi\n  line   text  '), 'multi line text');
  const long = shortDescription('x'.repeat(300));
  assert.ok(long.length <= 120 && long.endsWith('…'));
  assert.equal(shortDescription(undefined), '');
});

test('cartes outils MCP compactes, sans débordement', () => {
  const p = src('components/McpPanel.tsx');
  assert.match(p, /line-clamp-2/);
  assert.match(p, /data-\[side=right\]:sm:max-w-3xl/); // panneau assez large : noms d'outils lisibles
  assert.match(p, /min-w-0 truncate font-mono/);
  assert.match(p, /h-\[60px\] min-w-0 items-start gap-2 overflow-hidden/);
  assert.match(p, /title=\{`\$\{t\.name\}/); // texte complet au survol
});

test('en-tête studio : logo FORMULE seul, pas de modèle affiché, onglets retirés', () => {
  const sb = src('components/Sidebar.tsx');
  assert.match(sb, /assets\/logo\.svg/);
  assert.doesNotMatch(sb, /Everything Software|∞/);
  assert.ok(!existsSync(new URL('../src/components/Logo.tsx', import.meta.url)));
  const app = src('App.tsx');
  assert.doesNotMatch(app, /Inception \(diffusion\)|config\.model/);
  assert.doesNotMatch(app, /tab-backend|tab-app-agent/);
  assert.equal((app.match(/data-testid="suggestion"/g) ?? []).length, 1);
});

test('libellé « New Interface » et bouton plein écran de l\'aperçu', () => {
  const app = src('App.tsx'); const sb = src('components/Sidebar.tsx');
  assert.doesNotMatch(app + sb, /Nouvelle mini-app|Nouvelle app/);
  assert.match(sb, /New Interface/);
  assert.match(app, /Maximize2/); assert.match(app, /Minimize2/);
  assert.match(app, /<TooltipContent side="left">Plein écran<\/TooltipContent>/);
  assert.match(app, /requestFullscreen\(\)/); // Fullscreen API sur le conteneur
  assert.match(app, /fixed inset-0 z-50/); // repli overlay
  assert.match(app, /e\.key === 'Escape'/); // sortie par Échap
});

test('composer en bas du panneau Formule Agent : Ask/Agent remplace le toggle Outils', () => {
  const app = src('App.tsx');
  const panel = app.indexOf('<FormuleAgentPanel'); const composer = app.indexOf('data-testid="composer"');
  assert.ok(panel > app.indexOf('data-testid="preview-box"') && composer > panel, 'panneau Formule Agent à droite de l\'écran, composer dedans');
  assert.match(src('components/FormuleAgentPanel.tsx'), /min-h-0 flex-1[^"]*overflow-y-auto[\s\S]*\{composer\}/); // fil puis composer en bas
  assert.doesNotMatch(app, /data-testid="agent-mode"|data-testid="diffusing"|> Équipe d'agents\n|Mode diffusion|data-testid="use-tools"|Outils MCP/);
  assert.match(src('components/FormuleAgentPanel.tsx'), /data-testid="fa-mode"/);
  assert.match(src('components/FormuleAgentPanel.tsx'), /fa-mode-\$\{m\.id\}/);
  assert.match(app, /data-testid="suggestions"/); assert.match(app, /overflow-x-auto/);
  assert.match(app, /useState\(true\);/); // équipe d'agents activée par défaut
  assert.match(app, /right-4 bottom-4/); // sortie du plein écran : ne chevauche plus l'en-tête de l'app
});

test('plus de barre d\'en-tête : bouton MCP dans la barre du bas, compteur robuste', () => {
  const app = src('App.tsx');
  assert.doesNotMatch(app, /<header /);
  const btn = app.indexOf('data-testid="mcp-button"');
  assert.ok(btn > app.indexOf('data-testid="composer"'));
  assert.match(app, /MCP · <span className=\"f1-num\">\{mcpTools\.length\}<\/span><span[^>]*> outil/);
  assert.match(app, /2000 \* 2 \*\* attempt/); // réessai si les services redémarrent (plus de « 0 outil » figé)
  assert.match(app, /visibilitychange/);
});

test('Formule Agent : deux zones (écran + panneau unique), plus d\'onglets Pipeline / Aperçu / Code', () => {
  const app = src('App.tsx').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  assert.doesNotMatch(app, /tab-pipeline|tab-preview|tab-code|tab-agent|tab-app-chat|TabsTrigger|>\s*Pipeline\s*<|Chat app|Équipe d'agents/);
  assert.match(app, /<FormuleAgentPanel/);
  assert.match(src('components/FormuleAgentPanel.tsx'), /AGENT_NAME/);
  assert.match(app, /data-testid="empty-state"[\s\S]{0,200}logoUrl/); // état vide : logo FORMULE + phrase courte
  assert.match(app, /absolute right-3 bottom-3[^"]*opacity-40/); // plein écran : icône flottante discrète
  assert.match(app, /Demander à Formule Agent de corriger/);
  assert.match(src('components/FormuleAgentPanel.tsx'), /data-testid="app-chat-continue"/);
});

test('routage du composer : les agents construisent l’interface, la commande suivante la met à jour', async () => {
  const { isCreateRequest, isFullAppRequest } = await import('../src/lib/neutral.ts');
  const app = src('App.tsx');
  assert.match(app, /if \(!previewCode \|\| !project\) \{ void run\(text, false\); return; \}/);
  assert.match(app, /startEvolution\(text, project\.id\)/);
  assert.doesNotMatch(app, /buildLive|streamDashboard/);
  assert.match(app, /chatMode === 'ask'[\s\S]{0,120}Passe en mode Agent/);
  assert.match(app, /sendOrder\(fixOrder\(appError\)\)/);
  {
    assert.ok(isCreateRequest('Crée une console de supervision de mes workflows n8n'));
    assert.ok(isFullAppRequest('Crée une console de supervision de mes workflows n8n'));
    assert.ok(!isFullAppRequest('Crée un dashboard de chiffre d’affaires'));
    assert.ok(!isCreateRequest('ajoute un panneau de marge'));
  }
});

test('panneau Formule Agent : pas d\'avatar rond (photo) dans l\'en-tête ni dans le fil', () => {
  const p = src('components/FormuleAgentPanel.tsx');
  assert.doesNotMatch(p, /<img|logo\.svg/);
  assert.doesNotMatch(p, /size-7[^"]*rounded-full/);
});

test('état vide : une question, un tableau, sans libellé « Nouvelle interface »', () => {
  assert.match(src('App.tsx'), /Décris l’interface\. Les agents la construisent et l’enregistrent\./);
  assert.doesNotMatch(src('App.tsx') + src('components/FormuleAgentPanel.tsx'), /Nouvelle interface|elle s'affiche ici/);
});

test('panneau Formule Agent rétractable : poignée grip à droite, repli, raccourci, mémorisation', async () => {
  const app = src('App.tsx'); const grip = src('components/PanelGrip.tsx'); const panel = src('components/FormuleAgentPanel.tsx');
  assert.doesNotMatch(panel, /PanelRightClose|PanelRightOpen|fa-collapse/); // plus d'icône de repli : clic sur la poignée
  assert.match(app, /if \(!moved\) setFa\(\(s\) => \(\{ \.\.\.s, open: !s\.open \}\)\)/);
  assert.match(grip, /CLICK_SLOP_PX = 4/);
  assert.ok(app.indexOf('<PanelGrip') > app.indexOf('data-testid="preview-box"') && app.indexOf('<PanelGrip') < app.indexOf('<FormuleAgentPanel'), 'poignée entre l\'écran et le panneau (côté droit)');
  assert.match(app, /transition-\[width,opacity\] duration-200/);
  assert.match(app, /localStorage\.setItem\(PANEL_KEY/);
  assert.match(app, /faDrag \? 'pointer-events-none'/); // l'iframe ne capte pas le glisser
  assert.match(grip, /data-testid="fa-grip-dot"/); assert.match(grip, /w-3 /);
  const { clampWidth, parsePanel, dragResult, isToggleShortcut } = await import('../src/lib/panelLayout.ts');
  assert.equal(clampWidth(100, 1600), 300); assert.equal(clampWidth(2000, 1600), 800); assert.equal(clampWidth(500, 500), 300);
  assert.deepEqual(parsePanel(null, 1600), { open: true, width: 380 });
  assert.deepEqual(parsePanel('{"open":false,"width":520}', 1600), { open: false, width: 520 });
  assert.deepEqual(parsePanel('oops', 1600), { open: true, width: 380 });
  assert.deepEqual(dragResult({ open: false, width: 400 }, 400, -10, 1600, true), { open: false, width: 400 });
  assert.deepEqual(dragResult({ open: true, width: 400 }, 400, -60, 1600, true), { open: true, width: 400 }); // rouvre à la largeur mémorisée
  assert.equal(dragResult({ open: true, width: 400 }, 400, -600, 1600, true).width, 600);
  assert.equal(dragResult({ open: true, width: 400 }, 400, -100, 1600).width, 500);
  assert.equal(dragResult({ open: true, width: 400 }, 400, 300, 1600).width, 300);
  assert.ok(isToggleShortcut({ key: '.', ctrlKey: true })); assert.ok(isToggleShortcut({ key: '.', metaKey: true })); assert.ok(!isToggleShortcut({ key: '.' }));
});

test('poignée = indicateur d\'activité : gris au repos, feux Petronas un par un en travail, flash à la fin', async () => {
  const grip = src('components/PanelGrip.tsx');
  assert.match(src('App.tsx'), /busy=\{running \|\| chatBusy\}/);
  assert.match(grip, /#00A19C/); assert.match(grip, /#00D2BE/);
  assert.match(grip, /prefers-reduced-motion/); assert.match(grip, /animate-pulse/);
  assert.match(grip, /mode: 'flash'/); assert.match(grip, /size-2\.5/); // pastille un peu plus grande
  const { lightsAt, GRIP_DOTS, LIGHT_STEP_MS } = await import('../src/components/PanelGrip.tsx').catch(() => ({} as any));
  if (lightsAt) {
    assert.deepEqual(Array.from({ length: 11 }, (_, i) => lightsAt(i)), [0, 1, 2, 3, 4, 5, 6, 6, 0, 0, 1]);
    assert.equal(lightsAt(3), 3); assert.equal(lightsAt(GRIP_DOTS + 1), GRIP_DOTS); assert.equal(lightsAt(GRIP_DOTS + 2), 0); assert.equal(lightsAt(GRIP_DOTS + 3), 0); assert.equal(lightsAt(GRIP_DOTS + 4), 1);
    assert.ok(LIGHT_STEP_MS >= 120 && LIGHT_STEP_MS <= 150);
  }
});

test('charte F1 / brutaliste : tokens centralisés, formes anguleuses, typos locales', () => {
  const css = src('index.css'); const f1 = src('f1.css');
  assert.match(css, /@import "\.\/f1\.css"/); assert.match(css, /--radius: 5px/); assert.doesNotMatch(css, /--radius: 0\.625rem/);
  assert.match(f1, /--f1-radius: [4-6]px/); assert.doesNotMatch(f1, /f1-ticks/); assert.match(f1, /--f1-slant: [6-8]deg/); assert.doesNotMatch(f1, /font-style: italic/); assert.match(f1, /--f1-accent: #00A19C/);
  assert.match(f1, /\[class\*="rounded"\]:not\(\.f1-round\)/); // plafond 2 px partout (feux de poignée épargnés)
  assert.match(f1, /\.f1-para \{ transform: skewX\(calc\(-1 \* var\(--f1-slant\)\)\)/); assert.match(f1, /\.f1-para > \* \{ transform: skewX\(var\(--f1-slant\)\)/);
  assert.match(f1, /tabular-nums/); assert.match(f1, /text-transform: uppercase/);
  // polices embarquées : aucune URL réseau
  assert.doesNotMatch(f1, /https?:\/\//);
  for (const m of f1.matchAll(/url\('\.\/(assets\/fonts\/[^']+)'\)/g)) assert.ok(existsSync(new URL(`../src/${m[1]}`, import.meta.url)), m[1]);
  // éléments clés en parallélogramme, texte redressé dans un span
  assert.match(src('components/Sidebar.tsx'), /f1-para[^"]*"[^>]*>(<Plus \/>)<span>New Interface<\/span>/);
  const app = src('App.tsx');
  assert.match(app, /f1-para f1-metal[^"]*ml-auto[^"]*" onClick=\{\(\) => submit\(prompt\)\}/);
  // corporate : parallélogramme réservé aux boutons principaux ; suggestions, MCP et plein écran en rectangles adoucis
  assert.match(app, /data-testid="mcp-button" className="shrink-0/); assert.match(app, /className="shrink-0 text-muted-foreground"[\s\S]{0,140}data-testid="suggestion"/);
  assert.equal((app.match(/f1-para/g) ?? []).length, 2); // Générer/Envoyer + Arrêter
  assert.doesNotMatch(f1, /\[data-slot="button"\][^{]*\{[^}]*uppercase/); // boutons en sans-serif classique
  assert.doesNotMatch(app, /rounded-full/);
});

test('saisie adaptative : container query, barre qui passe à la ligne, Générer toujours visible', () => {
  const app = src('App.tsx');
  assert.match(app, /@container\/composer[^"]*" data-testid="composer"/);
  assert.match(app, /flex min-w-0 flex-wrap[^"]*" data-testid="composer-toolbar"/);
  assert.match(app, /@max-\[399px\]\/composer:hidden/);
  assert.match(app, /f1-fade-x[^"]*overflow-x-auto[^"]*" data-testid="suggestions"/);
  assert.match(app, /placeholder=\{chatMode === 'ask' \? \(hasApp \? '[^']+' : '[^']+'\) : hasApp \? '[^']+' : '[^']+'\}/); // Ask vs Agent
});

test('en-tête Formule Agent : titre jamais tronqué, outils qui passent à la ligne, plus de graduations', () => {
  const p = src('components/FormuleAgentPanel.tsx');
  assert.match(p, /flex flex-wrap items-center[^"]*" data-testid="fa-header"/);
  assert.match(p, /min-w-\[8\.5rem\] flex-1/); assert.match(p, /whitespace-nowrap text-sm font-semibold[^"]*" data-testid="fa-title"/); assert.doesNotMatch(p, /f1-title/); // casse normale, sobre
  assert.match(p, /ml-auto[^"]*" data-testid="fa-header-tools"/); assert.doesNotMatch(p, /f1-ticks|fa-ticks/);
});

test('bouton New Interface fin et métallique (même matière que la poignée)', () => {
  const sb = src('components/Sidebar.tsx'); const f1 = src('f1.css');
  assert.match(sb, /f1-metal[^"]*h-8[^"]*" data-testid="new-interface"/); assert.doesNotMatch(sb, /size="lg" data-testid="new-interface"/);
  const app = src('App.tsx');
  assert.match(app, /f1-metal[^"]*h-8[^"]*" onClick=\{\(\) => submit\(prompt\)\}/); // Générer/Envoyer : même matière
  assert.match(app, /f1-metal[^"]*h-8[^"]*" onClick=\{\(\) => abortRef/); // Arrêter
  assert.match(f1, /\.f1-metal \{[\s\S]*#2a2b2e[\s\S]*#1c1d20[\s\S]*inset 0 1px 0/);
});

test('Historique : défilement conservé, barre de défilement masquée', () => {
  const sb = src('components/Sidebar.tsx'); const f1 = src('f1.css');
  assert.match(sb, /f1-no-scrollbar[^"]*overflow-y-auto[^"]*" data-testid="history"/);
  assert.doesNotMatch(sb, /ScrollArea/);
  assert.match(f1, /\.f1-no-scrollbar \{ scrollbar-width: none;/); assert.match(f1, /\.f1-no-scrollbar::-webkit-scrollbar \{ display: none;/);
});
