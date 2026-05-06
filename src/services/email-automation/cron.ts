/**
 * Email automation cron — polls OTA DB for booking events and schedules emails.
 *
 * Schedule (in scheduler.ts):
 *   Every 15 min: scan recent bookings → schedule welcome / review / loyalty
 *
 * Idempotency: email_automation_log (booking_id + job_name unique guard)
 */

import { db } from '../../db';
import { otaQuery } from '../ota-db';
import { scheduleWelcomeEmail, scheduleReviewRequest, scheduleLoyaltyReengage } from './index';

interface OtaBookingEmailable {
  id: number;
  booking_code: string;
  hotel_id: number;
  guest_name: string;
  guest_email: string | null;
  guest_first_name: string;
  checkin_date: string;
  checkout_date: string;
  booking_status: string;
  created_at: string;
}

function firstName(fullName: string | null): string {
  if (!fullName) return 'bạn';
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] || 'bạn';
}

function genVoucherCode(bookingId: number): string {
  const code = `S${String(bookingId).slice(-4).padStart(4, '0')}`;
  return `WELCOME-${code}`;
}

/* ───────── Trigger 1: Welcome email (last 30 min new bookings) ───────── */

export async function scanWelcomeCandidates(hotelId = 1): Promise<{ scanned: number; queued: number }> {
  const result = { scanned: 0, queued: 0 };
  try {
    const rows = await otaQuery<OtaBookingEmailable>(
      `SELECT b.id, b.booking_code, b.hotel_id,
              g.full_name as guest_name, g.email as guest_email,
              b.checkin_date::text, b.checkout_date::text,
              b.booking_status, b.created_at::text
       FROM bookings b
       JOIN guests g ON g.id = b.guest_id
       WHERE b.hotel_id = $1
         AND b.deleted_at IS NULL
         AND b.booking_status IN ('CONFIRMED','CHECKED_IN')
         AND b.created_at >= NOW() - INTERVAL '60 minutes'
         AND g.email IS NOT NULL AND g.email != ''
       ORDER BY b.created_at DESC
       LIMIT 100`,
      [hotelId],
    );
    result.scanned = rows.length;

    for (const r of rows) {
      if (!r.guest_email) continue;
      const ok = await scheduleWelcomeEmail({
        guest_email: r.guest_email,
        guest_name: r.guest_name,
        guest_first_name: firstName(r.guest_name),
        booking_id: r.id,
        hotel_id: r.hotel_id,
        checkout_date: r.checkout_date,
        attribs: {
          checkin_date: r.checkin_date,
          checkout_date: r.checkout_date,
          booking_code: r.booking_code,
        },
      });
      if (ok) result.queued++;
    }
  } catch (e: any) {
    console.warn('[email-cron] welcome scan fail:', e?.message);
  }
  return result;
}

/* ───────── Trigger 2: Review request (checked out yesterday) ───────── */

export async function scanReviewCandidates(hotelId = 1): Promise<{ scanned: number; queued: number }> {
  const result = { scanned: 0, queued: 0 };
  try {
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
    const rows = await otaQuery<OtaBookingEmailable>(
      `SELECT b.id, b.booking_code, b.hotel_id,
              g.full_name as guest_name, g.email as guest_email,
              b.checkin_date::text, b.checkout_date::text,
              b.booking_status, b.created_at::text
       FROM bookings b
       JOIN guests g ON g.id = b.guest_id
       WHERE b.hotel_id = $1
         AND b.deleted_at IS NULL
         AND b.checkout_date::date = $2::date
         AND b.booking_status IN ('CHECKED_OUT','CHECKED_IN')
         AND g.email IS NOT NULL AND g.email != ''
       LIMIT 100`,
      [hotelId, yesterday],
    );
    result.scanned = rows.length;

    for (const r of rows) {
      if (!r.guest_email) continue;
      const ok = await scheduleReviewRequest({
        guest_email: r.guest_email,
        guest_name: r.guest_name,
        guest_first_name: firstName(r.guest_name),
        booking_id: r.id,
        hotel_id: r.hotel_id,
        checkout_date: r.checkout_date,
        attribs: { booking_code: r.booking_code },
      });
      if (ok) result.queued++;
    }
  } catch (e: any) {
    console.warn('[email-cron] review scan fail:', e?.message);
  }
  return result;
}

/* ───────── Trigger 3: Loyalty re-engage (30d old, no rebook) ───────── */

export async function scanLoyaltyCandidates(hotelId = 1): Promise<{ scanned: number; queued: number }> {
  const result = { scanned: 0, queued: 0 };
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const rows = await otaQuery<OtaBookingEmailable>(
      `SELECT DISTINCT ON (g.email) b.id, b.booking_code, b.hotel_id,
              g.full_name as guest_name, g.email as guest_email,
              b.checkin_date::text, b.checkout_date::text,
              b.booking_status, b.created_at::text
       FROM bookings b
       JOIN guests g ON g.id = b.guest_id
       WHERE b.hotel_id = $1
         AND b.deleted_at IS NULL
         AND b.checkout_date::date = $2::date
         AND b.booking_status = 'CHECKED_OUT'
         AND g.email IS NOT NULL AND g.email != ''
         AND NOT EXISTS (
           SELECT 1 FROM bookings b2
           WHERE b2.guest_id = g.id
             AND b2.deleted_at IS NULL
             AND b2.created_at::date > b.checkout_date::date
         )
       ORDER BY g.email, b.checkout_date DESC
       LIMIT 100`,
      [hotelId, thirtyDaysAgo],
    );
    result.scanned = rows.length;

    for (const r of rows) {
      if (!r.guest_email) continue;
      const ok = await scheduleLoyaltyReengage({
        guest_email: r.guest_email,
        guest_name: r.guest_name,
        guest_first_name: firstName(r.guest_name),
        booking_id: r.id,
        hotel_id: r.hotel_id,
        checkout_date: r.checkout_date,
        voucher_code: genVoucherCode(r.id),
        attribs: { booking_code: r.booking_code },
      });
      if (ok) result.queued++;
    }
  } catch (e: any) {
    console.warn('[email-cron] loyalty scan fail:', e?.message);
  }
  return result;
}

/* ───────── Main cron entry ───────── */

export async function runEmailAutomationCron(): Promise<void> {
  const enabled = (db.prepare(`SELECT value FROM settings WHERE key = 'email_automation_enabled'`).get() as any)?.value;
  if (enabled === 'false') {
    return;
  }

  const [welcome, review, loyalty] = await Promise.all([
    scanWelcomeCandidates(1),
    scanReviewCandidates(1),
    scanLoyaltyCandidates(1),
  ]);

  if (welcome.queued > 0 || review.queued > 0 || loyalty.queued > 0) {
    console.log(
      `[email-cron] queued: welcome=${welcome.queued}/${welcome.scanned}, ` +
      `review=${review.queued}/${review.scanned}, loyalty=${loyalty.queued}/${loyalty.scanned}`,
    );
  }
}
