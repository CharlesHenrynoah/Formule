import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionForPrompt, dropIncomplete, liaisonMission, poseRequest, routeDemand } from '../src/agent/engine/pose.ts';

const page = `import { useState, useEffect } from 'react';
export default function App() {
  return (
    <BoardStack>
      <p>dépôt</p>
    </BoardStack>
  );
}
`;

test('une demande de releases nomme la collection releases', () => {
  assert.equal(collectionForPrompt('Ajoute un tableau des 10 dernières releases du dépôt, avec le numéro de version'), 'releases');
});

test('une courbe de commits placée sous les releases vise commits, et l\'outil imposé', () => {
  const prompt = 'Ajoute sous le tableau des releases une courbe des commits par semaine sur les 3 derniers mois.';
  assert.equal(collectionForPrompt(prompt), 'commits');
  const route = routeDemand(prompt);
  assert.equal(route.kind, 'courbe');
  assert.equal(route.collection, 'commits');
  assert.equal(route.title, 'Commits par semaine (3 derniers mois)');
  const mission = liaisonMission(prompt, { tool: 'github__list_commits', args: { owner: 'facebook', repo: 'react', perPage: 20 } });
  assert.match(mission, /Routeur : courbe/);
  assert.match(mission, /github__list_commits/);
  assert.match(mission, /aucun autre serveur/);
});

test('le routeur classe une demande qui n\'est pas un dépôt', () => {
  const orders = routeDemand('Ajoute une page de suivi des commandes du jour');
  assert.equal(orders.kind, 'page');
  assert.equal(orders.collection, 'commandes');
  assert.equal(orders.data, true);
  const form = routeDemand('Ajoute un formulaire de contact');
  assert.equal(form.kind, 'formulaire');
  assert.equal(form.collection, 'contact');
  assert.equal(form.data, false);
  const color = routeDemand('Change la couleur du bouton Envoyer');
  assert.equal(color.kind, 'action');
  assert.equal(color.data, false);
  const bills = routeDemand('Ajoute un tableau des factures impayées');
  assert.equal(bills.kind, 'tableau');
  assert.equal(bills.collection, 'factures');
  assert.equal(bills.data, true);
  const posedForm = poseRequest(page, 'Ajoute un formulaire de contact');
  assert.equal(posedForm.changed, true);
  assert.match(posedForm.code, /<form/);
  assert.doesNotMatch(posedForm.code, /data_list/);
});

test('une courbe ne pose pas un tableau titré par la demande', () => {
  const prompt = 'Ajoute sous le tableau des releases une courbe des commits par semaine sur les 3 derniers mois.';
  const posed = poseRequest(page, prompt);
  assert.equal(posed.changed, true);
  assert.match(posed.code, /LineChart/);
  assert.match(posed.code, /collection: 'commits'/);
  assert.doesNotMatch(posed.code, /<table/);
  assert.doesNotMatch(posed.code, /Ajoute sous/);
  const junk = page.replace('</BoardStack>', `<AddedReleases />\n    </BoardStack>`) + `
function AddedReleases() {
  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold">Ajoute sous le tableau des releases une courbe</h3>
    </div>
  );
}
`;
  const dropped = dropIncomplete(junk);
  assert.equal(dropped.changed, true);
  assert.doesNotMatch(dropped.code, /AddedReleases/);
  assert.doesNotMatch(dropped.code, /Ajoute sous le tableau/);
});

test('une courbe qui croise deux collections pose deux séries', () => {
  const prompt = 'Ajoute une courbe des 3 derniers mois qui croise deux séries sur les mêmes semaines : le nombre de commits en bleu, et le nombre de pull requests fusionnées en menthe.';
  const route = routeDemand(prompt);
  assert.equal(route.kind, 'courbe');
  assert.deepEqual(route.collections, ['commits', 'pullRequests']);
  const posed = poseRequest(page, prompt);
  assert.equal(posed.changed, true);
  assert.match(posed.code, /collection: 'commits'/);
  assert.match(posed.code, /collection: 'pullRequests'/);
  assert.match(posed.code, /dataKey="commits"/);
  assert.match(posed.code, /dataKey="pullRequests"/);
  assert.match(posed.code, /var\(--chart-1\)/);
  assert.match(posed.code, /var\(--chart-2\)/);
  assert.match(posed.code, /mergedAt/);
  assert.doesNotMatch(posed.code, /Ajoute une courbe/);
  assert.equal(poseRequest(posed.code, prompt).changed, false);
  const orders = poseRequest(page, 'Ajoute une courbe des commandes par semaine');
  assert.match(orders.code, /collection: 'commandes'/);
  assert.match(orders.code, /<AddedCommandes \/>\s*<\/BoardStack>/);
});

test('si la page est inchangée, le tableau est posé avant BoardStack', () => {
  const posed = poseRequest(page, 'Ajoute un tableau des 10 dernières releases du dépôt, avec le numéro de version');
  assert.equal(posed.changed, true);
  assert.match(posed.code, /function AddedReleases\(/);
  assert.match(posed.code, /collection: 'releases'/);
  assert.match(posed.code, /<AddedReleases \/>\s*<\/BoardStack>/);
  assert.match(posed.code, /tag_name/);
  assert.equal(poseRequest(posed.code, 'releases encore').changed, false);
});
