/** Panneau « Formule Agent » rétractable : largeur bornée et état mémorisé (localStorage). Fonctions pures testées. */
export const PANEL_MIN = 300;
export const PANEL_DEFAULT = 380;
export const PANEL_KEY = 'es-fa-panel';
export type PanelState = { open: boolean; width: number };

/** Largeur bornée : min 300 px, max 50 % de la fenêtre (jamais sous le min). */
export const clampWidth = (w: number, viewport: number) => Math.round(Math.min(Math.max(PANEL_MIN, viewport * 0.5), Math.max(PANEL_MIN, Number.isFinite(w) ? w : PANEL_DEFAULT)));

export function parsePanel(raw: string | null, viewport: number): PanelState {
  try {
    const x = JSON.parse(raw ?? 'null') as Partial<PanelState> | null;
    return { open: x?.open !== false, width: clampWidth(Number(x?.width ?? PANEL_DEFAULT), viewport) };
  } catch { return { open: true, width: clampWidth(PANEL_DEFAULT, viewport) }; }
}

/** Glisser sur la poignée : vers la gauche agrandit / rouvre ; un clic (sans déplacement) rouvre si replié. */
export function dragResult(s: PanelState, startWidth: number, dx: number, viewport: number, fromClosed = false): PanelState {
  if (fromClosed) return dx < -24 ? { open: true, width: clampWidth(Math.max(startWidth, -dx), viewport) } : { ...s, open: false };
  return { open: true, width: clampWidth(startWidth - dx, viewport) };
}

/** Raccourci Cmd/Ctrl + « . » */
export const isToggleShortcut = (e: { key: string; metaKey?: boolean; ctrlKey?: boolean }) => e.key === '.' && !!(e.metaKey || e.ctrlKey);
