const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
export const fmtNum = (v: number | null | undefined) => (v === null || v === undefined ? '—' : nf.format(v));
export const fmtTime = (iso: string | number | null | undefined) => {
  if (iso === null || iso === undefined) return 'inconnue';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'date invalide' : d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};
export const fmtDate = (t: number) => new Date(t).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
export const STATE_LABEL: Record<string, string> = {
  initial: 'Initial', loading: 'Chargement…', ready: 'Prêt', empty: 'Vide', partial: 'Partiel', stale: 'Obsolète', error: 'Erreur', unavailable: 'Indisponible',
  available: 'Disponible', missing: 'Manquante', invalid: 'Invalide', inaccessible: 'Inaccessible',
};

/** Affichage lisible des grands nombres (≥ 1 million) ; la valeur exacte reste dans title et data-value. */
export const fmtSmart = (v: number | null | undefined) => (v === null || v === undefined ? '—' : Math.abs(v) >= 1e6 ? new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 2 }).format(v) : fmtNum(v));
