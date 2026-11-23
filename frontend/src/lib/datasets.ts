/** Import local de données personnelles (CSV / JSON) : parsé dans le navigateur, borné, jamais envoyé ailleurs que vers votre gateway. */
import type { Dataset } from '../types';

function parseCsv(text: string): Array<Record<string, unknown>> {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : firstLine.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some((x) => x.trim())) rows.push(row);
  const [head, ...body] = rows;
  if (!head) return [];
  const keys = head.map((h, i) => h.trim() || `col${i + 1}`);
  return body.map((r) => Object.fromEntries(keys.map((k, i) => {
    const v = (r[i] ?? '').trim();
    return [k, /^-?\d+([.,]\d+)?$/.test(v) ? Number(v.replace(',', '.')) : v];
  })));
}

export async function readDataset(file: File): Promise<Dataset> {
  if (file.size > 1_500_000) throw new Error('Fichier trop volumineux (1,5 Mo max)');
  const text = await file.text();
  let rows: Array<Record<string, unknown>>;
  if (/\.json$/i.test(file.name) || /^\s*[[{]/.test(text)) {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : Object.values(j).find(Array.isArray) ?? [j];
    rows = (arr as unknown[]).filter((x) => x && typeof x === 'object' && !Array.isArray(x)) as Array<Record<string, unknown>>;
  } else rows = parseCsv(text);
  if (!rows.length) throw new Error('Aucune ligne exploitable');
  const name = file.name.replace(/\.[^.]+$/, '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'donnees';
  return { name, rows: rows.slice(0, 2000), file: file.name };
}
