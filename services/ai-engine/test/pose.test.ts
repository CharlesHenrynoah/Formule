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

test('une courbe ne pose pas un tableau titré par la demande', () => {
  const prompt = 'Ajoute sous le tableau des releases une courbe des commits par semaine sur les 3 derniers mois.';
  const posed = poseRequest(page, prompt);
  assert.equal(posed.changed, false);
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

test('si la page est inchangée, le tableau est posé avant BoardStack', () => {
  const posed = poseRequest(page, 'Ajoute un tableau des 10 dernières releases du dépôt, avec le numéro de version');
  assert.equal(posed.changed, true);
  assert.match(posed.code, /function AddedReleases\(/);
  assert.match(posed.code, /collection: 'releases'/);
  assert.match(posed.code, /<AddedReleases \/>\s*<\/BoardStack>/);
  assert.match(posed.code, /tag_name/);
  assert.equal(poseRequest(posed.code, 'releases encore').changed, false);
});
