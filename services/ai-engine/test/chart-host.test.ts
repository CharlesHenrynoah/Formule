import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairChartHosts } from '../src/prompts.ts';

test('un div passé à Chart.js devient un canvas', () => {
  const html = `<div id="issues-chart" class="chart-container"></div>
<script>
  const ctx = document.getElementById('issues-chart');
  const chart = new Chart(ctx, { type: 'line' });
</script>`;
  const fixed = repairChartHosts(html);
  assert.match(fixed, /<canvas id="issues-chart" class="chart-container"><\/canvas>/);
  assert.doesNotMatch(fixed, /<div id="issues-chart"/);
});
