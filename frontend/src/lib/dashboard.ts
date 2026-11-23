/** Document d'un tableau vivant, dessiné par les graphiques du studio. */

export type ChartType = 'kpi' | 'line' | 'bar' | 'area' | 'pie' | 'table';
export type ChartPlace = 'signal' | 'gaze' | 'voice';
export type Density = 'calme' | 'parle' | 'dense';
export type ChartSpec = {
  id: string;
  title: string;
  type: ChartType;
  tool: string;
  args: Record<string, unknown>;
  x: string;
  y: string;
  place?: ChartPlace;
};
export type FilterSpec = { id: string; label: string; arg: string; options: string[] };
export type DashboardSpec = { title: string; description: string; filters: FilterSpec[]; charts: ChartSpec[]; density?: Density };
export type SavedDashboard = { id: string; title: string; description: string | null; spec: DashboardSpec; position: number };
export type BoardView = { id: string; spec: DashboardSpec; sketch: boolean; pendingChartId: string | null };

/** Une question, ou le mot tableau : on compose un tableau plutôt qu'une application. */
export function isDashboardTurn(text: string) {
  return /[?]|\b(comment|quel(?:le|s)?|combien|où|montre|affiche|compare|pourquoi|dashboard|tableau)\b/i.test(text);
}

/** La phrase retouche le tableau ouvert (un graphique, un filtre) au lieu d'en ouvrir un autre. */
export function keepsOpenDashboard(text: string) {
  return /\b(change|modifie|remplace|passe|ajoute|filtre|uniquement|seulement|reconstruis)\b/i.test(text)
    && !/\b(nouveau|autre)\s+(tableau|dashboard)\b/i.test(text);
}
