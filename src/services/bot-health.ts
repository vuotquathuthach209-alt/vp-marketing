/**
 * Bot Self-Monitoring
 *
 * Daily health report: đo chất lượng bot tự động, cảnh báo khi có anomaly.
 *
 * Metrics theo dõi (24h gần nhất):
 *   - Conversion rate: inbox → confirmed
 *   - Rule fallback %: router dùng rule thay vì LLM (cao = LLM issue)
 *   - Low confidence %: < 0.4
 *   - Auto-handoff rate
 *   - Spam blocked
 *   - Avg latency
 *   - Stalled reengagement stats
 *
 * Alerts qua Telegram admin khi:
 *   - Rule fallback > 30% (LLM vấn đề)
 *   - Low confidence > 20%
 *   - Zero conversions > 3 ngày liên tiếp (đã có inbox)
 *
 * Output report daily 8 sáng (để chủ khách sạn đọc).
 */
import { db } from '../db';
import { notifyAdmin } from './telegram';

interface Metric {
  value: number;
  unit?: string;
  status?: 'ok' | 'warn' | 'bad';
}

export interface HealthReport {
  period_hours: number;
  generated_at: number;
  metrics: Record<string, Metric>;
  alerts: string[];
  summary: string;
}

export function computeHealthReport(hoursBack = 24): HealthReport {
  const since = Date.now() - hoursBack * 3600 * 1000;

  // Pull intent events
  const intentRows = db.prepare(
    `SELECT meta FROM events WHERE event_name = 'intent_classified' AND ts >= ?`
  ).all(since) as any[];
  const total = intentRows.length;
  let ruleCount = 0;
  let lowConfCount = 0;
  for (const r of intentRows) {
    try {
      const m = JSON.parse(r.meta || '{}');
      if (m.source === 'rule') ruleCount++;
      if ((Number(m.confidence) || 0) < 0.4) lowConfCount++;
    } catch {}
  }

  // Funnel stats
  const countFunnel = (stage: string) => {
    const row = db.prepare(
      `SELECT COUNT(DISTINCT COALESCE(json_extract(meta, '$.sender_id'), ip)) as n
       FROM events WHERE event_name = ? AND ts >= ?`
    ).get('funnel_' + stage, since) as any;
    return row?.n || 0;
  };

  const inbox = countFunnel('inbox');
  const qualified = countFunnel('qualified');
  const confirmed = countFunnel('confirmed');

  // Handoff + spam
  const handoffCount = db.prepare(
    `SELECT COUNT(*) as n FROM events WHERE event_name = 'auto_handoff_triggered' AND ts >= ?`
  ).get(since) as any;

  const spamCount = db.prepare(
    `SELECT COUNT(*) as n FROM events WHERE event_name = 'spam_blocked' AND ts >= ?`
  ).get(since) as any;

  const reengCount = db.prepare(
    `SELECT COUNT(*) as n FROM events WHERE event_name = 'stalled_reengage_sent' AND ts >= ?`
  ).get(since) as any;

  const metrics: Record<string, Metric> = {
    total_turns: { value: total },
    inbox_senders: { value: inbox },
    qualified: { value: qualified },
    confirmed_bookings: { value: confirmed },
    conversion_rate: {
      value: inbox > 0 ? +((confirmed / inbox) * 100).toFixed(1) : 0,
      unit: '%',
      status: inbox > 0 && confirmed / inbox >= 0.05 ? 'ok' : inbox > 5 ? 'warn' : 'ok',
    },
    rule_fallback_pct: {
      value: total > 0 ? +((ruleCount / total) * 100).toFixed(1) : 0,
      unit: '%',
      status: total > 0 && ruleCount / total > 0.3 ? 'bad' : 'ok',
    },
    low_confidence_pct: {
      value: total > 0 ? +((lowConfCount / total) * 100).toFixed(1) : 0,
      unit: '%',
      status: total > 0 && lowConfCount / total > 0.2 ? 'warn' : 'ok',
    },
    auto_handoffs: { value: handoffCount?.n || 0 },
    spam_blocked: { value: spamCount?.n || 0 },
    stalled_reengagements: { value: reengCount?.n || 0 },
  };

  // Alerts
  const alerts: string[] = [];
  if (metrics.rule_fallback_pct.status === 'bad') {
    alerts.push(`⚠️ Rule fallback ${metrics.rule_fallback_pct.value}% (> 30%). LLM có thể có vấn đề — kiểm tra API keys/quota.`);
  }
  if (metrics.low_confidence_pct.status === 'warn') {
    alerts.push(`⚠️ Low confidence ${metrics.low_confidence_pct.value}% (> 20%). Nhiều câu hỏi khó — xem xét thêm wiki hoặc rephrase bot prompt.`);
  }
  if (inbox > 20 && confirmed === 0) {
    alerts.push(`🚨 ${inbox} inbox nhưng 0 booking confirmed — check funnel nghẽn ở đâu.`);
  }
  if ((handoffCount?.n || 0) > inbox * 0.3) {
    alerts.push(`⚠️ Auto-handoff ${handoffCount.n} (>30% inbox) — bot không resolve được nhiều case.`);
  }

  const summary = alerts.length === 0
    ? `✅ Bot hoạt động tốt — ${total} lượt, ${confirmed} booking, conversion ${metrics.conversion_rate.value}%.`
    : `⚠️ ${alerts.length} alerts cần review.`;

  return {
    period_hours: hoursBack,
    generated_at: Date.now(),
    metrics,
    alerts,
    summary,
  };
}

/**
 * Format report thành text để gửi Telegram.
 */
export function formatReportText(report: HealthReport): string {
  const m = report.metrics;
  const lines = [
    `📊 VP Marketing — Bot Health (${report.period_hours}h qua)`,
    ``,
    report.summary,
    ``,
    `📥 Inbox: ${m.inbox_senders.value} khách`,
    `🎯 Qualified: ${m.qualified.value}`,
    `✅ Bookings: ${m.confirmed_bookings.value} (${m.conversion_rate.value}%)`,
    ``,
    `🧠 Total turns: ${m.total_turns.value}`,
    `  • LLM: ${m.total_turns.value - (m.total_turns.value * m.rule_fallback_pct.value / 100)}`,
    `  • Rule fallback: ${m.rule_fallback_pct.value}%`,
    `  • Low confidence: ${m.low_confidence_pct.value}%`,
    ``,
    `🤝 Auto-handoffs: ${m.auto_handoffs.value}`,
    `🛡️ Spam blocked: ${m.spam_blocked.value}`,
    `🔔 Re-engagements: ${m.stalled_reengagements.value}`,
  ];

  if (report.alerts.length > 0) {
    lines.push('', '⚠️ ALERTS:');
    report.alerts.forEach(a => lines.push(`  ${a}`));
  }

  return lines.join('\n');
}

/**
 * Run job: tính report + nếu có alerts thì gửi Telegram admin.
 */
export async function runDailyHealthCheck(): Promise<HealthReport> {
  const report = computeHealthReport(24);
  if (report.alerts.length > 0) {
    try {
      await notifyAdmin(formatReportText(report));
    } catch (e: any) {
      console.warn('[bot-health] telegram fail:', e?.message);
    }
  }
  console.log(`[bot-health] ${report.summary}`);
  return report;
}
