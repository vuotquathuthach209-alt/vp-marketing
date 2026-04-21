/**
 * Bot Playground — admin test chat bot mà không cần qua FB.
 *
 * Gọi thẳng smartReplyWithSender hoặc dispatchV6 với fake senderId, trả về
 * reply + debug info (intent, handler, cache hit, latency, tokens, provider).
 *
 * Endpoints:
 *   POST /api/playground/test
 *     body: { hotel_id, message, sender_name?, reset_session? }
 *     returns: { reply, intent, tier, latency_ms, debug }
 *   POST /api/playground/reset — clear playground session (conversation_memory)
 *   GET  /api/playground/hotels — list hotels để admin chọn test cho hotel nào
 */
import { Router } from 'express';
import { db } from '../db';
import { authMiddleware, AuthRequest, getHotelId } from '../middleware/auth';
import { consumeLLMInfo } from '../services/llm-info-store';

const router = Router();
router.use(authMiddleware);

// Sender ID cố định cho playground (per hotel) để không bị lẫn với traffic thật
function playgroundSenderId(hotelId: number, userId: number): string {
  return `playground_${hotelId}_${userId}`;
}

router.get('/hotels', (req: AuthRequest, res) => {
  try {
    // Super admin xem tất cả; owner chỉ xem hotel của mình
    const role = req.user?.role;
    let rows;
    if (role === 'superadmin') {
      rows = db.prepare(
        `SELECT mkt_hotel_id, name, product_group, brand_voice, rooms_count, amenities_count, has_policies, price_min_vnd, monthly_price_from
         FROM v_hotel_bot_context
         ORDER BY mkt_hotel_id`
      ).all();
    } else {
      rows = db.prepare(
        `SELECT mkt_hotel_id, name, product_group, brand_voice, rooms_count, amenities_count, has_policies, price_min_vnd, monthly_price_from
         FROM v_hotel_bot_context WHERE mkt_hotel_id = ?`
      ).all(getHotelId(req));
    }
    res.json({ hotels: rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/reset', (req: AuthRequest, res) => {
  try {
    const hotelId = parseInt(String((req.body || {}).hotel_id || getHotelId(req)), 10);
    const senderId = playgroundSenderId(hotelId, req.user?.userId || 0);
    const r = db.prepare(`DELETE FROM conversation_memory WHERE sender_id = ?`).run(senderId);
    res.json({ ok: true, deleted: r.changes });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/test', async (req: AuthRequest, res) => {
  try {
    const { message, sender_name } = req.body || {};
    const hotelId = parseInt(String((req.body || {}).hotel_id || getHotelId(req)), 10);
    if (!message || typeof message !== 'string' || message.length < 1) {
      return res.status(400).json({ error: 'message required' });
    }
    if (message.length > 1000) {
      return res.status(400).json({ error: 'message quá dài (max 1000)' });
    }

    const senderId = playgroundSenderId(hotelId, req.user?.userId || 0);
    const t0 = Date.now();

    // Gọi trực tiếp smartReplyWithSender (path chuẩn bot đang dùng)
    const { smartReplyWithSender } = require('../services/smartreply');
    const result = await smartReplyWithSender(
      message,
      senderId,
      sender_name || 'PlaygroundAdmin',
      false,       // hasImage
      hotelId,
      0,           // pageId (playground dùng page 0)
    );

    // Lookup LLM info (provider, model, tokens) nếu có
    const llm = consumeLLMInfo(senderId);

    // Check cache hit info
    let cacheInfo: any = null;
    try {
      const { matchIntent } = require('../services/intent-matcher');
      const m = await matchIntent({ hotelId, customerMessage: message });
      cacheInfo = {
        matched: m.matched,
        confidence: m.confidence,
        tier: m.tier,
        used_cached: m.should_use_cached,
        cached_question: m.cached_question,
      };
    } catch {}

    // History recent
    const history = db.prepare(
      `SELECT role, message, intent, created_at FROM conversation_memory
       WHERE sender_id = ? ORDER BY id DESC LIMIT 10`
    ).all(senderId) as any[];

    res.json({
      reply: result.reply,
      intent: result.intent,
      tier: result.tier,
      confidence: (result as any).confidence,
      latency_ms: result.latency_ms,
      total_latency_ms: Date.now() - t0,
      debug: {
        sender_id_internal: senderId,
        llm_info: llm,
        cache_match: cacheInfo,
        images: (result as any).images,
      },
      history: history.reverse().slice(-8).map(h => ({
        role: h.role,
        message: h.message,
        intent: h.intent,
        ts: h.created_at,
      })),
    });
  } catch (e: any) {
    console.error('[playground] error:', e);
    res.status(500).json({ error: e.message || 'playground error' });
  }
});

export default router;
