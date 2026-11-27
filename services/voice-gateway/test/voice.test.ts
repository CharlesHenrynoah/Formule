import { describe, expect, it } from 'vitest';

process.env.VITEST = 'true';
const { interpretConfirmation, stripWakeWord } = await import('../src/index.js');

describe('voix', () => {
  it('une transcription ambiguë ne confirme pas', () => {
    expect(interpretConfirmation('oui', 0.95)).toBe('yes');
    expect(interpretConfirmation('oui', 0.4)).toBe('ambiguous');
    expect(interpretConfirmation('oui non', 0.95)).toBe('ambiguous');
    expect(interpretConfirmation('peut-être', null)).toBe('ambiguous');
    expect(interpretConfirmation('Non.', 0.9)).toBe('no');
  });
  it('mot d’éveil', () => {
    expect(stripWakeWord('Jarvis, montre le revenu')).toBe('montre le revenu');
    expect(stripWakeWord('montre le revenu')).toBeNull();
  });
});
