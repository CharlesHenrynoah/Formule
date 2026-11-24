/** Compare une valeur du contrat à ce que le DOM montre. Indépendant du modèle qui a écrit la page. */
export function assertRenderedText(dom: string, testId: string, expected: string): { ok: boolean; note: string } {
  const pattern = new RegExp(`data-testid=["']${testId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>([^<]*)`);
  const found = dom.match(pattern)?.[1]?.replace(/\s+/g, ' ').trim();
  if (found == null) return { ok: false, note: `${testId} absent du DOM` };
  if (found !== expected) return { ok: false, note: `${testId} affiche « ${found} », attendu « ${expected} »` };
  return { ok: true, note: `${testId} = ${expected}` };
}

/** Playwright n'est branché que s'il est installé. Sinon la preuve reste le DOM déjà rendu. */
export async function readTestId(url: string, testId: string): Promise<string | null> {
  try {
    const loaded = await import('playwright') as { chromium?: { launch: () => Promise<{ newPage: () => Promise<{ goto: (target: string) => Promise<void>; getByTestId: (id: string) => { textContent: () => Promise<string | null> }; close: () => Promise<void> }>; close: () => Promise<void> }> } };
    if (!loaded.chromium) return null;
    const browser = await loaded.chromium.launch();
    const page = await browser.newPage();
    await page.goto(url);
    const text = await page.getByTestId(testId).textContent();
    await browser.close();
    return text?.trim() ?? null;
  } catch {
    return null;
  }
}
