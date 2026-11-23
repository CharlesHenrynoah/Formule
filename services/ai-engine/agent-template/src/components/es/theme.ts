/**
 * Thème des apps générées : interface noire.
 * Les séries reprennent la palette des graphiques : bleu, menthe, sable, puis les suivantes.
 */
export const VIZ = [0x6eacd7, 0x79bb9e, 0xd5ba82, 0x9f8fbe, 0xd18882, 0x68abb6, 0x86a277, 0x78879f] as const;
export const VIZ_CSS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)', 'var(--chart-7)', 'var(--chart-8)'] as const;
/** Couleur de donnée n°i (cyclique). */
export const viz = (i: number) => VIZ[((i % VIZ.length) + VIZ.length) % VIZ.length];
export const vizCss = (i: number) => VIZ_CSS[((i % VIZ_CSS.length) + VIZ_CSS.length) % VIZ_CSS.length];
/** Interface (scènes) : fond noir, texte blanc. */
export const UI = { bg: 0x111111, panel: 0x1c1c1c, grid: 0x2a2a2a, line: 0x3a3a3a, text: 0xf5f5f5, muted: 0x8a8a8a, ink: 0xf5f5f5, white: 0xf5f5f5 } as const;
/** Statuts : gris, pastilles seulement. */
export const STATUS = { ok: 0xcfcfcf, warn: 0x8a8a8a, alert: 0xf5f5f5 } as const;
