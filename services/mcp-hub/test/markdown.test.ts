import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../src/markdown.js';

const sample = `Found 2 repositories across models sorted by trendingScore (descending).

## Models (2)

### meta-llama/Llama-4 (\`meta-llama/Llama-4\`)

**Author:** meta-llama | **Task:** text-generation | **Library:** transformers | **Downloads:** 1.2M | **Likes:** 3402 | **Trending Score:** 512

**Tags:** transformers, llama, text-generation

**Created:** 5 Mar, 2025

**Link:** [https://hf.co/meta-llama/Llama-4](https://hf.co/meta-llama/Llama-4)

---

### openai/whisper (\`openai/whisper\`)

**Author:** openai | **Task:** automatic-speech-recognition | **Downloads:** 845.3K | **Likes:** 980

**Link:** [https://hf.co/openai/whisper](https://hf.co/openai/whisper)

---
`;

describe('Markdown → enregistrements (conversion déclarée)', () => {
  it('champs, nombres abrégés, dates, liens, groupes', () => {
    const r = parseMarkdown(sample)!;
    const [a, b] = (r.raw.elements as Record<string, unknown>[]);
    expect(a).toMatchObject({ groupe: 'Models', id: 'meta-llama/Llama-4', author: 'meta-llama', task: 'text-generation', downloads: 1_200_000, likes: 3402, trending_score: 512, created: '2025-03-05', link: 'https://hf.co/meta-llama/Llama-4' });
    expect(a.tags).toEqual(['transformers', 'llama', 'text-generation']);
    expect(b.downloads).toBe(845_300);
    expect(r.note).toMatch(/approximatives : downloads/);
    expect(r.raw.total_annonce).toBe(2);
  });
  it('un texte libre reste de la documentation', () => {
    expect(parseMarkdown('Le chiffre d’affaires est d’environ 2 millions.')).toBeNull();
  });
});
