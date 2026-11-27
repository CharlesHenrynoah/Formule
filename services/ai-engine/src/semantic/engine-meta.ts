import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { providerConf, llm } from '../llm.js';

export const SEMANTIC_ENGINE = 'hybrid-ai-first';

export function gitFingerprint() {
  try {
    const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    return { commit, branch };
  } catch {
    return { commit: null as string | null, branch: null as string | null };
  }
}

export const GIT = gitFingerprint();
export const HAS_HYBRID = existsSync(new URL('./hybrid.ts', import.meta.url));

export function engineBanner() {
  return `moteur ${SEMANTIC_ENGINE} · ${GIT.branch ?? '?'}@${GIT.commit ?? '?'} · llm=${providerConf()?.label ?? 'mock'}/${providerConf()?.model ?? 'none'} · mode=${llm.name}`;
}

export function engineDiagnostic(startedAt: string, llmStatus: { ok: boolean; detail: string }) {
  return {
    service: 'ai-engine',
    startedAt,
    git: GIT,
    semanticEngine: SEMANTIC_ENGINE,
    hybridModulePresent: HAS_HYBRID,
    interpretation: {
      primary: 'interpretAndPlan',
      fallbackSyntaxEquivalent: false,
      llmName: llm.name,
    },
    llm: { configured: !!providerConf(), provider: providerConf()?.label ?? null, model: providerConf()?.model ?? null, ...llmStatus },
  };
}
