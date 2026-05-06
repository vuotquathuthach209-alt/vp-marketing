/**
 * Chatwoot bridge webhook — receives agent replies from Chatwoot inbox
 * and forwards to Facebook Messenger via existing sendFBMessage().
 *
 * Mounted at: POST /webhooks/chatwoot-bridge/fb-sonder
 *
 * Configure in Chatwoot:
 *   Inbox settings → Configuration → Webhook URL =
 *   https://app.sondervn.com/webhooks/chatwoot-bridge/fb-sonder
 *
 * Payload (Chatwoot v4.x):
 *   {
 *     event: "message_created",
 *     message_type: "outgoing",
 *     content: "<agent reply text>",
 *     conversation: { id: 123, ... },
 *     sender: { type: "user" | "agent_bot", id, name },
 *     ...
 *   }
 *
 * Idempotency: rely on Chatwoot dedup + our own bridge mapping.
 * Security: optional HMAC verification via CHATWOOT_INBOX_HMAC_TOKEN env.
 *
 * Reference: skill sonder-tech-sovereignty (Chatwoot omnichannel)
 */

import { Router } from 'express';
import { db } from '../db';
import { findMappingByConversationId } from '../services/chatwoot-bridge';
import { sendFBMessage } from '../services/autoreply';
import type { ChatwootWebhookPayload } from '../services/chatwoot-bridge/types';
import crypto from 'crypto';

const router = Router();

const HMAC_TOKEN = process.env.CHATWOOT_INBOX_HMAC_TOKEN || '';

/**
 * HMAC verify (optional) — Chatwoot can sign outgoing webhooks with HMAC token
 * stored in inbox config. Skip verify if no token (development).
 */
function verifyHmac(rawBody: string, signature: string | undefined): boolean {
  if (!HMAC_TOKEN) return true; // skip if not configured
  if (!signature) return false;
  const expected = crypto
    .createHmac('sha256', HMAC_TOKEN)
    .update(rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex'),
    );
  } catch {
    return false;
  }
}

router.post('/chatwoot-bridge/fb-sonder', async (req, res) => {
  const startedAt = Date.now();
  try {
    // Optional HMAC verification (Chatwoot signs body if HMAC token configured)
    if (HMAC_TOKEN) {
      const sig = req.headers['x-chatwoot-signature'] as string | undefined;
      const rawBody = JSON.stringify(req.body);
      if (!verifyHmac(rawBody, sig)) {
        console.warn('[chatwoot-bridge] HMAC mismatch — rejecting webhook');
        return res.status(401).json({ error: 'invalid signature' });
      }
    }

    const payload = req.body as ChatwootWebhookPayload;

    // Only handle outgoing message events (agent reply)
    if (payload.event !== 'message_created') {
      return res.json({ ok: true, skipped: 'not_message_event' });
    }
    if (payload.message_type !== 'outgoing') {
      return res.json({ ok: true, skipped: 'not_outgoing' });
    }
    if (payload.private === true) {
      // Private notes: agent-only, do NOT send to FB guest
      return res.json({ ok: true, skipped: 'private_note' });
    }
    // Skip if sender is agent_bot (this is bot's own mirrored reply, not agent)
    if (payload.sender?.type === 'agent_bot') {
      return res.json({ ok: true, skipped: 'sender_is_bot' });
    }

    const content = (payload.content || '').trim();
    if (!content) {
      return res.json({ ok: true, skipped: 'empty_content' });
    }

    const conversationId = payload.conversation?.id;
    if (!conversationId) {
      return res.json({ ok: true, skipped: 'no_conversation_id' });
    }

    // Lookup FB PSID from mapping
    const mapping = findMappingByConversationId(conversationId);
    if (!mapping) {
      console.warn(`[chatwoot-bridge] no mapping for conversation ${conversationId}`);
      return res.json({ ok: true, skipped: 'no_mapping' });
    }

    // Get FB Page access token
    const page = db.prepare(
      `SELECT access_token FROM pages WHERE fb_page_id = ? LIMIT 1`,
    ).get(mapping.fb_page_id) as { access_token: string } | undefined;
    if (!page?.access_token) {
      console.warn(`[chatwoot-bridge] no FB token for page ${mapping.fb_page_id}`);
      return res.status(500).json({ error: 'fb_token_missing' });
    }

    // Send to FB Messenger
    await sendFBMessage(page.access_token, mapping.fb_psid, content);
    console.log(
      `[chatwoot-bridge] forwarded conversation ${conversationId} → FB psid ${mapping.fb_psid} ` +
      `(${Date.now() - startedAt}ms)`,
    );

    return res.json({
      ok: true,
      forwarded_to_fb: true,
      psid: mapping.fb_psid,
      conversation_id: conversationId,
    });
  } catch (e: any) {
    console.error('[chatwoot-bridge] error:', e?.response?.data || e?.message);
    return res.status(500).json({ error: e?.message || 'internal_error' });
  }
});

export default router;
