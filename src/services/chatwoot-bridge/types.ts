/**
 * Chatwoot bridge — type definitions
 *
 * Architecture:
 *   FB Messenger → vp-marketing webhook (existing) → smartreply (existing)
 *                                                  ↘
 *                                                    chatwoot-bridge (NEW)
 *                                                    mirror to Chatwoot
 *                                                    inbox UI for agents
 *
 * Reference: skill sonder-tech-sovereignty (Chatwoot is locked OSS for omnichannel)
 */

export interface ChatwootContact {
  id: number;
  name: string;
  email?: string;
  phone_number?: string;
  identifier?: string;
}

export interface ChatwootConversation {
  id: number;
  inbox_id: number;
  status: 'open' | 'resolved' | 'pending' | 'snoozed';
  contact_id: number;
  source_id?: string;
}

export interface ChatwootMessage {
  id: number;
  conversation_id: number;
  message_type: 'incoming' | 'outgoing' | 'activity' | 'template';
  content: string;
  private: boolean;
  created_at: number;
  sender?: { id: number; name: string; type: 'contact' | 'user' };
}

export interface BridgeMapping {
  id: number;
  fb_psid: string;
  fb_page_id: string;
  chatwoot_contact_id: number | null;
  chatwoot_conversation_id: number | null;
  chatwoot_inbox_identifier: string;
  status: 'open' | 'resolved' | 'closed';
  last_message_at: number | null;
  created_at: number;
  updated_at: number | null;
}

/** Chatwoot outgoing webhook payload (sent when agent replies) */
export interface ChatwootWebhookPayload {
  event: 'message_created' | 'conversation_updated' | 'conversation_status_changed';
  conversation: {
    id: number;
    status: string;
    inbox_id: number;
    additional_attributes?: Record<string, any>;
    meta?: { sender?: { id: number; name?: string }; channel?: string };
  };
  message_type?: 'incoming' | 'outgoing' | 'activity' | 'template';
  content?: string;
  private?: boolean;
  sender?: { type: 'user' | 'contact' | 'agent_bot'; id: number; name?: string };
  account?: { id: number };
  inbox?: { id: number; name: string };
}
