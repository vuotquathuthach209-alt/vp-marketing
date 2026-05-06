/**
 * Sonder email automation — producers + workers.
 *
 * Triggers (3 templates):
 *   1. Welcome (T+0 booking confirm)
 *   2. Review request (T+24h checkout)
 *   3. Loyalty re-engage (T+30d if no rebook)
 *
 * Reference: skills sonder-tech-sovereignty + sonder-storytelling
 *   (Listmonk for delivery, Resend for SMTP backend, BullMQ orchestration)
 */

import { Worker, Job } from 'bullmq';
import { db } from '../../db';
import { getEmailQueue, getRedisConnection } from '../queue';
import { isListmonkEnabled, upsertSubscriber, sendTransactional } from '../listmonk-client';

/* ───────── Job types ───────── */

export type EmailJobName = 'welcome' | 'review_request' | 'loyalty_reengage';

export interface EmailJobData {
  guest_email: string;
  guest_name: string;
  guest_first_name: string;
  booking_id: string | number;
  hotel_id: number;
  checkout_date?: string;       // ISO date
  voucher_code?: string;        // for loyalty_reengage
  attribs?: Record<string, any>;
}

const TEMPLATE_IDS: Record<EmailJobName, number> = {
  welcome: parseInt(process.env.LISTMONK_TPL_WELCOME || '4', 10),
  review_request: parseInt(process.env.LISTMONK_TPL_REVIEW || '5', 10),
  loyalty_reengage: parseInt(process.env.LISTMONK_TPL_LOYALTY || '6', 10),
};

const SONDER_LIST_ID = parseInt(process.env.LISTMONK_SONDER_LIST_ID || '1', 10);

/* ───────── Idempotency ───────── */

function isAlreadySent(bookingId: string | number, jobName: EmailJobName): boolean {
  const r = db.prepare(
    `SELECT id FROM email_automation_log
     WHERE booking_id = ? AND job_name = ? AND status = 'sent'`,
  ).get(String(bookingId), jobName);
  return !!r;
}

function logEmailSent(opts: {
  booking_id: string | number;
  guest_email: string;
  job_name: EmailJobName;
  status: 'sent' | 'failed' | 'skipped';
  error?: string;
}) {
  db.prepare(
    `INSERT INTO email_automation_log
     (booking_id, guest_email, job_name, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    String(opts.booking_id), opts.guest_email, opts.job_name,
    opts.status, opts.error || null, Date.now(),
  );
}

/* ───────── Producers (called from cron / webhook) ───────── */

/** Schedule welcome email — sent immediately after booking confirm */
export async function scheduleWelcomeEmail(data: EmailJobData): Promise<boolean> {
  const q = getEmailQueue();
  if (!q) return false;
  if (isAlreadySent(data.booking_id, 'welcome')) return false;
  await q.add('welcome', data, {
    jobId: `welcome-${data.booking_id}`,
    delay: 0,
  });
  return true;
}

/** Schedule review request — 24h after checkout date */
export async function scheduleReviewRequest(data: EmailJobData): Promise<boolean> {
  const q = getEmailQueue();
  if (!q) return false;
  if (isAlreadySent(data.booking_id, 'review_request')) return false;

  // Calculate delay until 24h after checkout
  let delayMs = 0;
  if (data.checkout_date) {
    const checkoutTs = new Date(data.checkout_date).getTime();
    const target = checkoutTs + 24 * 3600 * 1000;
    delayMs = Math.max(0, target - Date.now());
  }

  await q.add('review_request', data, {
    jobId: `review-${data.booking_id}`,
    delay: delayMs,
  });
  return true;
}

/** Schedule loyalty re-engage — 30d after checkout if no rebook */
export async function scheduleLoyaltyReengage(data: EmailJobData): Promise<boolean> {
  const q = getEmailQueue();
  if (!q) return false;
  if (isAlreadySent(data.booking_id, 'loyalty_reengage')) return false;

  let delayMs = 0;
  if (data.checkout_date) {
    const checkoutTs = new Date(data.checkout_date).getTime();
    const target = checkoutTs + 30 * 24 * 3600 * 1000;
    delayMs = Math.max(0, target - Date.now());
  }

  await q.add('loyalty_reengage', data, {
    jobId: `loyalty-${data.booking_id}`,
    delay: delayMs,
  });
  return true;
}

/* ───────── Worker (consumes jobs) ───────── */

let worker: Worker | null = null;

export function startEmailWorker(): Worker | null {
  if (worker) return worker;
  const conn = getRedisConnection();
  if (!conn) {
    console.warn('[email-worker] Redis not available — worker not started');
    return null;
  }
  if (!isListmonkEnabled()) {
    console.warn('[email-worker] Listmonk not configured — worker disabled');
    return null;
  }

  const w: Worker = new Worker(
    'sonder-email-automation',
    async (job: Job) => {
      const data = job.data;
      const jobName = job.name as EmailJobName;

      // Re-check idempotency at execution time
      if (isAlreadySent(data.booking_id, jobName)) {
        return;
      }

      try {
        // 1. Upsert subscriber
        const subId = await upsertSubscriber({
          email: data.guest_email,
          name: data.guest_name,
          list_ids: [SONDER_LIST_ID],
          attribs: {
            first_name: data.guest_first_name,
            booking_id: data.booking_id,
            voucher_code: data.voucher_code || null,
            ...(data.attribs || {}),
          },
        });
        if (!subId) {
          throw new Error('upsertSubscriber returned null');
        }

        // 2. Send via Listmonk transactional API
        const ok = await sendTransactional({
          subscriber_email: data.guest_email,
          template_id: TEMPLATE_IDS[jobName],
          data: {
            FirstName: data.guest_first_name,
            BookingId: data.booking_id,
            VoucherCode: data.voucher_code || 'WELCOME-BACK',
            ...(data.attribs || {}),
          },
        });

        if (ok) {
          logEmailSent({
            booking_id: data.booking_id,
            guest_email: data.guest_email,
            job_name: jobName,
            status: 'sent',
          });
          console.log(`[email-worker] ${jobName} sent to ${data.guest_email} (booking ${data.booking_id})`);
        } else {
          throw new Error('Listmonk sendTransactional returned false');
        }
      } catch (e: any) {
        logEmailSent({
          booking_id: data.booking_id,
          guest_email: data.guest_email,
          job_name: jobName,
          status: 'failed',
          error: e?.message || String(e),
        });
        throw e;  // Let BullMQ retry
      }
    },
    {
      connection: conn,
      concurrency: 5,
      lockDuration: 60000,
    },
  );

  w.on('completed', (job) => {
    console.log(`[email-worker] job ${job.id} (${job.name}) completed`);
  });
  w.on('failed', (job, err) => {
    console.warn(`[email-worker] job ${job?.id} (${job?.name}) failed:`, err.message);
  });

  worker = w;
  console.log('[email-worker] started, listening on queue sonder-email-automation');
  return worker;
}

export async function stopEmailWorker() {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
