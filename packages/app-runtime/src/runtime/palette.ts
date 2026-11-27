/**
 * Couleurs dynamiques des graphiques : palette OKLCH (teintes vives façon couleurs système Apple),
 * graine dérivée de l'interface, répartie à l'angle d'or pour rester distincte quel que soit le nombre de séries.
 * L'interface reste en noir et blanc ; seule la donnée est colorée.
 */
const ANCHORS = [250, 150, 65, 15, 305, 210, 95, 30]; // bleu, vert, orange, rose, violet, cyan, jaune, rouge (teintes OKLCH)

function oklchToHex(l: number, c: number, hDeg: number): string {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h), b = c * Math.sin(h);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b, m_ = l - 0.1055613458 * a - 0.0638541728 * b, s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3, M = m_ ** 3, S = s_ ** 3;
  const lin = [4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S, -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S, -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S];
  const g = (x: number) => { const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; return Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0'); };
  return `#${lin.map(g).join('')}`;
}

export function seedOf(text: string): number { let h = 2166136261; for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return Math.abs(h); }

/** n couleurs distinctes, lumineuses sur fond noir. */
export function dynamicPalette(n: number, seed: number): string[] {
  const start = seed % ANCHORS.length;
  return Array.from({ length: Math.max(1, n) }, (_, i) => {
    const hue = i < ANCHORS.length ? ANCHORS[(start + i) % ANCHORS.length] : (ANCHORS[start] + i * 137.508) % 360;
    const l = i < 8 ? 0.74 : 0.66 + ((i * 7) % 3) * 0.05;
    return oklchToHex(l, 0.17, hue);
  });
}

/** Rampe séquentielle (calendrier, intensité) à partir d'une teinte. */
export function rampColor(k: number, base: string): string {
  const t = Math.max(0, Math.min(1, k));
  return `color-mix(in oklab, ${base} ${Math.round(12 + t * 88)}%, #0d0d0d)`;
}

let current = dynamicPalette(12, 0);
export const seriesColor = (i: number) => current[i % current.length];
export const OTHER_COLOR = '#4a4a4a';

/** Applique la palette : variables --chart-* pour les composants shadcn, liste pour les canvas. */
export const ACCENT_START: Record<string, number> = { bleu: 0, vert: 1, orange: 2, sable: 6, rouge: 7, violet: 4, cyan: 5 };
export function applyPalette(seed: number, accent?: string) {
  current = dynamicPalette(12, accent && ACCENT_START[accent] !== undefined ? ACCENT_START[accent] : seed);
  const root = document.documentElement;
  current.forEach((c, i) => root.style.setProperty(`--chart-${i + 1}`, c));
  root.style.setProperty('--chart-other', OTHER_COLOR);
}
