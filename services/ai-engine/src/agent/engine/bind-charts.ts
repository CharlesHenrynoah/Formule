/**
 * Une courbe « par semaine » doit lire la collection du même nom.
 * weeklyCommits lit commits, et la date réellement gardée (date, createdAt, publishedAt).
 * Si le modèle a inventé un champ, on rebranche avant le build.
 */

export function bindCharts(source: string): { code: string; changed: boolean } {
  if (!/\bfunction asDate\b/.test(source) || !/\bfunction isoWeek\b/.test(source)) return { code: source, changed: false };
  let changed = false;
  const code = source.replace(/const (weekly[A-Za-z0-9]+) = useMemo\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/g, (full, name: string) => {
    const raw = name.replace(/^weekly/, '');
    const state = raw.charAt(0).toLowerCase() + raw.slice(1);
    if (!new RegExp(`const \\[${state},`).test(source)) return full;
    const body = full.slice(full.indexOf('=>'), full.lastIndexOf('}, ['));
    if (new RegExp(`\\b${state}\\b`).test(body)) return full;
    changed = true;
    return `const ${name} = useMemo(() => {
    const buckets = new Map<string, number>();
    const cutoff = Date.now() - 90 * 86400000;
    for (const row of ${state}) {
      const at = asDate(row.date ?? row.createdAt ?? row.created_at ?? row.publishedAt ?? row.published_at);
      if (!at || at < cutoff) continue;
      const wk = isoWeek(new Date(at));
      buckets.set(wk, (buckets.get(wk) ?? 0) + 1);
    }
    return Array.from(buckets.entries()).map(([label, count]) => ({ label, count })).sort((a, b) => a.label.localeCompare(b.label)).slice(-13);
  }, [${state}]);`;
  });
  return { code, changed };
}
