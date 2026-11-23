/** Lit un flux SSE (fetch Response) et appelle onData pour chaque ligne `data:` (JSON parsé). */
export async function readSse(res: Response, onData: (data: any, event?: string) => void) {
  if (!res.body) throw new Error('Réponse sans corps');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let event: string | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
      if (!line.startsWith('data:')) { if (!line) event = undefined; continue; }
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { onData(JSON.parse(payload), event); } catch { /* ligne non JSON ignorée */ }
    }
  }
}

export async function ensureOk(res: Response, who: string) {
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  throw new Error(`${who} a répondu ${res.status} : ${body.slice(0, 300)}`);
}
