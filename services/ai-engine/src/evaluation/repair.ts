export type Layer = 'mcp' | 'raw' | 'transform' | 'storage' | 'backend' | 'frontend' | 'render';

/** La première couche nommée dans l'échec est celle qu'on corrige. */
export function locate(note: string): Layer {
  const text = note.toLowerCase();
  if (/mcp|outil|argument/.test(text)) return 'mcp';
  if (/brut|raw/.test(text)) return 'raw';
  if (/agr[eé]g|transform|comptage/.test(text)) return 'transform';
  if (/collection|stock/.test(text)) return 'storage';
  if (/backend|outil compil/.test(text)) return 'backend';
  if (/dom|rendu|affiche/.test(text)) return 'render';
  return 'frontend';
}
