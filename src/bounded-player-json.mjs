// Shared by native HTTP adapters and the browser companion client.
export async function boundedPlayerJson(response, maximumBytes = 1024 * 1024) {
  let text;
  const reader = response.body?.getReader?.();
  if (!reader) {
    text = await response.text();
    if (new TextEncoder().encode(text).length > maximumBytes) throw new Error('Player response exceeds the permitted size.');
  } else {
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > maximumBytes) throw new Error('Player response exceeds the permitted size.');
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } finally { void reader.cancel().catch(() => {}); }
  }
  try { return JSON.parse(text); } catch { throw new Error('Unreadable player response.'); }
}
