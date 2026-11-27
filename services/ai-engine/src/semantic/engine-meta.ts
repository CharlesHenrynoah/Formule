import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { providerConf, llm } from '../llm.js';

export const SEMANTIC_ENGINE = 'hybrid-ai-first';

/** Empreinte git fiable : env Docker/build > git local > fichier stamp. */
export function gitFingerprint() {
  const envCommit = process.env.FORMULE_GIT_COMMIT?.trim() || null;
  const envBranch = process.env.FORMULE_GIT_BRANCH?.trim() || null;
  if (envCommit) return { commit: envCommit.slice(0, 12), branch: envBranch ?? 'detached' };
  try {
    const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    return { commit, branch };
  } catch {
    try {
      const stamp = readFileSync(new URL('../../../.formule-engine-stamp', import.meta.url), 'utf8').trim();
      const [branch, commit] = stamp.split('@');
      if (commit) return { commit: commit.slice(0, 12), branch: branch || 'stamp' };
    } catch { /* pas de stamp */ }
    return { commit: null as string | null, branch: null as string | null };
  }
}

export const GIT = gitFingerprint();
export const HAS_HYBRID = existsSync(new URL('./hybrid.ts', import.meta.url));
export const HAS_CONTRACT_GUARD = existsSync(new URL('./contract-guard.ts', import.meta.url));

export function engineId() {
  return `${SEMANTIC_ENGINE}@${GIT.branch ?? '?'}/${GIT.commit ?? '?'}`;
}

export function engineBanner() {
  return `moteur ${engineId()} · llm=${providerConf()?.label ?? 'mock'}/${providerConf()?.model ?? 'none'} · mode=${llm.name} · guard=${HAS_CONTRACT_GUARD}`;
}

export function engineDiagnostic(startedAt: string, llmStatus: { ok: boolean; detail: string }) {
  return {
    service: 'ai-engine',
    startedAt,
    git: GIT,
    engineId: engineId(),
    semanticEngine: SEMANTIC_ENGINE,
    hybridModulePresent: HAS_HYBRID,
    contractGuardPresent: HAS_CONTRACT_GUARD,
    interpretation: {
      primary: 'interpretAndPlan',
      fallbackSyntaxEquivalent: false,
      llmName: llm.name,
      llmBudgetMax: 3,
    },
    runtime: {
      docker: !!process.env.FORMULE_GIT_COMMIT || process.env.NODE_ENV === 'production',
      pid: process.pid,
      cwd: process.cwd(),
    },
    llm: { configured: !!providerConf(), provider: providerConf()?.label ?? null, model: providerConf()?.model ?? null, ...llmStatus },
  };
}
