/**
 * Budgets centralisés LLM + MCP (PR consolidation).
 * Une seule source de plafonds pour interprétation, liaison, correction et lectures.
 */

export class LlmBudget {
  constructor(
    public readonly max = Number(process.env.FORMULE_LLM_BUDGET ?? 3),
    public used = 0,
  ) {}
  take(n = 1): boolean {
    if (this.used + n > this.max) return false;
    this.used += n;
    return true;
  }
  get remaining() { return Math.max(0, this.max - this.used); }
}

export class McpBudget {
  constructor(
    public readonly maxReads = Number(process.env.FORMULE_MCP_MAX_READS ?? 12),
    public readonly maxRetryReads = Number(process.env.FORMULE_MCP_MAX_RETRY ?? 8),
    public readonly maxPages = Number(process.env.FORMULE_MCP_MAX_PAGES ?? 10),
    public usedReads = 0,
    public usedRetries = 0,
  ) {}
  takeRead(n = 1): boolean {
    if (this.usedReads + n > this.maxReads) return false;
    this.usedReads += n;
    return true;
  }
  takeRetry(n = 1): boolean {
    if (this.usedRetries + n > this.maxRetryReads) return false;
    this.usedRetries += n;
    return true;
  }
  get remainingReads() { return Math.max(0, this.maxReads - this.usedReads); }
  snapshot() {
    return {
      reads: { used: this.usedReads, max: this.maxReads },
      retries: { used: this.usedRetries, max: this.maxRetryReads },
      maxPages: this.maxPages,
    };
  }
}

export type RuntimeBudgets = { llm: LlmBudget; mcp: McpBudget };

export function createRuntimeBudgets(): RuntimeBudgets {
  return { llm: new LlmBudget(), mcp: new McpBudget() };
}
