/** Garde d'écriture du workspace de build : seulement src/** et index.html. */
export class WorkspacePathError extends Error { constructor(m: string) { super(m); this.name = 'WorkspacePathError'; } }

export function assertWorkspaceWritable(rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 200) throw new WorkspacePathError('chemin vide ou trop long');
  if (rel.includes('\0') || rel.includes('\\')) throw new WorkspacePathError('caractère interdit');
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) throw new WorkspacePathError('chemin absolu interdit');
  const segs = rel.split('/');
  if (segs.some((s) => s === '..' || s === '.' || s === '')) throw new WorkspacePathError('segment interdit');
  if (segs.includes('node_modules')) throw new WorkspacePathError('node_modules interdit');
  if (rel === 'index.html') return rel;
  if (segs[0] === 'src' && segs.length >= 2) return rel;
  throw new WorkspacePathError('hors de src/** et index.html');
}
