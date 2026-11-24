import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindCharts } from '../src/agent/engine/bind-charts.ts';

const page = `function asDate(v: unknown) { return 1; }
function isoWeek(d: Date) { return '2026-47'; }
function Dashboard() {
  const [commits, setCommits] = useState<Row[]>([]);
  const [issues, setIssues] = useState<Row[]>([]);
  const weeklyIssues = useMemo(() => {
    for (const it of issues) { asDate(it.createdAt); }
    return [];
  }, [issues]);
  const weeklyCommits = useMemo(() => {
    const buckets = new Map<string, number>();
    for (const rel of releases) {
      const points = rel.points;
      if (!Array.isArray(points)) continue;
    }
    return [];
  }, [releases]);
}
`;

test('une courbe sans helper, sur un autre projet, lit sa collection', () => {
  const other = `function Page() {
  const [orders, setOrders] = useState([]);
  const ordersByWeek = useMemo(() => {
    return notes.map((n) => n.points);
  }, [notes]);
  return <h3>Commandes par semaine</h3>;
}`;
  const bound = bindCharts(other + '\n<Chart data={ordersByWeek} />');
  assert.equal(bound.changed, true);
  assert.match(bound.code, /for \(const row of orders\)/);
  assert.match(bound.code, /new Date\(String\(row\.date/);
  assert.match(bound.code, /at \+= 7 \* 86400000/);
  assert.match(bound.code, /buckets\.set\(wk, 0\)/);
});

test('une courbe de mesure n\'est pas remplacée par un comptage', () => {
  const page = `function Page() {
  const [rows, setRows] = useState([]);
  const series = useMemo(() => rows.flatMap((row) => {
    const date = String(row.updated_at ?? '');
    const value = Number(row.price);
    return date && Number.isFinite(value) ? [{ date, value }] : [];
  }), [rows]);
  return <h3>Courbe sur 30 jours</h3>;
}`;
  const bound = bindCharts(page + '\n<Chart data={series} />');
  assert.equal(bound.changed, false);
  assert.match(bound.code, /Number\(row\.price\)/);
  assert.doesNotMatch(bound.code, /buckets\.set\(wk/);
});

test('un classement sans date n\'est pas rebranché', () => {
  const rank = `function Page() {
  const [authors, setAuthors] = useState([]);
  const topAuthors = useMemo(() => authors.map((a) => a.login), [authors]);
  return <h3>Top auteurs</h3>;
}`;
  assert.equal(bindCharts(rank + '\n<Chart data={topAuthors} />').changed, false);
});

test('une date lue dans points ne compte pas comme une date réelle', () => {
  const dated = page.replace('if (!Array.isArray(points)) continue;', 'const d = asDate(p?.date); if (!d) continue;');
  const bound = bindCharts(dated);
  assert.equal(bound.changed, true);
  assert.match(bound.code, /for \(const row of commits\)/);
});

test('une courbe de commits qui lit les releases est rebranchée sur commits', () => {
  const bound = bindCharts(page);
  assert.equal(bound.changed, true);
  assert.match(bound.code, /for \(const row of commits\)/);
  assert.match(bound.code, /row\.date \?\? row\.createdAt/);
  assert.match(bound.code, /for \(const it of issues\)/);
  assert.equal(bindCharts(bound.code).changed, false);
});
