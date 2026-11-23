/**
 * Une série temporelle doit lire une collection réelle et une date réelle.
 * Cela vaut pour n'importe quel projet : le nom weeklyCommits n'est pas requis,
 * ni les fonctions asDate et isoWeek. Un classement sans date n'est pas touché.
 */

const DATE_READ = /createdAt|created_at|publishedAt|published_at|updatedAt|mergedAt|\.date\b/;

function statesOf(source: string): string[] {
  return [...source.matchAll(/const \[([A-Za-z][\w]*),/g)].map((match) => match[1]).sort((a, b) => b.length - a.length);
}

function intendedState(name: string, source: string, states: string[]): string | null {
  const inName = states.find((state) => name.toLowerCase().includes(state.toLowerCase()));
  if (inName) return inName;
  const at = source.indexOf(`data={${name}}`);
  if (at < 0) return null;
  const around = source.slice(Math.max(0, at - 500), at).toLowerCase();
  return states.find((state) => around.includes(state.toLowerCase())) ?? null;
}

function timeSeries(name: string, body: string, source: string): boolean {
  if (/\.points\b|\.valeur\b/.test(body)) return true;
  if (/semaine|weekly|par semaine|by week|courbe/i.test(`${name} ${body}`)) return true;
  const at = source.indexOf(`data={${name}}`);
  if (at < 0) return false;
  return /semaine|par semaine|courbe|par jour|derniers mois/i.test(source.slice(Math.max(0, at - 400), at));
}

const WEEK_FILL = 'at += 7 * 86400000';

function weekExpr(source: string): string {
  if (/\bfunction isoWeek\b/.test(source) || /\bisoWeek\(/.test(source)) return 'isoWeek(new Date(at))';
  return "(function (at) { const day = new Date(Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), new Date(at).getUTCDate())); const dow = day.getUTCDay() || 7; day.setUTCDate(day.getUTCDate() + 4 - dow); const start = new Date(Date.UTC(day.getUTCFullYear(), 0, 1)); const week = Math.ceil((((day.getTime() - start.getTime()) / 86400000) + 1) / 7); return day.getUTCFullYear() + '-' + String(week).padStart(2, '0'); })(at)";
}

function seriesBody(state: string, source: string): string {
  const at = /\bfunction asDate\b/.test(source)
    ? 'asDate(row.date ?? row.createdAt ?? row.created_at ?? row.publishedAt ?? row.published_at)'
    : "new Date(String(row.date ?? row.createdAt ?? row.created_at ?? row.publishedAt ?? row.published_at ?? '')).getTime()";
  const week = weekExpr(source);
  return `const ${'NAME'} = useMemo(() => {
    const buckets = new Map<string, number>();
    const cutoff = Date.now() - 90 * 86400000;
    for (const row of ${state}) {
      const at = ${at};
      if (!at || at < cutoff) continue;
      const wk = ${week};
      buckets.set(wk, (buckets.get(wk) ?? 0) + 1);
    }
    for (let at = cutoff; at <= Date.now(); ${WEEK_FILL}) {
      const wk = ${week};
      if (!buckets.has(wk)) buckets.set(wk, 0);
    }
    return Array.from(buckets.entries()).map(([label, count]) => ({ label, count })).sort((a, b) => a.label.localeCompare(b.label)).slice(-13);
  }, [${state}]);`;
}

/** Ajoute les semaines à zéro sur un comptage déjà correct, sans remplacer une série multiple. */
function fillWeekGaps(source: string): string {
  return source.replace(/const ([A-Za-z][\w]*) = useMemo\(\(\) => \{([\s\S]*?)\}, \[[^\]]*\]\);/g, (full, name: string, body: string) => {
    if (body.includes(WEEK_FILL) || !timeSeries(name, body, source)) return full;
    if (!/Map<string,\s*number>/.test(body) && !/buckets\.set\([^)]+,\s*\(buckets\.get\(/.test(body)) return full;
    const week = weekExpr(body + source);
    const guard = /const cutoff\b/.test(body) ? '' : 'const cutoff = Date.now() - 90 * 86400000;\n    ';
    const loop = `${guard}for (let at = cutoff; at <= Date.now(); ${WEEK_FILL}) {\n      const wk = ${week};\n      if (!buckets.has(wk)) buckets.set(wk, 0);\n    }\n    `;
    return full.replace('return ', `${loop}return `);
  });
}

/** Rebranche toute série temporelle qui ne lit pas une date réelle. */
export function bindCharts(source: string): { code: string; changed: boolean } {
  const states = statesOf(source);
  if (!states.length || !source.includes('useMemo')) return { code: source, changed: false };
  let changed = false;
  const code = source.replace(/const ([A-Za-z][\w]*) = useMemo\(\(\) => \{[\s\S]*?\}, \[[^\]]*\]\);/g, (full, name: string) => {
    const body = full.slice(full.indexOf('=>'), full.lastIndexOf('}, ['));
    if (!timeSeries(name, body, source) || body.includes(WEEK_FILL) || (DATE_READ.test(body) && !/\.points\b|\.valeur\b/.test(body))) return full;
    const state = intendedState(name, source, states);
    if (!state) return full;
    changed = true;
    return seriesBody(state, source).replace('const NAME =', `const ${name} =`);
  });
  const filled = fillWeekGaps(code);
  return { code: filled, changed: changed || filled !== source };
}
