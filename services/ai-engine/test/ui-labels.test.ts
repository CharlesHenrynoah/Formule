/** Libellés métier : l'analogie DJ est un principe interne, jamais un libellé visible. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { findDjLabels, relabelVisible, relabelText, RENAME_TABLE } from '../src/agent/ui-labels.ts';
import { coherenceCriteria } from '../src/agent/crew.ts';
import { DEVELOPER, PRODUCT_OWNER } from '../src/agent/prompts.ts';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('détecte un libellé DJ dans le texte visible (et seulement là)', () => {
  const dj = `const knobs = { a: 1 }; // knobs, pads\nexport default () => <Panel title="VU-mètres" subtitle="niveaux"><Pads id="pads" />{knobs.a > 0 ? <span>Co-DJ · prochain mouvement</span> : null}</Panel>;`;
  const found = findDjLabels(dj).join(' | ');
  assert.match(found, /VU-mètres/); assert.match(found, /Co-DJ/);
  assert.doesNotMatch(found, /knobs\.a|id="pads"/); // identifiants / ids non visibles ignorés
  const r = relabelVisible(dj);
  assert.deepEqual(findDjLabels(r.code), []);
  assert.match(r.code, /title="Indicateurs clés"/);
  assert.match(r.code, /Assistant · recommandations/);
  assert.match(r.code, /const knobs = \{ a: 1 \}/); // code intact
  assert.match(r.code, /<Pads id="pads" \/>/);
});

test('renommage : table métier et templates `${}` intacts', () => {
  assert.equal(relabelText('Crossfader'), 'Comparer réel / scénario');
  assert.equal(relabelText('Pads & raccourcis'), 'Actions rapides');
  assert.equal(relabelText('Knobs · Simulation'), 'Simulation');
  assert.equal(relabelText('Console live'), 'Actualisation des données');
  assert.equal(relabelText('Sauver la scène'), 'Enregistrer la vue');
  assert.equal(relabelText('Deck branché'), 'Source active');
  const t = relabelVisible('toast.info(`Scène rappelée : knob ${pr.knob ?? 50}`)').code;
  assert.equal(t, 'toast.info(`Vue rappelée : curseur ${pr.knob ?? 50}`)');
  assert.ok(RENAME_TABLE.length >= 10);
});

test('aucun libellé DJ visible dans le template, les composants partagés et l\'app démo', () => {
  const dir = new URL('../agent-template/src/components/es/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.tsx'))) assert.deepEqual(findDjLabels(readFileSync(new URL(f, dir), 'utf8')), [], f);
  assert.deepEqual(findDjLabels(read('../src/mock/smart/monitoring.App.tsx')), []);
});

test('prompts PO/Dev : analogie interne, libellés métier exigés', () => {
  assert.match(PRODUCT_OWNER, /JAMAIS de vocabulaire DJ dans l'interface/);
  assert.match(PRODUCT_OWNER, /INTERDITS à l'écran : Co-DJ/);
  assert.doesNotMatch(PRODUCT_OWNER, /"agent":\{"name":"Co-DJ"/);
  assert.doesNotMatch(DEVELOPER, /- (DECKS|VU-MÈTRES|KNOBS|CROSSFADER|PADS|CO-DJ) :/);
  assert.match(DEVELOPER, /ACTIONS RAPIDES/);
  assert.match(PRODUCT_OWNER, /interface de fitness/);
  assert.match(PRODUCT_OWNER, /## Pilotage/);
  assert.match(DEVELOPER, /Hick-Hyman/);
  assert.match(DEVELOPER, /STATUS\.alert est la seule couleur d'alerte/);
  assert.match(PRODUCT_OWNER, /jamais affichés/);
});

test('revue PO : critère LIB-métier échoue si un libellé DJ est visible', () => {
  const contract: any = { tools: [], entities: [], charts: [], externalTools: [], agent: { tools: [] }, console: { decks: [{ label: 'x', tool: 't', args: {} }], knobs: [], pads: [] } };
  const bad = coherenceCriteria(contract, `export default () => <Panel title="Crossfader" />;`, null).find((c) => c.id === 'LIB-métier');
  assert.equal(bad?.ok, false);
  const good = coherenceCriteria(contract, `export default () => <Panel title="Comparer réel / scénario" />;`, null).find((c) => c.id === 'LIB-métier');
  assert.equal(good?.ok, true);
  const ids = coherenceCriteria(contract, '', null).map((c) => c.id);
  assert.ok(!ids.some((i) => /^DJ-/.test(i)));
  assert.ok(ids.includes('ALIGN-données'));
});

test('ALIGN-données : détecte un template générique hors contrat métier', () => {
  const contract: any = {
    tools: [{ name: 'list_pulls', kind: 'read' }],
    entities: [{ name: 'pulls', fields: { title: 'string', author: 'string', age_days: 'number' } }],
    charts: ['bar'], externalTools: [], agent: { tools: ['list_pulls'] },
    console: { decks: [], knobs: [], pads: [] },
  };
  const smell = coherenceCriteria(contract, `const price_change_pct = 5; <Area dataKey="valeur" />; get_kpis();`, null, 'github pulls title author').find((c) => c.id === 'ALIGN-données');
  assert.equal(smell?.ok, false);
  const clean = coherenceCriteria(contract, `app.call('list_pulls'); <Bar dataKey="age_days" />`, null, 'github pulls').find((c) => c.id === 'ALIGN-données');
  assert.equal(clean?.ok, true);
});

test('renommage : grammaire française préservée', () => {
  assert.equal(relabelText('et le co-DJ ne sont pas injectés'), 'et l’assistant ne sont pas injectés');
  assert.equal(relabelText('pour activer la console LIVE, les decks'), 'pour activer l’actualisation en direct, les sources');
  assert.equal(relabelVisible('<Panel subtitle="prochain mouvement suggéré" />').code, '<Panel subtitle="recommandation suivante" />');
});

test('renommage : corrections grammaticales des apps déjà renommées', () => {
  assert.equal(relabelVisible(`<p>et le assistant ne sont pas injectés pour activer la Actualisation des données</p>`).code, `<p>et l’assistant ne sont pas injectés pour activer l’actualisation en direct</p>`);
  assert.equal(relabelVisible(`ask('Quel est le prochain mouvement recommandé ?')`).code, `ask('Quelle est la prochaine action recommandée ?')`);
  assert.equal(relabelVisible(`['Prochain mouvement ?', 'prochaine action ?']`).code, `['Prochaine action ?', 'Prochaine action ?']`);
});
