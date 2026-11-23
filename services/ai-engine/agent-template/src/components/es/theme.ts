/**
 * Thème des apps générées : noir dominant, noir et blanc.
 * Les séries sont des gris, du plus clair au plus sombre, lisibles sur le fond noir.
 */
export const VIZ = [0xf2f2f2, 0xb5b5b5, 0x8a8a8a, 0x666666, 0xd0d0d0, 0x9a9a9a, 0x555555, 0x3a3a3a] as const;
export const VIZ_CSS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)', 'var(--chart-7)', 'var(--chart-8)'] as const;
/** Couleur de donnée n°i (cyclique). */
export const viz = (i: number) => VIZ[((i % VIZ.length) + VIZ.length) % VIZ.length];
export const vizCss = (i: number) => VIZ_CSS[((i % VIZ_CSS.length) + VIZ_CSS.length) % VIZ_CSS.length];
/** Interface (scènes) : fond noir, texte blanc. */
export const UI = { bg: 0x111111, panel: 0x1c1c1c, grid: 0x2a2a2a, line: 0x3a3a3a, text: 0xf5f5f5, muted: 0x8a8a8a, ink: 0xf5f5f5, white: 0xf5f5f5 } as const;
/** Statuts : gris, pastilles seulement. */
export const STATUS = { ok: 0xcfcfcf, warn: 0x8a8a8a, alert: 0xf5f5f5 } as const;
