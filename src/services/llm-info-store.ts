/**
 * llm-info-store — side-channel để các handler LLM (ragReply, handleObjection)
 * báo cáo provider/model/tokens đã dùng cho dispatchV6 save-to-cache.
 *
 * Lý do có file riêng: tránh circular import giữa smartreply.ts ↔ reply-handlers.ts.
 * Key theo senderId để không race với traffic song song.
 */
export interface LLMInfo {
  provider: string;      // gemini_flash | gemini_pro | chatgpt | qwen | ...
  model: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms?: number;
  hops?: number;
  ts: number;
}

const _store = new Map<string, LLMInfo>();
const TTL_MS = 60_000;

export function rememberLLMInfo(senderId: string | undefined, info: Omit<LLMInfo, 'ts'>): void {
  if (!senderId) return;
  _store.set(senderId, { ...info, ts: Date.now() });
  // Opportunistic GC
  if (_store.size > 500) {
    const now = Date.now();
    for (const [k, v] of _store) {
      if (now - v.ts > TTL_MS) _store.delete(k);
    }
  }
}

export function consumeLLMInfo(senderId: string | undefined): LLMInfo | null {
  if (!senderId) return null;
  const info = _store.get(senderId);
  if (!info) return null;
  _store.delete(senderId);
  if (Date.now() - info.ts > TTL_MS) return null;  // stale
  return info;
}
