import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { ROLE_TERMS_RE, crewSteps, neutral } from '../src/lib/neutral.ts';
import { say } from '../src/lib/speech.ts';
import { chatEmptyReason } from '../src/lib/appChat.ts';

const src = new URL('../src/', import.meta.url);
/** Code des écrans du studio, commentaires retirés (le texte visible = JSX + chaînes). */
const studioFiles = ['App.tsx', ...readdirSync(new URL('components/', src)).filter((f) => f.endsWith('.tsx')).map((f) => `components/${f}`), 'lib/appChat.ts', 'lib/runtimeError.ts'];
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

test('aucun nom de rôle dans le texte visible du studio', () => {
  for (const f of studioFiles) {
    const code = stripComments(readFileSync(new URL(f, src), 'utf8'));
    const m = code.match(ROLE_TERMS_RE);
    assert.equal(m, null, `${f} affiche « ${m?.[0]} »`);
  }
  for (const s of [chatEmptyReason({ hasProject: false, running: true, appError: null, capable: null }), chatEmptyReason({ hasProject: true, running: false, appError: null, capable: false })])
    assert.doesNotMatch(String(s), ROLE_TERMS_RE);
});

test('la détection attrape bien les noms de rôles', () => {
  for (const t of ['Data Engineer', 'Product Owner', 'Développeur', 'Ingénieur', 'le contremaître', 'Revue PO n°2', 'passe n°3']) assert.match(t, ROLE_TERMS_RE, t);
  for (const t of ['Analyse des données', 'Conception', 'Construction', 'Vérification', 'Formule Agent']) assert.doesNotMatch(t, ROLE_TERMS_RE, t);
});

test('neutral : libellés de phase et réponses sans rôles', () => {
  assert.equal(neutral('Product Owner : spécification et contrat'), 'Conception');
  assert.equal(neutral('Développeur : backend MCP + front'), 'Construction');
  assert.equal(neutral('Développeur : orchestration'), 'Construction · orchestration');
  assert.equal(neutral('Développeur : données'), 'Construction · données');
  assert.equal(neutral('Développeur : atomes'), 'Construction · atomes');
  assert.equal(neutral('Développeur : molécules'), 'Construction · molécules');
  assert.equal(neutral('Développeur : organismes'), 'Construction · organismes');
  assert.equal(neutral('Développeur : page'), 'Construction · page');
  assert.equal(neutral('Product Owner : revue n°2 (front · backend · agent)'), 'Vérification');
  for (const t of ['Je délègue à l’équipe Data Engineer → PO → Dev.', 'Le contremaître a demandé au Développeur une passe n°2', 'Ingénieur données : ok'])
    assert.doesNotMatch(neutral(t), ROLE_TERMS_RE, neutral(t));
  assert.equal(neutral('C’est noté : le contremaître délègue l’évolution à l’équipe (Data Engineer → PO → Dev), suivi ci-dessous.'), 'C’est noté : Formule Agent prend en charge l’évolution, suivi ci-dessous.');
});

test('crewSteps : 4 étapes neutres, détail outils regroupé', () => {
  const ev = (o: Record<string, unknown>) => ({ type: 'agent' as const, ...o }) as any;
  const { steps, summary } = crewSteps([
    ev({ kind: 'role', role: 'data', label: 'Data Engineer' }),
    ev({ kind: 'tool', id: 't1', tool: 'mcp_call', args: { tool: 'n8n__list' }, role: 'data' }),
    ev({ kind: 'tool_result', id: 't1', ok: true, ms: 12 }),
    ev({ kind: 'role', role: 'po', label: 'Product Owner' }),
    ev({ kind: 'spec', role: 'po', text: 'x', components: ['card'] }),
    ev({ kind: 'role', role: 'dev', label: 'Développeur', iteration: 1 }),
    ev({ kind: 'build', role: 'dev', ok: true, ms: 10 }),
    ev({ kind: 'role', role: 'po', label: 'Product Owner', iteration: 1 }),
    ev({ kind: 'review', role: 'po', verdict: 'ok', iteration: 1, criteria: [{ id: 'LIB', ok: true, note: 'le Développeur a corrigé' }] }),
    ev({ kind: 'summary', ms: 1000 }),
  ], false);
  assert.deepEqual(steps.map((s) => s.name), ['Analyse des données', 'Conception', 'Construction', 'Vérification']);
  assert.ok(steps.every((s) => s.status === 'done'));
  assert.ok(summary);
  assert.doesNotMatch(JSON.stringify(steps), ROLE_TERMS_RE);
});

test('la voix entre agents s’affiche en binaire, avec le sens', () => {
  const ev = (o: Record<string, unknown>) => ({ type: 'agent' as const, ...o }) as any;
  const { steps } = crewSteps([
    ev({ kind: 'role', role: 'data', label: 'Data Engineer' }),
    ev({ kind: 'message', role: 'data', text: say('Profil prêt') }),
  ], false);
  const line = steps[0].details[0].text;
  assert.match(line, /^(?:[01]{8} ){7}[01]{8} · Profil prêt$/);
  assert.doesNotMatch(line, ROLE_TERMS_RE);
});
