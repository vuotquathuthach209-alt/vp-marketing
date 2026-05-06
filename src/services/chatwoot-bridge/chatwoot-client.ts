/**
 * Chatwoot API client — typed wrapper.
 *
 * Reference: https://www.chatwoot.com/developers/api/
 * Auth: User access token (long-lived, scope: all account).
 *
 * Config via env:
 *   CHATWOOT_BASE_URL=https://chat.sondervn.com
 *   CHATWOOT_API_TOKEN=<user_api_access_token>
 *   CHATWOOT_ACCOUNT_ID=1
 *   CHATWOOT_INBOX_ID=1
 *
 * Note: Skill sonder-tech-sovereignty locks Chatwoot as omnichannel inbox.
 * No vendor lock-in — Chatwoot self-hosted on /opt/chatwoot/.
 */

import axios, { AxiosInstance } from 'axios';
import { ChatwootContact, ChatwootConversation, ChatwootMessage } from './types';

const BASE_URL = process.env.CHATWOOT_BASE_URL || 'https://chat.sondervn.com';
const API_TOKEN = process.env.CHATWOOT_API_TOKEN || '';
const ACCOUNT_ID = parseInt(process.env.CHATWOOT_ACCOUNT_ID || '1', 10);
const INBOX_ID = parseInt(process.env.CHATWOOT_INBOX_ID || '1', 10);
const BRIDGE_ENABLED = process.env.CHATWOOT_BRIDGE_ENABLED !== 'false';

let client: AxiosInstance | null = null;

function getClient(): AxiosInstance {
  if (!client) {
    if (!API_TOKEN) {
      throw new Error('[chatwoot] CHATWOOT_API_TOKEN not configured — bridge disabled');
    }
    client = axios.create({
      baseURL: `${BASE_URL}/api/v1/accounts/${ACCOUNT_ID}`,
      headers: { 'api_access_token': API_TOKEN, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
  }
  return client;
}

export function isChatwootBridgeEnabled(): boolean {
  return BRIDGE_ENABLED && !!API_TOKEN;
}

export function getChatwootInboxId(): number {
  return INBOX_ID;
}

/** Find existing contact by source_id (fb_psid) — returns null if not found */
export async function findContactBySourceId(sourceId: string): Promise<ChatwootContact | null> {
  try {
    const r = await getClient().get('/contacts/search', {
      params: { q: sourceId, include: 'contact_inboxes' },
    });
    const items = r.data?.payload || [];
    for (const c of items) {
      if (c.identifier === sourceId) return c as ChatwootContact;
      const inboxes = c.contact_inboxes || [];
      if (inboxes.some((ib: any) => ib.source_id === sourceId)) return c as ChatwootContact;
    }
    return null;
  } catch (e: any) {
    console.warn('[chatwoot] findContactBySourceId fail:', e?.response?.data || e.message);
    return null;
  }
}

/** Create new contact + assign to inbox (so source_id is registered) */
export async function createContact(opts: {
  name: string;
  source_id: string;     // fb_psid
  inbox_id: number;
  identifier?: string;
}): Promise<ChatwootContact | null> {
  try {
    const r = await getClient().post('/contacts', {
      name: opts.name,
      identifier: opts.identifier || opts.source_id,
      inbox_id: opts.inbox_id,
    });
    const contact = r.data?.payload?.contact;
    if (!contact) return null;

    // Assign contact to inbox với source_id
    try {
      await getClient().post(`/contacts/${contact.id}/contactable_inboxes`, {
        inbox_id: opts.inbox_id,
        source_id: opts.source_id,
      });
    } catch {
      // Some Chatwoot versions auto-create contact_inbox via /contacts. Ignore.
    }
    return contact as ChatwootContact;
  } catch (e: any) {
    console.warn('[chatwoot] createContact fail:', e?.response?.data || e.message);
    return null;
  }
}

/** Create new conversation */
export async function createConversation(opts: {
  contact_id: number;
  inbox_id: number;
  source_id: string;
  message?: { content: string; message_type?: 'incoming' | 'outgoing' };
}): Promise<ChatwootConversation | null> {
  try {
    const body: any = {
      contact_id: opts.contact_id,
      inbox_id: opts.inbox_id,
      source_id: opts.source_id,
      status: 'open',
    };
    if (opts.message) {
      body.message = opts.message;
    }
    const r = await getClient().post('/conversations', body);
    return r.data as ChatwootConversation;
  } catch (e: any) {
    console.warn('[chatwoot] createConversation fail:', e?.response?.data || e.message);
    return null;
  }
}

/** Add message to existing conversation */
export async function postMessage(
  conversationId: number,
  content: string,
  messageType: 'incoming' | 'outgoing' = 'incoming',
  isPrivate = false,
): Promise<ChatwootMessage | null> {
  try {
    const r = await getClient().post(
      `/conversations/${conversationId}/messages`,
      {
        content,
        message_type: messageType,
        private: isPrivate,
      },
    );
    return r.data as ChatwootMessage;
  } catch (e: any) {
    console.warn(`[chatwoot] postMessage fail (conv ${conversationId}):`, e?.response?.data || e.message);
    return null;
  }
}

/** Get conversation by ID — used to verify status before posting */
export async function getConversation(id: number): Promise<ChatwootConversation | null> {
  try {
    const r = await getClient().get(`/conversations/${id}`);
    return r.data as ChatwootConversation;
  } catch (e: any) {
    return null;
  }
}

/** Toggle conversation status (open/resolved) */
export async function setConversationStatus(
  id: number,
  status: 'open' | 'resolved' | 'pending',
): Promise<boolean> {
  try {
    await getClient().post(`/conversations/${id}/toggle_status`, { status });
    return true;
  } catch (e: any) {
    console.warn(`[chatwoot] setConversationStatus fail:`, e?.response?.data || e.message);
    return false;
  }
}
