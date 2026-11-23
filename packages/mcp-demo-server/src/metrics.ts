// Métriques factices de démonstration (sans dépendance, réutilisables dans les tests).
// ---- Métriques de démo : déterministes par jour, « live » qui bouge chaque minute, anomalie J-4 ----
const hash = (s: string) => [...s.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
export const alerts: Array<{ id: number; message: string; niveau: string; at: string }> = [];
let priceFactor = 1;
export const setPriceFactor = (percent: number) => (priceFactor = Math.round(priceFactor * (1 + percent / 100) * 1000) / 1000);
const SOURCES = {
  ventes: { unite: 'commandes/jour', base: 120 },
  trafic: { unite: 'visites/jour', base: 2400 },
  energie: { unite: 'kWh/jour', base: 36 },
} as const;
const noise = (s: string) => (hash(s) % 1000) / 1000 - 0.5;
export function fakeMetrics(source: keyof typeof SOURCES = 'ventes', days = 30, now = new Date()) {
  const cfg = SOURCES[source] ?? SOURCES.ventes;
  const n = Math.max(3, Math.min(90, Math.round(days)));
  const points = Array.from({ length: n }, (_, k) => {
    const i = n - 1 - k;
    const d = new Date(now.getTime() - i * 86_400_000);
    const date = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    const weekly = source === 'energie' ? (dow === 0 || dow === 6 ? 1.25 : 1) : (dow === 0 ? 0.7 : dow === 6 ? 1.15 : 1);
    const trend = 1 - i * 0.004;                          // relatif à aujourd’hui : identique quelle que soit la fenêtre
    const anomaly = i === 4 ? 0.55 : 1;                     // chute ponctuelle à J-4 (à détecter)
    const elasticity = source === 'ventes' && i === 0 ? Math.pow(priceFactor, -1.6) : 1;
    const valeur = Math.round(cfg.base * weekly * trend * anomaly * elasticity * (1 + noise(source + date) * 0.16));
    if (source !== 'ventes') return { date, valeur };
    const prix = Math.round(42 * (i === 0 ? priceFactor : 1) * (1 + noise('p' + date) * 0.06) * 100) / 100;
    const visiteurs = Math.round(valeur * 19 * (1 + noise('v' + date) * 0.1));
    return { date, valeur, commandes: valeur, prix_moyen: prix, ca_eur: Math.round(valeur * prix), visiteurs, conversion_pct: Math.round((valeur / visiteurs) * 1000) / 10 };
  });
  const minute = Math.floor(now.getTime() / 60_000);
  const last = points.at(-1)!;
  const progress = (now.getUTCHours() * 60 + now.getUTCMinutes()) / 1440;
  const live = { at: now.toISOString(), valeur_cumulee_jour: Math.round(last.valeur * progress * (1 + noise(String(minute)) * 0.05)), tendance: noise(String(minute)) > 0 ? 'hausse' : 'baisse' };
  return { source, unite: cfg.unite, prix_facteur: priceFactor, points, live, genere_a: now.toISOString(), note: 'données factices de démonstration' };
}


// ---- Catalogue produits (ressource MCP) + ventes par produit (outil) : de quoi faire du retrieval multi-appels ----
export const PRODUCTS = [
  { sku: 'CAF-01', nom: 'Café grains 1 kg', categorie: 'épicerie', prix: 24, stock: 140, part: 0.26 },
  { sku: 'THE-02', nom: 'Thé vert bio', categorie: 'épicerie', prix: 12, stock: 18, part: 0.14 },
  { sku: 'MUG-03', nom: 'Mug isotherme', categorie: 'accessoires', prix: 29, stock: 64, part: 0.18 },
  { sku: 'MOU-04', nom: 'Moulin manuel', categorie: 'accessoires', prix: 59, stock: 9, part: 0.12 },
  { sku: 'CAP-05', nom: 'Capsules x50', categorie: 'épicerie', prix: 17, stock: 220, part: 0.3 },
];
export const OBJECTIFS = { mois: new Date().toISOString().slice(0, 7), commandes_jour: 125, ca_mois_eur: 160_000, conversion_min_pct: 4.5, note: 'objectifs personnels de démonstration' };
export function salesByProduct(date?: string, now = new Date()) {
  const d = (date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : now.toISOString().slice(0, 10));
  const day = fakeMetrics('ventes', 90, now).points.find((p) => p.date === d) as { commandes?: number } | undefined;
  const total = day?.commandes ?? 0;
  // Le 15/11-type (anomalie J-4) : la chute vient surtout du thé (rupture) et des capsules.
  const anomalyDay = fakeMetrics('ventes', 5, now).points[0]?.date === d;
  const lignes = PRODUCTS.map((p) => {
    const w = anomalyDay && p.sku === 'THE-02' ? 0.02 : anomalyDay && p.sku === 'CAP-05' ? 0.16 : p.part;
    return { sku: p.sku, nom: p.nom, commandes: Math.round(total * w * (1 + noise(p.sku + d) * 0.1)) };
  });
  return { date: d, total_commandes: total, lignes, source: 'demo' };
}

// ---- Tunnel de conversion (démo) : visites → fiche produit → panier → paiement → commande, cohérent avec les ventes du jour ----
export function funnel(date?: string, now = new Date()) {
  const pts = fakeMetrics('ventes', 30, now).points as Array<{ date: string; visiteurs?: number; commandes?: number }>;
  const p = (date && pts.find((x) => x.date === date)) || pts.at(-1)!;
  const visites = p.visiteurs ?? 2400; const commandes = p.commandes ?? 120;
  const fiche = Math.round(visites * (0.52 + noise('f' + p.date) * 0.06));
  const panier = Math.round(fiche * (0.3 + noise('c' + p.date) * 0.04));
  const paiement = Math.max(commandes, Math.round(panier * (0.42 + noise('k' + p.date) * 0.04)));
  return { date: p.date, etapes: [{ label: 'Visites', value: visites }, { label: 'Fiche produit', value: fiche }, { label: 'Panier', value: panier }, { label: 'Paiement', value: paiement }, { label: 'Commande', value: commandes }], source: 'demo' };
}
