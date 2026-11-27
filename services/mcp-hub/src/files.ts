import { call } from '@formule/service-kit';

/** Fichiers CSV/JSON joints : restent sur la machine, exposés comme source en lecture seule. */
export interface StoredFile { id: string; name: string; kind: 'csv' | 'json'; rows: number; content: string }

export function parseCsv(text: string): { rows: Record<string, unknown>[]; numericColumns: string[] } {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim().length);
  if (!lines.length) return { rows: [], numericColumns: [] };
  const counts = { ';': lines[0].split(';').length, ',': lines[0].split(',').length, '\t': lines[0].split('\t').length };
  const sep = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]) as string;
  const split = (l: string) => {
    const out: string[] = []; let cur = ''; let q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (c === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === sep && !q) { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur); return out.map((s) => s.trim());
  };
  const head = split(lines[0]);
  const raw = lines.slice(1).map((l) => { const c = split(l); return Object.fromEntries(head.map((h, i) => [h, c[i] ?? ''])); });
  // Conversion DÉCLARÉE : une colonne n'est numérique que si toutes ses valeurs non vides sont des nombres stricts.
  const numericColumns = head.filter((h) => raw.some((r) => r[h] !== '') && raw.every((r) => r[h] === '' || /^-?\d+(\.\d+)?$/.test(String(r[h]))));
  const rows = raw.map((r) => Object.fromEntries(head.map((h) => [h, r[h] === '' ? null : numericColumns.includes(h) ? Number(r[h]) : r[h]])));
  return { rows, numericColumns };
}

export function slug(name: string) { return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'fichier'; }

export async function listFileTools() {
  const files = await call<{ id: string; name: string; kind: string; rows: number }[]>('storage', '/files');
  return files.map((f) => ({ name: `lire_${f.id}`, description: `Fichier local « ${f.name} » (${f.kind.toUpperCase()}, ${f.rows} lignes).`, fileId: f.id }));
}

export async function readFileTool(tool: string) {
  const id = tool.replace(/^lire_/, '');
  const f = await call<StoredFile>('storage', `/files/${id}`);
  if (f.kind === 'json') {
    const parsed = JSON.parse(f.content);
    return { raw: { fichier: f.name, lignes: Array.isArray(parsed) ? parsed : undefined, contenu: Array.isArray(parsed) ? undefined : parsed }, note: 'JSON lu tel quel' };
  }
  const { rows, numericColumns } = parseCsv(f.content);
  return { raw: { fichier: f.name, lignes: rows }, note: numericColumns.length ? `conversion CSV déclarée : colonnes numériques ${numericColumns.join(', ')}` : 'aucune conversion' };
}
