export interface Experience {
  errorType: string;
  rootCause: string;
  failingInput: unknown;
  correction: string;
  regressionTest: string;
  validated: boolean;
}

/** Seule une correction déjà validée peut être rejouée. */
export function reusable(memory: Experience[], errorType: string): Experience | null {
  return memory.find((item) => item.validated && item.errorType === errorType) ?? null;
}
