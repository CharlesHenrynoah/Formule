/**
 * Lecture de réponses MCP en Markdown (conversion DÉCLARÉE dans la couverture) :
 *  - enregistrements répétés : « ### titre » + lignes « **Clé :** valeur » (séparées par « | »), groupés par « ## section » ;
 *  - tableaux Markdown « | a | b | ».
 * Nombres abrégés (1.2M, 3.4K) convertis et signalés comme approximatifs ; liens [x](url) extraits ; dates normalisées.
 */
export interface MdParse { raw: Record<string, unknown>; note: string }

const slug = (k: string) => k.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function value(v: string, approx: Set<string>, key: string): unknown {
  const s = v.trim().replace(/^`|`$/g, '');
  const link = s.match(/^\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)$/);
  if (link) return link[2];
  const abbr = s.match(/^(-?\d+(?:\.\d+)?)\s*([KMB])$/i);
  if (abbr) { approx.add(key); return Math.round(Number(abbr[1]) * { k: 1e3, m: 1e6, b: 1e9 }[abbr[2].toLowerCase() as 'k' | 'm' | 'b']); }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const d = s.match(/^(\d{1,2}) ([A-Za-z]{3}),? (\d{4})$/);
  if (d && MONTHS[d[2].toLowerCase()] !== undefined) return new Date(Date.UTC(Number(d[3]), MONTHS[d[2].toLowerCase()], Number(d[1]))).toISOString().slice(0, 10);
  if (/^(unknown|n\/a|—|-)$/i.test(s)) return null;
  return s;
}

export function parseMarkdown(text: string): MdParse | null {
  const lines = text.replace(/\r/g, '').split('\n');
  const approx = new Set<string>();
  // 1) enregistrements « ### » avec champs « **Clé:** valeur »
  const records: Record<string, unknown>[] = [];
  let section: string | null = null; let cur: Record<string, unknown> | null = null; let desc: string[] = [];
  const flush = () => { if (cur) { if (desc.length && cur.description === undefined) cur.description = desc.join(' ').slice(0, 400); records.push(cur); } cur = null; desc = []; };
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)(?:\s*\((\d+)\))?\s*$/);
    if (h2 && !line.startsWith('###')) { flush(); section = h2[1].trim(); continue; }
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      flush();
      const id = h3[1].match(/`([^`]+)`/)?.[1];
      const title = h3[1].replace(/\s*\(`[^`]+`\)\s*/, '').replace(/^\d+\.\s*/, '').trim();
      cur = { ...(section ? { groupe: section } : {}), titre: title, ...(id ? { id } : { id: title }) };
      continue;
    }
    if (!cur) continue;
    if (/^---\s*$/.test(line)) { flush(); continue; }
    const fields = [...line.matchAll(/\*\*([^*]+?):\*\*\s*([^|]+?)(?=\s*\||$)/g)];
    if (fields.length) {
      for (const f of fields) {
        const k = slug(f[1]);
        if (k === 'tags') {
          cur.tags = f[2].split(',').map((x) => x.trim()).filter(Boolean);
          for (const t of cur.tags as string[]) { const kv = t.match(/^([a-z_]+):(.+)$/i); if (kv && cur[`tag_${slug(kv[1])}`] === undefined) cur[`tag_${slug(kv[1])}`] = kv[2]; }
        }
        else cur[k] = value(f[2], approx, k);
      }
      continue;
    }
    if (/(🔐|🔒|⛔)/.test(line)) { cur.statut = line.replace(/\*/g, '').trim(); continue; }
    if (line.trim() && !line.startsWith('*and ')) desc.push(line.trim());
  }
  flush();
  const usable = records.filter((r) => Object.keys(r).length >= 4);
  if (usable.length >= 2) {
    const note = `Markdown converti en ${usable.length} enregistrement(s) (conversion déclarée)${approx.size ? ` ; valeurs abrégées par la source, approximatives : ${[...approx].join(', ')}` : ''}`;
    const total = text.match(/Found (\d+) repositor/i)?.[1];
    return { raw: { elements: usable, ...(total ? { total_annonce: Number(total) } : {}) }, note };
  }
  // 2) tableau Markdown
  const tbl = lines.filter((l) => /^\s*\|.*\|\s*$/.test(l));
  if (tbl.length >= 3 && /^\s*\|\s*:?-{2,}/.test(tbl[1])) {
    const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const head = cells(tbl[0]).map(slug);
    const rows = tbl.slice(2).map((l) => Object.fromEntries(cells(l).map((c, i) => [head[i] ?? `col_${i}`, value(c, approx, head[i] ?? `col_${i}`)])));
    return { raw: { lignes: rows }, note: `tableau Markdown converti (${rows.length} lignes, conversion déclarée)${approx.size ? ` ; valeurs abrégées approximatives : ${[...approx].join(', ')}` : ''}` };
  }
  return null;
}
