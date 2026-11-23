/** Même voix que les agents : UTF-8, un octet = huit bits. */

export function say(text: string): string {
  return [...new TextEncoder().encode(text)].map((b) => b.toString(2).padStart(8, '0')).join(' ');
}

export function isSpeech(value: string): boolean {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return parts.length > 0 && parts.every((p) => /^[01]{8}$/.test(p));
}

export function hear(value: string): string {
  if (!isSpeech(value)) return value;
  const bytes = value.trim().split(/\s+/).map((p) => Number.parseInt(p, 2));
  return new TextDecoder().decode(Uint8Array.from(bytes));
}
