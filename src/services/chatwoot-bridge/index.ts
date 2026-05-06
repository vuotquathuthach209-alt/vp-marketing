/**
 * Chatwoot bridge — main exports.
 *
 * Mirrors FB Messenger conversations into Chatwoot inbox UI for human agents.
 * Bot still runs autonomously via smartreply (existing); this is a parallel
 * agent dashboard, NOT replacement for AI.
 *
 * Flow A — Incoming FB message (called from autoreply.ts):
 *   1. mirrorIncomingMessage(psid, pageId, name, content)
 *   2. Lookup or create Chatwoot contact + conversation
 *   3. Post message as 'incoming' to Chatwoot conversation
 *   4. Return mapping (or null if bridge disabled / failed)
 *
 * Flow B — Bot reply (called from autoreply.ts after smartReply):
 *   1. mirrorBotReply(psid, pageId, replyText)
 *   2. Lookup mapping by psid
 *   3. Post message as 'outgoing' (so agent sees what bot replied)
 *
 * Flow C — Agent reply in Chatwoot (handled by chatwoot-bridge route):
 *   See ../routes/chatwoot-bridge.ts — POST /webhooks/chatwoot-bridge/fb-sonder
 *
 * Reference: skill sonder-tech-sovereignty + sonder-sso-identity
 */

import { db } from '../../db';
import {
  isChatwootBridgeEnabled,
  getChatwootInboxId,
  findContactBySourceId,
  createContact,
  createConversation,
  postMessage,
  getConversation,
} from './chatwoot-client';
import type { BridgeMapping } from './types';

const INBOX_IDENTIFIER = process.env.CHATWOOT_INBOX_IDENTIFIER || 'fb-sonder-892083053979896';

export {
  isChatwootBridgeEnabled,
  getChatwootInboxId,
};

/* ───────── DB helpers ───────── */

export function findMappingByPSID(fbPsid: string, fbPageId: string): BridgeMapping | null {
  return db.prepare(
    `SELECT * FROM chatwoot_bridge_mappings WHERE fb_psid = ? AND fb_page_id = ?`,
  ).get(fbPsid, fbPageId) as BridgeMapping | null;
}

export function findMappingByConversationId(conversationId: number): BridgeMapping | null {
  return db.prepare(
    `SELECT * FROM chatwoot_bridge_mappings WHERE chatwoot_conversation_id = ?`,
  ).get(conversationId) as BridgeMapping | null;
}

function upsertMapping(opts: {
  fb_psid: string;
  fb_page_id: string;
  chatwoot_contact_id: number;
  chatwoot_conversation_id: number;
}): number {
  const now = Date.now();
  const existing = findMappingByPSID(opts.fb_psid, opts.fb_page_id);
  if (existing) {
    db.prepare(
      `UPDATE chatwoot_bridge_mappings
       SET chatwoot_contact_id = ?, chatwoot_conversation_id = ?,
           last_message_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(opts.chatwoot_contact_id, opts.chatwoot_conversation_id, now, now, existing.id);
    return existing.id;
  }
  const r = db.prepare(
    `INSERT INTO chatwoot_bridge_mappings
     (fb_psid, fb_page_id, chatwoot_contact_id, chatwoot_conversation_id,
      chatwoot_inbox_identifier, status, last_message_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(
    opts.fb_psid, opts.fb_page_id, opts.chatwoot_contact_id, opts.chatwoot_conversation_id,
    INBOX_IDENTIFIER, now, now,
  );
  return r.lastInsertRowid as number;
}

/* ───────── Public API ───────── */

/**
 * Mirror incoming FB message to Chatwoot inbox.
 * Idempotent — safe to call multiple times.
 *
 * Returns the mapping id (if bridge active) or null (if disabled / failed).
 * Failure is non-fatal — caller continues normal smartreply flow.
 */
export async function mirrorIncomingMessage(opts: {
  fb_psid: string;
  fb_page_id: string;
  guest_name: string;
  content: string;
}): Promise<number | null> {
  if (!isChatwootBridgeEnabled()) return null;

  try {
    const inboxId = getChatwootInboxId();
    let mapping = findMappingByPSID(opts.fb_psid, opts.fb_page_id);

    let contactId: number | null = mapping?.chatwoot_contact_id ?? null;
    let convId: number | null = mapping?.chatwoot_conversation_id ?? null;

    // Step 1: ensure contact exists
    if (!contactId) {
      const existing = await findContactBySourceId(opts.fb_psid);
      if (existing) {
        contactId = existing.id;
      } else {
        const created = await createContact({
          name: opts.guest_name || `FB ${opts.fb_psid.slice(0, 8)}`,
          source_id: opts.fb_psid,
          inbox_id: inboxId,
        });
        if (!created) return null;
        contactId = created.id;
      }
    }

    // Step 2: ensure conversation exists + status open
    if (convId) {
      const existing = await getConversation(convId);
      if (!existing || existing.status === 'resolved') {
        // Conversation closed — create new one
        convId = null;
      }
    }
    if (!convId) {
      const created = await createConversation({
        contact_id: contactId,
        inbox_id: inboxId,
        source_id: opts.fb_psid,
        message: { content: opts.content, message_type: 'incoming' },
      });
      if (!created) return null;
      convId = created.id;
    } else {
      // Conversation already open — just post the new incoming message
      await postMessage(convId, opts.content, 'incoming');
    }

    // Step 3: persist mapping
    return upsertMapping({
      fb_psid: opts.fb_psid,
      fb_page_id: opts.fb_page_id,
      chatwoot_contact_id: contactId,
      chatwoot_conversation_id: convId,
    });
  } catch (e: any) {
    console.warn('[chatwoot-bridge] mirrorIncomingMessage fail:', e?.message);
    return null;
  }
}

/**
 * Mirror bot reply (outgoing) to Chatwoot inbox so agents see context.
 * No-op if no mapping exists (incoming wasn't mirrored).
 */
export async function mirrorBotReply(opts: {
  fb_psid: string;
  fb_page_id: string;
  reply_text: string;
}): Promise<boolean> {
  if (!isChatwootBridgeEnabled()) return false;
  const mapping = findMappingByPSID(opts.fb_psid, opts.fb_page_id);
  if (!mapping?.chatwoot_conversation_id) return false;
  try {
    await postMessage(mapping.chatwoot_conversation_id, opts.reply_text, 'outgoing');
    db.prepare(
      `UPDATE chatwoot_bridge_mappings SET last_message_at = ?, updated_at = ? WHERE id = ?`,
    ).run(Date.now(), Date.now(), mapping.id);
    return true;
  } catch (e: any) {
    console.warn('[chatwoot-bridge] mirrorBotReply fail:', e?.message);
    return false;
  }
}

/**
 * Add a private note to Chatwoot conversation (visible to agents only, NOT to FB).
 * Useful for: "Bot reply confidence < 0.7 → escalating to human."
 */
export async function addAgentNote(
  fb_psid: string,
  fb_page_id: string,
  note: string,
): Promise<boolean> {
  if (!isChatwootBridgeEnabled()) return false;
  const mapping = findMappingByPSID(fb_psid, fb_page_id);
  if (!mapping?.chatwoot_conversation_id) return false;
  try {
    await postMessage(mapping.chatwoot_conversation_id, note, 'outgoing', true);
    return true;
  } catch (e: any) {
    return false;
  }
}
