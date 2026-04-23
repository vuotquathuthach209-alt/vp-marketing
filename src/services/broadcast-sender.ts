/**
 * Broadcast Sender — gửi campaign tới audience members.
 *
 * Supports:
 *   - Zalo ZNS (template_id required, bypass 48h window)
 *   - FB Message (text message, 24h window rule apply)
 *
 * Tracks per-recipient status (sent/delivered/failed).
 * Rate-limit Zalo ZNS: 500/ngày/OA default.
 */

import { db } from '../db';
import { getAudienceMembers } from './marketing-audience-engine';

const ZALO_ZNS_DAILY_LIMIT = 500;

export interface SendCampaignResult {
  campaign_id: number;
  target_count: number;
  sent: number;
  failed: number;
  skipped: number;
  errors: string[];
  duration_ms: number;
}

/** Run 1 broadcast campaign. */
export async function sendCampaign(campaignId: number, opts: { dryRun?: boolean } = {}): Promise<SendCampaignResult> {
  const t0 = Date.now();
  const result: SendCampaignResult = {
    campaign_id: campaignId,
    target_count: 0, sent: 0, failed: 0, skipped: 0,
    errors: [],
    duration_ms: 0,
  };

  const campaign = db.prepare(`SELECT * FROM broadcast_campaigns WHERE id = ?`).get(campaignId) as any;
  if (!campaign) {
    result.errors.push('campaign not found');
    return result;
  }

  if (campaign.status === 'sent' || campaign.status === 'sending') {
    result.errors.push(`campaign status = ${campaign.status}, cannot send again`);
    return result;
  }

  // Load audience members
  const members = getAudienceMembers(campaign.audience_id, 10_000);
  result.target_count = members.length;

  if (members.length === 0) {
    result.errors.push('audience empty');
    db.prepare(`UPDATE broadcast_campaigns SET status='failed', error_summary=?, updated_at=? WHERE id=?`)
      .run('audience empty', Date.now(), campaignId);
    return result;
  }

  // Mark as sending
  if (!opts.dryRun) {
    db.prepare(
      `UPDATE broadcast_campaigns SET status='sending', started_at=?, target_count=?, updated_at=? WHERE id=?`
    ).run(Date.now(), members.length, Date.now(), campaignId);
  }

  // Load channel sender
  let sendFn: ((member: any) => Promise<{ ok: boolean; provider_msg_id?: string; error?: string }>) | null = null;

  if (campaign.channel === 'zalo_zns') {
    const { zaloSendZNS, getZaloOAs } = require('./zalo');
    const oas = getZaloOAs ? getZaloOAs() : [];
    const oa = oas[0];  // Use first active OA (can scope per-hotel later)
    if (!oa) {
      result.errors.push('no active Zalo OA');
      return result;
    }

    const templateParams = JSON.parse(campaign.template_params || '{}');
    sendFn = async (member: any) => {
      if (!member.customer_phone) return { ok: false, error: 'no_phone' };
      try {
        const data = { ...templateParams };
        // Substitute {{name}}, {{phone}} from member
        if (member.customer_name) data.name = member.customer_name;
        if (member.customer_phone) data.phone = member.customer_phone;

        const r = await zaloSendZNS(oa, member.customer_phone, campaign.template_id, data, { trackingId: `camp_${campaignId}_${member.id}` });
        return { ok: true, provider_msg_id: r?.data?.tracking_id || String(Date.now()) };
      } catch (e: any) {
        return { ok: false, error: e?.message || 'unknown' };
      }
    };
  } else if (campaign.channel === 'fb_message') {
    sendFn = async (member: any) => {
      if (!member.sender_id) return { ok: false, error: 'no_sender_id' };
      try {
        const { sendFBMessage } = require('./facebook');
        const page = db.prepare(`SELECT fb_page_id, access_token FROM pages WHERE hotel_id = ? ORDER BY id LIMIT 1`).get(member.hotel_id || 1) as any;
        if (!page) return { ok: false, error: 'no_fb_page' };
        const msg = fillTemplate(campaign.message_content, member);
        await sendFBMessage(page.access_token, member.sender_id, msg);
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e?.message || 'unknown' };
      }
    };
  } else {
    result.errors.push(`unsupported channel: ${campaign.channel}`);
    return result;
  }

  // Pre-insert broadcast_sends (queued)
  const insertSendStmt = db.prepare(
    `INSERT INTO broadcast_sends (campaign_id, sender_id, customer_phone, customer_name, channel, status)
     VALUES (?, ?, ?, ?, ?, 'queued')`
  );
  const updateSendStmt = db.prepare(
    `UPDATE broadcast_sends SET status=?, sent_at=?, provider_msg_id=?, error=? WHERE id=?`
  );

  for (const m of members) {
    if (opts.dryRun) {
      console.log(`[broadcast] DRY: would send to ${m.customer_phone || m.sender_id}`);
      result.sent++;
      continue;
    }

    // Daily limit check (Zalo ZNS)
    if (campaign.channel === 'zalo_zns' && result.sent >= ZALO_ZNS_DAILY_LIMIT) {
      result.skipped++;
      continue;
    }

    const sendRow = insertSendStmt.run(
      campaignId, m.sender_id || null, m.customer_phone || null, m.customer_name || null, campaign.channel,
    );
    const sendId = Number(sendRow.lastInsertRowid);

    try {
      const res = await sendFn!(m);
      if (res.ok) {
        updateSendStmt.run('sent', Date.now(), res.provider_msg_id || null, null, sendId);
        result.sent++;
      } else {
        updateSendStmt.run('failed', Date.now(), null, res.error || 'unknown', sendId);
        result.failed++;
        if (result.errors.length < 10) result.errors.push(res.error || 'unknown');
      }
    } catch (e: any) {
      updateSendStmt.run('failed', Date.now(), null, e?.message || 'unknown', sendId);
      result.failed++;
    }

    // Gentle rate: 200ms between sends to avoid burst
    await new Promise(r => setTimeout(r, 200));
  }

  // Update campaign
  if (!opts.dryRun) {
    const finalStatus = result.failed === members.length ? 'failed' : 'sent';
    db.prepare(
      `UPDATE broadcast_campaigns
       SET status=?, completed_at=?, sent_count=?, delivered_count=?, error_summary=?, updated_at=?
       WHERE id=?`
    ).run(
      finalStatus, Date.now(), result.sent, result.sent, // assume delivered = sent (ZNS doesn't callback)
      result.errors.length ? result.errors.slice(0, 3).join(' | ') : null,
      Date.now(), campaignId,
    );
  }

  result.duration_ms = Date.now() - t0;
  console.log(`[broadcast] Campaign #${campaignId}: sent=${result.sent} failed=${result.failed} duration=${result.duration_ms}ms`);
  return result;
}

function fillTemplate(template: string, member: any): string {
  if (!template) return '';
  return template
    .replace(/\{\{name\}\}/g, member.customer_name || 'quý khách')
    .replace(/\{\{phone\}\}/g, member.customer_phone || '')
    .replace(/\{\{sender_id\}\}/g, member.sender_id || '');
}

/** Cron: send scheduled campaigns due now. */
export async function sendDueCampaigns(): Promise<{ processed: number }> {
  const now = Date.now();
  const due = db.prepare(
    `SELECT id FROM broadcast_campaigns
     WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?
     ORDER BY scheduled_at ASC LIMIT 5`
  ).all(now) as any[];

  let processed = 0;
  for (const row of due) {
    await sendCampaign(row.id);
    processed++;
  }
  if (processed > 0) console.log(`[broadcast-cron] processed ${processed} campaigns`);
  return { processed };
}

/** Track conversion — sau khi 1 customer book sau campaign send. */
export function recordConversion(opts: {
  sender_id?: string;
  customer_phone?: string;
  booking_id: number;
}): number {
  // Find broadcast_sends trong 7 ngày qua matching sender/phone → mark converted
  const cutoff = Date.now() - 7 * 24 * 3600_000;
  const matches = db.prepare(
    `SELECT bs.id, bs.campaign_id FROM broadcast_sends bs
     WHERE (bs.sender_id = ? OR bs.customer_phone = ?)
       AND bs.status IN ('sent', 'delivered', 'opened', 'clicked')
       AND bs.sent_at > ?
     ORDER BY bs.sent_at DESC LIMIT 5`
  ).all(opts.sender_id || '', opts.customer_phone || '', cutoff) as any[];

  let updated = 0;
  const campaignIds = new Set<number>();
  for (const m of matches) {
    db.prepare(
      `UPDATE broadcast_sends SET status='converted', converted_at=?, converted_booking_id=? WHERE id=?`
    ).run(Date.now(), opts.booking_id, m.id);
    campaignIds.add(m.campaign_id);
    updated++;
  }

  // Bump campaign counters
  for (const cid of campaignIds) {
    db.prepare(`UPDATE broadcast_campaigns SET converted_count = converted_count + 1 WHERE id = ?`).run(cid);
  }

  return updated;
}
