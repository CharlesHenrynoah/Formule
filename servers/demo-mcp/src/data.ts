/** Données synthétiques déterministes (graine fixe), ancrées sur la date du jour. */
function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
const DAY = 86_400_000;
const r = rng(42);
const today = new Date(); today.setUTCHours(0, 0, 0, 0);
const iso = (t: number) => new Date(t).toISOString();

const clients = ['Atelier Nova', 'Brasserie Lumen', 'Cabinet Orée', 'Domaine Vasco', 'Éditions Pivot', 'Forge 21', 'Galerie Opale', 'Hôtel Sirocco'];
export const factures = Array.from({ length: 64 }, (_, i) => {
  const t = today.getTime() - Math.floor(r() * 75) * DAY + Math.floor(r() * 10) * 3_600_000;
  const statut = r() < 0.78 ? 'payée' : r() < 0.6 ? 'en attente' : 'en retard';
  return { id: `F-2026-${String(1000 + i)}`, client: clients[Math.floor(r() * clients.length)], montant: { valeur: Math.round(400 + r() * 5200), devise: 'EUR' }, emise_le: iso(t), statut };
}).sort((a, b) => a.emise_le.localeCompare(b.emise_le));

const etapes = ['découverte', 'qualification', 'proposition', 'négociation', 'gagnée', 'perdue'];
const commerciaux = ['Inès', 'Malik', 'Sofia', 'Théo'];
export const affaires = Array.from({ length: 22 }, (_, i) => ({
  id: `AFF-${String(300 + i)}`,
  nom: `${clients[i % clients.length]} — ${['licences', 'audit', 'refonte', 'support', 'formation'][i % 5]}`,
  etape: etapes[Math.floor(r() * etapes.length)],
  montant: { valeur: Math.round(2000 + r() * 38000), devise: 'EUR' },
  probabilite: Math.round(r() * 100) / 100,
  proprietaire: commerciaux[Math.floor(r() * commerciaux.length)],
  maj_le: iso(today.getTime() - Math.floor(r() * 20) * DAY),
}));

const canaux = ['Recherche', 'Social', 'Affiliation', 'Display', 'Email'];
export const campagnes = Array.from({ length: 9 }, (_, i) => {
  const depense = Math.round(300 + r() * 4200);
  return {
    id: `CMP-${i + 1}`, nom: `${canaux[i % canaux.length]} · ${['printemps', 'retargeting', 'marque', 'lancement'][i % 4]}`,
    canal: canaux[i % canaux.length], statut: i === 7 ? 'en pause' : 'active',
    depense: { valeur: depense, devise: 'EUR' },
    revenu_attribue: { valeur: Math.round(depense * (0.4 + r() * 3.2)), devise: 'EUR' },
    clics: Math.round(200 + r() * 6000), conversions: Math.round(r() * 140),
  };
});

/** Série irrégulière : certains jours manquent, certaines conversions ne sont pas encore connues (null). */
export const inscriptions = (() => {
  const pts: { horodatage: string; inscriptions: number; devenus_clients: number | null }[] = [];
  for (let d = 45; d >= 0; d--) {
    if (r() < 0.18) continue; // jours sans export : trou, pas zéro
    const ins = Math.round(20 + r() * 60);
    pts.push({ horodatage: iso(today.getTime() - d * DAY + Math.floor(r() * 8) * 3_600_000), inscriptions: ins, devenus_clients: d < 3 ? null : Math.round(ins * (0.05 + r() * 0.2)) });
  }
  return pts;
})();

export const ordresEcrits: Record<string, unknown> = {};
