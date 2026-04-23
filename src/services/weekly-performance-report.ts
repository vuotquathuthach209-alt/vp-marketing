/**
 * Weekly Performance Report — Top/Bottom performers + audience/promo analytics.
 *
 * Aggregate v13 feedback loop data + v15 domain + v16 audiences.
 * Send via Telegram every Sunday.
 */

import { db } from '../db';

export interface WeeklyReport {
  period: { from: string; to: string };
  totals: {
    replies: number;
    conversions: number;
    misunderstood: number;
    ghosted: number;
    conversion_rate: number;
  };
  top_reply_sources: Array<{ reply_source: string; total: number; converted: number; rate: number }>;
  worst_reply_sources: Array<{ reply_source: string; total: number; bad_count: number; bad_rate: number }>;
  stage_dropoff: Array<{ stage: string; entered: number; dropped: number; dropped_pct: number }>;
  active_experiments: Array<{ template_key: string; variants: number; impressions: number; winner?: string }>;
  audience_stats: Array<{ audience_name: string; member_count: number; last_refreshed: string | null }>;
  promo_usage: Array<{ code: string; uses: number; total_discount: number }>;
}

export function generateWeeklyReport(hotelId: number = 1): WeeklyReport {
  const to = Date.now();
  const from = to - 7 * 24 * 3600_000;
  const fromStr = new Date(from).toISOString().slice(0, 10);
  const toStr = new Date(to).toISOString().slice(0, 10);

  // Totals
  const totalsRow = db.prepare(
    `SELECT
       COUNT(*) as replies,
       SUM(CASE WHEN outcome IN ('converted_to_lead','booked','closed_won') THEN 1 ELSE 0 END) as conversions,
       SUM(CASE WHEN outcome = 'misunderstood' THEN 1 ELSE 0 END) as misunderstood,
       SUM(CASE WHEN outcome = 'ghosted' THEN 1 ELSE 0 END) as ghosted
     FROM bot_reply_outcomes
     WHERE hotel_id = ? AND created_at >= ? AND created_at <= ?
       AND outcome != 'pending'`
  ).get(hotelId, from, to) as any;
  const replies = totalsRow.replies || 0;
  const conversionRate = replies > 0 ? (totalsRow.conversions || 0) / replies : 0;

  // Top reply sources by conversion
  const topRows = db.prepare(
    `SELECT reply_source,
            COUNT(*) as total,
            SUM(CASE WHEN outcome IN ('converted_to_lead','booked','closed_won') THEN 1 ELSE 0 END) as converted
     FROM bot_reply_outcomes
     WHERE hotel_id = ? AND created_at >= ? AND created_at <= ?
       AND outcome != 'pending'
     GROUP BY reply_source
     HAVING total >= 3
     ORDER BY (converted * 1.0 / total) DESC
     LIMIT 5`
  ).all(hotelId, from, to) as any[];

  // Worst reply sources (bad = misunderstood + ghosted + rage_quit)
  const worstRows = db.prepare(
    `SELECT reply_source,
            COUNT(*) as total,
            SUM(CASE WHEN outcome IN ('misunderstood','ghosted','rage_quit') THEN 1 ELSE 0 END) as bad_count
     FROM bot_reply_outcomes
     WHERE hotel_id = ? AND created_at >= ? AND created_at <= ?
       AND outcome != 'pending'
     GROUP BY reply_source
     HAVING total >= 3
     ORDER BY (bad_count * 1.0 / total) DESC
     LIMIT 5`
  ).all(hotelId, from, to) as any[];

  // Stage drop-off
  const stageRows = db.prepare(
    `SELECT to_stage as stage,
            COUNT(DISTINCT sender_id) as entered
     FROM funnel_stage_transitions
     WHERE hotel_id = ? AND created_at >= ? AND created_at <= ?
     GROUP BY to_stage
     ORDER BY entered DESC
     LIMIT 8`
  ).all(hotelId, from, to) as any[];

  // For each stage, compute how many did NOT progress to next stage
  const stageDropoff = stageRows.map(s => {
    const progressed = db.prepare(
      `SELECT COUNT(DISTINCT from_stage_senders.sender_id) as n FROM (
         SELECT sender_id FROM funnel_stage_transitions
         WHERE hotel_id = ? AND from_stage = ? AND created_at >= ? AND created_at <= ?
       ) from_stage_senders`
    ).get(hotelId, s.stage, from, to) as any;
    const dropped = s.entered - (progressed?.n || 0);
    return {
      stage: s.stage,
      entered: s.entered,
      dropped,
      dropped_pct: s.entered > 0 ? +(dropped / s.entered).toFixed(3) : 0,
    };
  });

  // Active experiments
  const experiments = db.prepare(
    `SELECT re.template_key,
            COUNT(rt.id) as variants,
            SUM(rt.impressions) as impressions,
            MAX(CASE WHEN rt.is_winner = 1 THEN rt.variant_name END) as winner
     FROM reply_experiments re
     LEFT JOIN reply_templates rt ON rt.template_key = re.template_key AND rt.active = 1
     WHERE re.status IN ('running', 'winner_selected')
     GROUP BY re.template_key`
  ).all() as any[];

  // Audience stats
  const audiences = db.prepare(
    `SELECT audience_name, member_count, last_refreshed_at
     FROM marketing_audiences
     WHERE active = 1
     ORDER BY member_count DESC LIMIT 8`
  ).all() as any[];

  // Promo usage
  const promos = db.prepare(
    `SELECT p.code,
            COUNT(pu.id) as uses,
            COALESCE(SUM(pu.discount_applied_vnd), 0) as total_discount
     FROM promotions p
     LEFT JOIN promotion_usage pu ON pu.promotion_id = p.id AND pu.created_at >= ?
     WHERE p.active = 1
     GROUP BY p.id
     HAVING uses > 0
     ORDER BY uses DESC
     LIMIT 5`
  ).all(from) as any[];

  return {
    period: { from: fromStr, to: toStr },
    totals: {
      replies,
      conversions: totalsRow.conversions || 0,
      misunderstood: totalsRow.misunderstood || 0,
      ghosted: totalsRow.ghosted || 0,
      conversion_rate: +conversionRate.toFixed(4),
    },
    top_reply_sources: topRows.map(r => ({
      reply_source: r.reply_source,
      total: r.total,
      converted: r.converted,
      rate: +(r.converted / r.total).toFixed(3),
    })),
    worst_reply_sources: worstRows.map(r => ({
      reply_source: r.reply_source,
      total: r.total,
      bad_count: r.bad_count,
      bad_rate: +(r.bad_count / r.total).toFixed(3),
    })),
    stage_dropoff: stageDropoff,
    active_experiments: experiments.map(e => ({
      template_key: e.template_key,
      variants: e.variants || 0,
      impressions: e.impressions || 0,
      winner: e.winner || undefined,
    })),
    audience_stats: audiences.map(a => ({
      audience_name: a.audience_name,
      member_count: a.member_count || 0,
      last_refreshed: a.last_refreshed_at ? new Date(a.last_refreshed_at).toISOString() : null,
    })),
    promo_usage: promos.map(p => ({
      code: p.code,
      uses: p.uses,
      total_discount: p.total_discount,
    })),
  };
}

/** Format report as Telegram message. */
export function formatReportForTelegram(report: WeeklyReport): string {
  const lines: string[] = [];
  lines.push(`📊 *VP MKT Weekly Report*`);
  lines.push(`📅 ${report.period.from} → ${report.period.to}\n`);

  // Totals
  lines.push(`*Totals:*`);
  lines.push(`  Replies: ${report.totals.replies}`);
  lines.push(`  Conversions: ${report.totals.conversions} (${(report.totals.conversion_rate * 100).toFixed(1)}%)`);
  lines.push(`  Misunderstood: ${report.totals.misunderstood}`);
  lines.push(`  Ghosted: ${report.totals.ghosted}\n`);

  // Top
  if (report.top_reply_sources.length > 0) {
    lines.push(`🏆 *Top 5 performers:*`);
    report.top_reply_sources.forEach((r, i) => {
      lines.push(`  ${i + 1}. \`${r.reply_source}\` — ${(r.rate * 100).toFixed(0)}% (${r.converted}/${r.total})`);
    });
    lines.push('');
  }

  // Worst
  if (report.worst_reply_sources.length > 0) {
    lines.push(`⚠️ *Cần cải thiện:*`);
    report.worst_reply_sources.forEach((r, i) => {
      lines.push(`  ${i + 1}. \`${r.reply_source}\` — ${(r.bad_rate * 100).toFixed(0)}% bad (${r.bad_count}/${r.total})`);
    });
    lines.push('');
  }

  // Stage dropoff
  if (report.stage_dropoff.length > 0) {
    lines.push(`📉 *Funnel drop-off:*`);
    report.stage_dropoff.slice(0, 5).forEach(s => {
      lines.push(`  ${s.stage}: ${s.entered} entered, ${(s.dropped_pct * 100).toFixed(0)}% dropped`);
    });
    lines.push('');
  }

  // Experiments
  if (report.active_experiments.length > 0) {
    lines.push(`🧪 *A/B tests:*`);
    report.active_experiments.forEach(e => {
      const status = e.winner ? `✅ winner=${e.winner}` : `running (${e.variants} variants)`;
      lines.push(`  \`${e.template_key}\` — ${e.impressions} imps, ${status}`);
    });
    lines.push('');
  }

  // Audience
  if (report.audience_stats.length > 0) {
    lines.push(`🎯 *Audiences:*`);
    report.audience_stats.slice(0, 5).forEach(a => {
      lines.push(`  \`${a.audience_name}\` — ${a.member_count} members`);
    });
    lines.push('');
  }

  // Promos
  if (report.promo_usage.length > 0) {
    lines.push(`🎁 *Promo used:*`);
    report.promo_usage.forEach(p => {
      lines.push(`  ${p.code}: ${p.uses}× (${(p.total_discount / 1000).toFixed(0)}k total discount)`);
    });
  }

  return lines.join('\n');
}

/** Send weekly report via Telegram. */
export async function sendWeeklyPerformanceReport(hotelId: number = 1): Promise<void> {
  try {
    const report = generateWeeklyReport(hotelId);
    const formatted = formatReportForTelegram(report);
    const { notifyAll } = require('./telegram');
    await notifyAll(formatted);
    console.log('[weekly-report] sent');
  } catch (e: any) {
    console.warn('[weekly-report] fail:', e?.message);
  }
}
