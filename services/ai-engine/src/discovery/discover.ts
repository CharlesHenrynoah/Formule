/** Classe un outil par sa capacité, pas par un nom de méthode propre à un fournisseur. */
export function toolKind(name: string): 'docs' | 'execute' | 'read' {
  if (/search_docs|documentation/i.test(name)) return 'docs';
  if (/^execute$|run_code/i.test(name)) return 'execute';
  return 'read';
}
