// Rust caches conversation media on disk. Keep a small working set for quick revisits.
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 256;

function createCache() {
  const pending = new Map<string, Promise<ArrayBuffer>>();
  const recent = new Map<string, ArrayBuffer>();
  let size = 0;

  return (key: string, load: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> => {
    const hit = recent.get(key);
    if (hit) {
      // Map iteration order now puts this item at the most recently used end.
      recent.delete(key);
      recent.set(key, hit);
      return Promise.resolve(hit);
    }
    const active = pending.get(key);
    if (active) return active;

    const request = load().then((bytes) => {
      if (bytes.byteLength > MAX_BYTES || !bytes.byteLength) return bytes;
      recent.set(key, bytes);
      size += bytes.byteLength;
      for (const [oldest, value] of recent) {
        if (size <= MAX_BYTES && recent.size <= MAX_ENTRIES) break;
        recent.delete(oldest);
        size -= value.byteLength;
      }
      return bytes;
    }).finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
}

export let loadChatMedia = createCache();

export function clearChatMedia() {
  // Requests from an earlier Telegram session finish against their original cache.
  loadChatMedia = createCache();
}
