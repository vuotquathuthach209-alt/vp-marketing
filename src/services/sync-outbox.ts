/**
 * Sync Outbox — queue các operation MKT → OTA với retry + DLQ.
 *
 * Pattern: Transactional Outbox.
 *   1. Khi app logic tạo event cần push (VD booking confirmed), nó INSERT
 *      vào sync_outbox trong CÙNG transaction với business data.
 *   2. Outbox worker (cron) poll sync_outbox → gọi OTA HTTP API.
 *   3. Success → mark `pushed`. Fail → exponential backoff retry.
 *   4. Quá 5 lần fail → mark `dlq` + Telegram alert.
 *
 * Idempotency: mỗi op có UUID idempotency_key. OTA phải honor key → retry
 *              cùng key không tạo duplicate.
 *
 * API:
 *   enqueueOutbox(op)     — business code gọi để push op mới
 *   processOutbox(limit)  — worker poll + process
 *   getOutboxStats()      — dashboard
 *   retryDlq(id)          — admin manual retry
 */

import crypto from 'crypto';
import { db } from '../db';
import { logEvent } from './sync-hub';

export type OutboxOpType =
  | 'push_booking'         // Booking MKT bot chốt → OTA PMS
  | 'cancel_booking'       // Booking bị hủy từ phía MKT → OTA
  | 'update_customer'      // Customer profile updated ở MKT → OTA
  | 'push_review'          // Review/feedback từ bot → OTA
  | 'update_availability'; // MKT knows about cancellation → OTA sync inventory

export type OutboxStatus = 'pending' | 'in_flight' | 'pushed' | 'failed' | 'dlq';

export interface OutboxEnqueueInput {
  op_type: OutboxOpType;
  hotel_id?: number;
  aggregate_id?: string;         // e.g. booking.id
  payload: any;                  // object → JSON stringified
  idempotency_key?: string;      // auto-generated nếu không truyền
}

/* ═══════════════════════════════════════════
   ENQUEUE
   ═══════════════════════════════════════════ */

/**
 * Enqueue a new outbox op. MUST be called inside business transaction
 * if you want true outbox semantics.
 *
 * @returns outbox_id
 */
export function enqueueOutbox(input: OutboxEnqueueInput): number {
  const key = input.idempotency_key || crypto.randomUUID();
  const now = Date.now();
  const payloadJson = JSON.stringify(input.payload).slice(0, 50_000);

  try {
    const r = db.prepare(
      `INSERT INTO sync_outbox
       (idempotency_key, op_type, hotel_id, aggregate_id, payload_json,
        status, attempts, next_retry_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`
    ).run(
      key,
      input.op_type,
      input.hotel_id || null,
      input.aggregate_id || null,
      payloadJson,
      now,                       // next_retry_at = now (try immediately)
      now,
      now,
    );
    const id = Number(r.lastInsertRowid);
    console.log(`[outbox] enqueued #${id} op=${input.op_type} key=${key.slice(0, 8)}`);
    return id;
  } catch (e: any) {
    // UNIQUE constraint → đã enqueue rồi (idempotency win)
    if (String(e?.message || '').includes('UNIQUE')) {
      const existing = db.prepare(`SELECT id FROM sync_outbox WHERE idempotency_key = ?`).get(key) as any;
      return existing?.id || 0;
    }
    throw e;
  }
}

/* ═══════════════════════════════════════════
   WORKER
   ═══════════════════════════════════════════ */

// Exponential backoff schedule (ms): 10s, 30s, 2min, 10min, 1h
const BACKOFF_MS = [10_000, 30_000, 120_000, 600_000, 3_600_000];
const MAX_ATTEMPTS = 5;

export interface ProcessResult {
  processed: number;
  succeeded: number;
  failed: number;
  moved_to_dlq: number;
}

/**
 * Process a batch of pending outbox items.
 *
 * Call from cron (every 10s) or manually via API.
 */
export async function processOutbox(limit: number = 20): Promise<ProcessResult> {
  const now = Date.now();

  // 1. Claim pending items atomically (prevent double-processing nếu có 2 workers)
  const claimed = db.prepare(
    `UPDATE sync_outbox
     SET status = 'in_flight', updated_at = ?
     WHERE id IN (
       SELECT id FROM sync_outbox
       WHERE status IN ('pending', 'failed')
         AND next_retry_at <= ?
         AND attempts < ?
       ORDER BY next_retry_at ASC
       LIMIT ?
     )
     RETURNING *`
  ).all(now, now, MAX_ATTEMPTS, limit) as any[];

  const result: ProcessResult = {
    processed: claimed.length,
    succeeded: 0,
    failed: 0,
    moved_to_dlq: 0,
  };

  for (const item of claimed) {
    try {
      const payload = JSON.parse(item.payload_json || '{}');
      const response = await pushToOta(item.op_type, item.idempotency_key, payload);

      // Success
      db.prepare(
        `UPDATE sync_outbox
         SET status = 'pushed',
             ota_response_json = ?,
             ota_ref = ?,
             pushed_at = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(
        JSON.stringify(response).slice(0, 10_000),
        response?.ota_ref || response?.id || null,
        Date.now(),
        Date.now(),
        item.id,
      );

      logEvent({
        event_type: 'outbox_pushed',
        direction: 'outbound',
        actor: 'outbox-worker',
        hotel_id: item.hotel_id,
        payload: { outbox_id: item.id, op: item.op_type, key: item.idempotency_key },
        http_status: 200,
        duration_ms: 0,
      });
      result.succeeded++;
    } catch (e: any) {
      const attempts = (item.attempts || 0) + 1;
      const isDead = attempts >= MAX_ATTEMPTS;
      const nextRetry = isDead ? 0 : Date.now() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];

      db.prepare(
        `UPDATE sync_outbox
         SET status = ?,
             attempts = ?,
             last_error = ?,
             next_retry_at = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(
        isDead ? 'dlq' : 'failed',
        attempts,
        String(e?.message || 'unknown').slice(0, 500),
        nextRetry,
        Date.now(),
        item.id,
      );

      console.warn(`[outbox] #${item.id} op=${item.op_type} attempt=${attempts} ${isDead ? 'DLQ' : 'retry'}: ${e?.message}`);

      if (isDead) {
        result.moved_to_dlq++;
        // Alert on DLQ
        try {
          const { notifyAll } = require('./telegram');
          notifyAll(`🚨 *Outbox DLQ* — op=${item.op_type} id=${item.id}\nError: ${e?.message}\nKey: ${item.idempotency_key}`).catch(() => {});
        } catch {}
      } else {
        result.failed++;
      }

      logEvent({
        event_type: 'outbox_failed',
        direction: 'outbound',
        actor: 'outbox-worker',
        hotel_id: item.hotel_id,
        payload: { outbox_id: item.id, op: item.op_type, attempts },
        error: e?.message,
      });
    }
  }

  if (result.processed > 0) {
    console.log(`[outbox] batch: processed=${result.processed} succeeded=${result.succeeded} failed=${result.failed} dlq=${result.moved_to_dlq}`);
  }
  return result;
}

/* ═══════════════════════════════════════════
   OTA HTTP CLIENT (placeholder — wire to real API)
   ═══════════════════════════════════════════ */

/**
 * Push op to OTA via HTTP. Raises on non-2xx.
 *
 * NOTE: OTA team cần expose HTTP endpoints tương ứng:
 *   POST /api/pms/bookings              (op='push_booking')
 *   DELETE /api/pms/bookings/:id        (op='cancel_booking')
 *   PATCH /api/pms/customers/:phone     (op='update_customer')
 *   POST /api/pms/reviews               (op='push_review')
 *   PATCH /api/pms/availability         (op='update_availability')
 *
 * Tất cả endpoints cần support header `X-Idempotency-Key` để dedup.
 */
async function pushToOta(
  opType: OutboxOpType,
  idempotencyKey: string,
  payload: any,
): Promise<any> {
  const { getSetting } = require('../db');
  const apiBase = getSetting('ota_pms_api_base') || process.env.OTA_PMS_API_BASE;
  const apiSecret = getSetting('ota_pms_api_secret') || process.env.OTA_PMS_API_SECRET;

  if (!apiBase || !apiSecret) {
    // v24: degrade gracefully — nếu chưa setup, giữ ở pending chứ không DLQ
    throw new Error('OTA PMS API not configured yet (set ota_pms_api_base + ota_pms_api_secret in settings)');
  }

  // Map op → endpoint
  const routes: Record<OutboxOpType, { method: string; path: (p: any) => string }> = {
    push_booking: { method: 'POST', path: () => '/api/pms/bookings' },
    cancel_booking: { method: 'DELETE', path: (p) => `/api/pms/bookings/${encodeURIComponent(p.pms_booking_id || p.aggregate_id)}` },
    update_customer: { method: 'PATCH', path: (p) => `/api/pms/customers/${encodeURIComponent(p.phone)}` },
    push_review: { method: 'POST', path: () => '/api/pms/reviews' },
    update_availability: { method: 'PATCH', path: () => '/api/pms/availability' },
  };

  const route = routes[opType];
  if (!route) throw new Error(`Unknown op_type: ${opType}`);

  const url = `${apiBase.replace(/\/$/, '')}${route.path(payload)}`;

  // HMAC sign body
  const bodyStr = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', apiSecret).update(bodyStr).digest('hex');

  const axios = require('axios').default;
  const https = require('https');
  const t0 = Date.now();
  const resp = await axios.request({
    method: route.method,
    url,
    data: route.method === 'DELETE' ? undefined : payload,
    headers: {
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey,
      'X-Signature': `sha256=${sig}`,
      'User-Agent': 'vp-marketing-outbox/1.0',
    },
    timeout: 20_000,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),   // OTA cert có thể self-signed
  });

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`OTA API ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`);
  }
  return { ...resp.data, _latency_ms: Date.now() - t0, _status: resp.status };
}

/* ═══════════════════════════════════════════
   MANAGEMENT / DASHBOARD
   ═══════════════════════════════════════════ */

export interface OutboxStats {
  pending: number;
  in_flight: number;
  pushed_24h: number;
  failed: number;
  dlq: number;
  oldest_pending_age_sec: number;
  push_success_rate_24h: number;
}

export function getOutboxStats(): OutboxStats {
  const now = Date.now();
  const day = now - 24 * 3600_000;

  const byStatus = db.prepare(
    `SELECT status, COUNT(*) as n FROM sync_outbox GROUP BY status`
  ).all() as any[];
  const m = Object.fromEntries(byStatus.map((r: any) => [r.status, r.n]));

  const pushed24h = (db.prepare(
    `SELECT COUNT(*) as n FROM sync_outbox WHERE status = 'pushed' AND pushed_at > ?`
  ).get(day) as any)?.n || 0;
  const failed24h = (db.prepare(
    `SELECT COUNT(*) as n FROM sync_outbox WHERE status IN ('failed', 'dlq') AND updated_at > ?`
  ).get(day) as any)?.n || 0;

  const oldestPending = db.prepare(
    `SELECT MIN(created_at) as t FROM sync_outbox WHERE status = 'pending'`
  ).get() as any;

  const total24h = pushed24h + failed24h;
  return {
    pending: m.pending || 0,
    in_flight: m.in_flight || 0,
    pushed_24h: pushed24h,
    failed: m.failed || 0,
    dlq: m.dlq || 0,
    oldest_pending_age_sec: oldestPending?.t ? Math.round((now - oldestPending.t) / 1000) : 0,
    push_success_rate_24h: total24h > 0 ? pushed24h / total24h : 1.0,
  };
}

export function listDlq(limit: number = 50): any[] {
  return db.prepare(
    `SELECT * FROM sync_outbox WHERE status = 'dlq' ORDER BY updated_at DESC LIMIT ?`
  ).all(limit) as any[];
}

/** Admin action: reset DLQ item → retry */
export function retryDlq(id: number): boolean {
  const r = db.prepare(
    `UPDATE sync_outbox
     SET status = 'pending', attempts = 0, last_error = NULL, next_retry_at = ?, updated_at = ?
     WHERE id = ? AND status = 'dlq'`
  ).run(Date.now(), Date.now(), id);
  return r.changes > 0;
}

/** Admin action: explicitly mark dead (give up) */
export function closeDlq(id: number, note?: string): boolean {
  const r = db.prepare(
    `UPDATE sync_outbox SET status = 'closed', last_error = COALESCE(?, last_error), updated_at = ? WHERE id = ? AND status = 'dlq'`
  ).run(note || null, Date.now(), id);
  return r.changes > 0;
}
