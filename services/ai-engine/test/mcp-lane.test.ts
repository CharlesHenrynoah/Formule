import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Toolbox } from '../src/agent/toolbox.ts';
import type { Workspace } from '../src/agent/workspace.ts';

test('deux lectures MCP ne courent pas ensemble', async () => {
  let active = 0;
  let max = 0;
  const mcp = {
    async listTools() {
      return [{ id: 'demo__a', name: 'a', description: '', write: false, server: 'demo', inputSchema: { type: 'object', properties: {} } }];
    },
    async call() {
      active += 1;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return { data: { n: 1 } };
    },
  };
  const tb = new Toolbox({ dir: '/tmp' } as Workspace, mcp, () => {});
  await Promise.all([tb.sampleMcp('data', 'demo__a', {}), tb.sampleMcp('data', 'demo__a', {})]);
  assert.equal(max, 1);
  assert.equal(tb.mcpSamples.length, 2);
});
