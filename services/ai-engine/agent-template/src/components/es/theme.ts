/**
 * Thème centralisé des apps générées : COULEURS INVERSÉES — fond blanc, éléments noirs, gris clair ;
 * seules les DONNÉES ont des couleurs, sobres et assez soutenues pour un fond clair.
 * - Recharts / shadcn Charts : var(--chart-1) … var(--chart-8) (définies dans index.css).
 * - PixiJS / three.js : VIZ (entiers 0xRRGGBB) — mêmes teintes que --chart-1..8 ; canvas transparent sur fond blanc.
 */
export const VIZ = [0x3f6fb0, 0x2f8f6f, 0xa8862a, 0x6e5aa8, 0xb5523f, 0x3d8a9c, 0x5a7d48, 0x5f6675] as const;
export const VIZ_CSS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)', 'var(--chart-7)', 'var(--chart-8)'] as const;
/** Couleur de donnée n°i (cyclique). */
export const viz = (i: number) => VIZ[((i % VIZ.length) + VIZ.length) % VIZ.length];
export const vizCss = (i: number) => VIZ_CSS[((i % VIZ_CSS.length) + VIZ_CSS.length) % VIZ_CSS.length];
/** Interface (scènes) : fond, grille, texte — neutres pour fond clair. `ink` = trait noir. */
export const UI = { bg: 0xffffff, panel: 0xf5f5f5, grid: 0xe5e5e5, line: 0xcfcfcf, text: 0x262626, muted: 0x737373, ink: 0x111111, white: 0x111111 } as const;
/** Statuts : discrets, à n'utiliser qu'en petites pastilles. */
export const STATUS = { ok: 0x2e9e6a, warn: 0xc08a1e, alert: 0xc0442e } as const;
