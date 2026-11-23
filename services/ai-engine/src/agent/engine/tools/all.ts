import type { AgentTool } from './types.ts';
import { McpCall, McpListTools } from './mcp.ts';
import { Task } from './task.ts';
import { Build, EditFile, Glob, Grep, ReadFile, ShadcnAdd, TestBackend, WriteFile } from './workspace.ts';

/** Registre unique. Chaque agent n'en reçoit qu'un sous-ensemble. */
export const TOOLS = {
  read_file: ReadFile,
  write_file: WriteFile,
  edit_file: EditFile,
  grep: Grep,
  glob: Glob,
  shadcn_add: ShadcnAdd,
  test_backend: TestBackend,
  build: Build,
  task: Task,
  mcp_list_tools: McpListTools,
  mcp_call: McpCall,
} as const satisfies Record<string, AgentTool>;

export function toolByName(name: string): AgentTool | undefined {
  return (TOOLS as Record<string, AgentTool>)[name];
}
