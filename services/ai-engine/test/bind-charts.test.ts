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

test('une courbe de commits qui lit les releases est rebranchée sur commits', () => {
  const bound = bindCharts(page);
  assert.equal(bound.changed, true);
  assert.match(bound.code, /for \(const row of commits\)/);
  assert.match(bound.code, /row\.date \?\? row\.createdAt/);
  assert.match(bound.code, /for \(const it of issues\)/);
  assert.equal(bindCharts(bound.code).changed, false);
});
