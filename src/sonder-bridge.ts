// @ts-nocheck
// sonder-bridge.ts — bot-mkt's bridge to the Sonder ecosystem (HTTP-only).
//
// This skeleton ships at /opt/vp-marketing/src/sonder-bridge.ts via the
// Sprint J activation deploy. Bot-mkt opts in by adding
// `import { pushLead } from './sonder-bridge'` where lead capture happens.
//
// REVISED ARCHITECTURE (26/04/2026 — Sprint J Phase 3):
//   Originally: bot-mkt → Postgres direct via bot_mkt_ro role + pgbouncer
//   Now:        bot-mkt → HTTPS API (sondervn.com /api/v1/bot-context/*)
//
// Why? BizFly Postgres is bound to localhost only + UFW blocks 5432/6432
// + pgbouncer not running. Direct DB connection from bot-mkt machine
// (103.82.193.74) is blocked at 3 layers — and reasonably so for security.
//
// HTTPS API approach instead:
//   - Read:  GET https://sondervn.com/api/v1/bot-context/hotel/:id
//            GET https://sondervn.com/api/v1/bot-sync
//            Auth: Bearer BOT_API_SECRET (already configured)
//   - Write: POST https://pms.sondervn.com/api/inbound/marketing-event
//            Auth: HMAC X-Mkt-Signature with MKT_API_SECRET (Phase 2)
//
// Both go over public internet HTTPS — signed with HMAC. Same security
// model as PMS↔Bot interactions. Zero new firewall/VPN/replica needed.
//
// Dependencies (already installed at /opt/vp-marketing/node_modules/@sonder/*):
//   - @sonder/contracts      (Zod schemas, V1)
//   - @sonder/shared-utils   (HMAC sign + makeIdempotencyKey)
//
// Env required (set by activation deploy):
//   - PMS_INBOUND_URL          (https://pms.sondervn.com)
//   - MKT_API_SECRET           (HMAC shared secret with PMS — Phase 2)
//   - OTA_BOT_CONTEXT_URL      (https://sondervn.com)
//   - BOT_API_SECRET           (Bearer token to call OTA bot-context API)

// @ts-ignore — bot-mkt has its own tsconfig; @sonder packages are CJS dist
import { sign, makeIdempotencyKey } from '@sonder/shared-utils';
// @ts-ignore
import {
  MarketingEventV1, MktLeadV1,
  HotelContextV1Schema, HotelListRowV1Schema,
} from '@sonder/contracts';

// ── Outbound: lead.captured → PMS ───────────────────────────────────
export interface CaptureLeadInput {
  source_channel: 'facebook' | 'zalo' | 'tiktok' | 'instagram' | 'email' | 'web' | 'other';
  source_id: string;
  guest_name?: string;
  guest_phone?: string;
  guest_email?: string;
  intent?: 'inquiry' | 'booking_intent' | 'complaint' | 'review' | 'subscribe' | 'other';
  hotel_id?: number;
  message_excerpt?: string;
  conversation_url?: string;
}

/** Push a captured lead to PMS. Fire-and-forget — does NOT throw to caller.
 *  All errors logged via console.warn. */
export async function pushLead(input: CaptureLeadInput): Promise<void> {
  try {
    const SECRET = process.env.MKT_API_SECRET;
    const URL = process.env.PMS_INBOUND_URL || 'https://pms.sondervn.com';
    if (!SECRET) {
      console.warn('[sonder-bridge] MKT_API_SECRET not set — skip pushLead');
      return;
    }

    const lead = MktLeadV1.parse({
      source_channel: input.source_channel,
      source_id: input.source_id,
      guest_name: input.guest_name || '',
      guest_phone: input.guest_phone || '',
      guest_email: input.guest_email || '',
      intent: input.intent || 'inquiry',
      hotel_id: input.hotel_id,
      message_excerpt: input.message_excerpt || '',
      conversation_url: input.conversation_url,
      captured_at: new Date().toISOString(),
    });

    const envelope = MarketingEventV1.parse({
      envelope: {
        source: 'bot-mkt',
        type: 'lead.captured',
        idempotency_key: makeIdempotencyKey('lead'),
        emitted_at: new Date().toISOString(),
        contract_version: 'v1',
      },
      kind: 'lead.captured',
      payload: lead,
    });

    const body = JSON.stringify(envelope);
    const sig = sign(body, SECRET);

    const r = await fetch(`${URL}/api/inbound/marketing-event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mkt-Signature': sig,
        'X-Sonder-Source': 'bot-mkt',
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      console.warn(`[sonder-bridge] pushLead rejected by PMS: HTTP ${r.status} ${err.slice(0, 200)}`);
      return;
    }
    const result = await r.json().catch(() => ({}));
    if (!result.success) {
      console.warn('[sonder-bridge] pushLead non-success:', result);
    }
  } catch (e: any) {
    console.warn('[sonder-bridge] pushLead error:', e?.message || e);
  }
}

// ── Inbound: read hotel context via OTA HTTPS API ───────────────────
function getOtaUrl(): string {
  return process.env.OTA_BOT_CONTEXT_URL || 'https://sondervn.com';
}

function getBotAuth(): string {
  const t = process.env.BOT_API_SECRET;
  if (!t) throw new Error('BOT_API_SECRET not set — bot-mkt cannot call OTA API');
  return `Bearer ${t}`;
}

/** Fetch full hotel context (name, pricing, amenities, …) by hotel id.
 *  Returns null if hotel not found or HTTP error. Throws only on env mis-config. */
export async function readHotelContext(hotelId: number): Promise<unknown | null> {
  try {
    const r = await fetch(`${getOtaUrl()}/api/v1/bot-context/hotel/${hotelId}`, {
      headers: { Authorization: getBotAuth(), Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (r.status === 404) return null;
    if (!r.ok) {
      console.warn(`[sonder-bridge] readHotelContext HTTP ${r.status}`);
      return null;
    }
    const json = await r.json();
    // Validate at the boundary (catch DB schema drift early)
    const parsed = HotelContextV1Schema.safeParse(json.data);
    if (!parsed.success) {
      console.warn('[sonder-bridge] readHotelContext: schema mismatch — API drift?', parsed.error.errors.slice(0, 3));
      return json.data; // return anyway, but log
    }
    return parsed.data;
  } catch (e: any) {
    console.warn('[sonder-bridge] readHotelContext error:', e?.message || e);
    return null;
  }
}

/** List active hotels by city (for content campaign targeting). */
export async function readHotelsByCity(city: string): Promise<unknown[]> {
  try {
    const params = new URLSearchParams({ city, status: 'active' });
    const r = await fetch(`${getOtaUrl()}/api/v1/bot-sync?${params}`, {
      headers: { Authorization: getBotAuth(), Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      console.warn(`[sonder-bridge] readHotelsByCity HTTP ${r.status}`);
      return [];
    }
    const json = await r.json();
    return Array.isArray(json.data) ? json.data : [];
  } catch (e: any) {
    console.warn('[sonder-bridge] readHotelsByCity error:', e?.message || e);
    return [];
  }
}

/** Cleanup hook — no-op now (no DB pool to close). Kept for API stability. */
export async function shutdown(): Promise<void> {
  // Nothing to cleanup with HTTP-only architecture
}
