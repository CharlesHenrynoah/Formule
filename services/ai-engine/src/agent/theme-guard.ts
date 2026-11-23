/**
 * Garde-fou du thème monochrome : les classes Tailwind ARBITRAIRES de couleur d'interface
 * (bg-[oklch(0.2_0.04_255)], border-[#0b1220], shadow-[…rgba(34,211,238,…)]…) sont ramenées en niveaux de gris.
 * Les couleurs des DONNÉES (chartConfig, stroke/fill des séries, scènes) ne sont pas touchées.
 */
const UI_PREFIX = '(?:bg|text|border(?:-[trblxy])?|ring|ring-offset|outline|divide|from|via|to|shadow|decoration|caret|accent|placeholder)';
const hexToGray = (hex: string) => {
  const h = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const l = Math.round((0.2126 * r + 0.7152 * g + 0.0722 * b) * 1000) / 1000;
  return `oklch(${Math.max(0.08, Math.min(0.98, l ** (1 / 2.2))).toFixed(3)}_0_0)`;
};
/** `invert` : code conçu pour fond sombre → niveaux de gris inversés (fond clair). Jamais pour une app déjà claire. */
export function monochromeClasses(src: string, opts: { invert?: boolean } = {}): { code: string; changed: number } {
  let changed = 0;
  const re = new RegExp(`(${UI_PREFIX}-\\[)([^\\]\\s"'\`]+)(\\])`, 'g');
  const code = src.replace(re, (m, pre: string, val: string, post: string) => {
    let v = val
      .replace(/oklch\(([\d.]+%?)_([\d.]+)_([\d.]+)((?:_\/_[\d.%]+)?)\)/g, (x, l, c, _h, a) => (Number(c) > 0.015 ? `oklch(${l}_0_0${a})` : x))
      .replace(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g, (_x, hex) => hexToGray(hex))
      .replace(/rgba?\((\d+),(\d+),(\d+)((?:,[\d.]+)?)\)/g, (x, r, g, b, a) => { const y = Math.round(0.2126 * +r + 0.7152 * +g + 0.0722 * +b); return Math.abs(+r - +g) + Math.abs(+g - +b) < 12 ? x : `rgba(${y},${y},${y}${a || ',1'})`; });
    if (opts.invert && !/^shadow/.test(pre)) v = v.replace(/oklch\(([\d.]+)(%?)_0_0((?:_\/_[\d.%]+)?)\)/g, (_x, l, pct, a) => { const L = pct ? Number(l) / 100 : Number(l); return `oklch(${Math.max(0.1, Math.min(1, 1.12 - L)).toFixed(3)}_0_0${a})`; });
    if (v !== val) changed++;
    return pre + v + post;
  });
  return { code, changed };
}

// Miroir des classes de palette nommées dans le code de l'app uniquement (les composants plateforme es/ sont déjà clairs) :
// white ↔ black, nuance N → 1000 − N (50 ↔ 950, 300 ↔ 700…) — un texte emerald-300 lisible sur noir devient emerald-700 lisible sur blanc.
const CHROMA = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const hexGray = (hex: string) => {
  const h = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  if (Math.abs(r - g) + Math.abs(g - b) < 12) return `#${h}`;
  const y = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b).toString(16).padStart(2, '0');
  return `#${y}${y}${y}`;
};

/** Classes colorées et hex chromatiques deviennent des gris. Le noir et le blanc restent. */
export function achromeSource(src: string): { code: string; changed: number } {
  let changed = 0;
  const classes = new RegExp(`((?:[a-z]+:)*(?:text|bg|border(?:-[trblxy])?|ring|from|via|to)-)(${CHROMA})(-\\d{2,3})?(?=[/\\s'"\`}]|$)`, 'g');
  let code = src.replace(classes, (full, pre: string, _pal: string, shade: string) => {
    changed++;
    return `${pre}neutral${shade ?? ''}`;
  });
  code = code.replace(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g, (full, hex: string, offset: number, src: string) => {
    const before = src.slice(Math.max(0, offset - 28), offset);
    if (/(?:stroke|fill|borderColor|backgroundColor|color)\s*[:=]\s*['"]?$/.test(before)) return full;
    const next = hexGray(hex);
    if (next.toLowerCase() !== `#${hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex}`.toLowerCase() && next.toLowerCase() !== full.toLowerCase()) changed++;
    return next;
  });
  return { code, changed };
}

const PALETTES = 'white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
export function mirrorPaletteClasses(code: string): { code: string; changed: number } {
  let changed = 0;
  const re = new RegExp(`(?<![\\w-])((?:[a-z]+:)*(?:text|bg|border(?:-[trblxy])?|ring|ring-offset|outline|fill|stroke|from|via|to|divide|placeholder|caret|accent|decoration|shadow)-)(${PALETTES})(?:-(50|100|200|300|400|500|600|700|800|900|950))?(?=[/\\s'"\`}]|$)`, 'g');
  const out = code.replace(re, (m, pre, pal, shade) => {
    let r = m;
    if (pal === 'white' && !shade) r = pre + 'black'; else if (pal === 'black' && !shade) r = pre + 'white';
    else if (shade) { const n = Number(shade); const k = n === 50 ? 950 : n === 950 ? 50 : 1000 - n; r = `${pre}${pal}-${k}`; }
    if (r !== m) changed++; return r;
  });
  return { code: out, changed };
}
