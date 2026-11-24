import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkChain } from '../src/agent/engine/chain.ts';

const solana = `Avec le MCP CoinGecko, utilise d'abord search_docs pour trouver les méthodes "coins markets", "coin by id" et "market chart". Utilise ensuite execute pour récupérer, en EUR, les données de Solana (prix, capitalisation, variation sur 24 h et sur 7 jours, volume, plus haut historique), le prix de Solana sur 30 jours, et le top 10 des cryptos par capitalisation. Crée ensuite un dashboard "Solana en direct". En haut, mets 4 cartes : prix du SOL, variation 24 h, volume 24 h et écart avec le plus haut historique en %. Au milieu, mets une courbe du SOL sur 30 jours. En bas, mets le tableau du top 10.`;

test('la doc ne prolonge pas une demande de mesures', () => {
  const chain = linkChain(solana, ['method', 'summary', 'endpoint']);
  assert.equal(chain.ok, false);
  assert.equal(chain.data.prev, chain.prompt.hash);
  assert.match(chain.text, /ouverts/);
  assert.match(chain.text, /rompu/);
});

test('une mesure n’est tenue que par un champ qui la nomme', () => {
  const chain = linkChain(solana, ['name', 'price', 'volume', 'change_24h']);
  assert.equal(chain.ok, false);
  const prix = chain.links.find((link) => /^prix$/i.test(link.text) && link.state === 'tenu');
  assert.equal(prix?.field, 'price');
  assert.ok(chain.links.some((link) => /capitalisation/i.test(link.text) && link.state === 'ouvert'));
  assert.match(chain.text, /exigences manquantes/);
});

test('toutes les mesures nommées doivent être tenues', () => {
  const chain = linkChain('Affiche le prix et le volume.', ['price', 'volume']);
  assert.equal(chain.ok, true);
  assert.match(chain.text, /exigences manquantes : aucune/);
});

test('un autre serveur, d’autres mots : le fil reste le même', () => {
  const prompt = 'Montre le tableau des issues ouvertes du dépôt, avec le statut.';
  const chain = linkChain(prompt, ['title', 'state']);
  assert.equal(chain.ok, true);
  assert.ok(chain.allowed.includes('state'));
  assert.match(chain.text, /tableau/);
});

test('des issues ne tiennent pas une demande de prix', () => {
  const chain = linkChain('Affiche le prix et le volume.', ['title', 'state']);
  assert.equal(chain.ok, false);
});

test('deux prompts différents ne partagent pas le même sceau', () => {
  const a = linkChain('Affiche le prix.', ['price']);
  const b = linkChain('Affiche le volume.', ['volume']);
  assert.notEqual(a.prompt.hash, b.prompt.hash);
  assert.equal(a.data.prev, a.prompt.hash);
  assert.equal(b.data.prev, b.prompt.hash);
});
