import { db } from '../db';
import { notifyAll } from './telegram';

/**
 * Weekly quality report — aggregated stats pushed to Telegram every Sunday 8am.
 * Covers: conversation volume, cache hit rate, AI cost, top learned Q&A,
 * phone captures, auto-reply success rate.
 */

interface WeekStats {
  week_start: string;
  conversations: number;
  unique_senders: number;
  auto_reply_sent: number;
  auto_reply_failed: number;
  phone_captures: number;
  learned_cache_hits: number;   // bot served from learned_qa_cache
  ai_rag_replies: number;       // bot generated via LLM
  top_intents: Array<{ intent: string; count: number }>;
  top_learned: Array<{ question: string; hits: number }>;
  ai_cost_usd: number;
  ai_requests: number;
  // Phase 4: Smart training pipeline + News pipeline
  qa_pending?: number;
  qa_approved?: number;
  qa_trusted?: number;
  qa_cache_hits_total?: number;
  qa_savings_usd?: number;
  news_pending_review?: number;
  news_published_7d?: number;
}

export function computeWeekStats(): WeekStats {
  const now = Date.now();
  const weekAgo = now - 7 * 86400 * 1000;
  const weekStart = new Date(weekAgo).toLocaleDateString('vi-VN');

  const sum = (q: string, ...args: any[]): number =>
    (db.prepare(q).get(...args) as any)?.n || 0;

  const conversations = sum(
    `SELECT COUNT(*) as n FROM conversation_memory WHERE created_at >= ?`,
    weekAgo,
  );
  const uniqueSenders = sum(
    `SELECT COUNT(DISTINCT sender_id) as n FROM conversation_memory WHERE created_at >= ?`,
    weekAgo,
  );
  const autoReplySent = sum(
    `SELECT COUNT(*) as n FROM auto_reply_log WHERE status = 'sent' AND created_at >= ?`,
    weekAgo,
  );
  const autoReplyFailed = sum(
    `SELECT COUNT(*) as n FROM auto_reply_log WHERE status = 'failed' AND created_at >= ?`,
    weekAgo,
  );
  const phoneCaptures = sum(
    `SELECT COUNT(*) as n FROM customer_contacts WHERE created_at >= ?`,
    weekAgo,
  );
  const learnedHits = sum(
    `SELECT COUNT(*) as n FROM conversation_memory WHERE role='bot' AND intent='learned' AND created_at >= ?`,
    weekAgo,
  );
  const aiRag = sum(
    `SELECT COUNT(*) as n FROM conversation_memory WHERE role='bot' AND intent='ai_rag' AND created_at >= ?`,
    weekAgo,
  );

  const topIntents = db
    .prepare(
      `SELECT intent, COUNT(*) as count FROM conversation_memory
       WHERE role='bot' AND intent IS NOT NULL AND created_at >= ?
       GROUP BY intent ORDER BY count DESC LIMIT 5`,
    )
    .all(weekAgo) as Array<{ intent: string; count: number }>;

  const topLearned = db
    .prepare(
      `SELECT question, hits FROM learned_qa_cache
       WHERE last_hit_at >= ? ORDER BY hits DESC LIMIT 5`,
    )
    .all(weekAgo) as Array<{ question: string; hits: number }>;

  // AI cost from ai_usage_log if table exists
  let aiCost = 0;
  let aiReqs = 0;
  try {
    const r = db
      .prepare(
        `SELECT COUNT(*) as n, COALESCE(SUM(cost_usd), 0) as total
         FROM ai_usage_log WHERE created_at >= ?`,
      )
      .get(weekAgo) as any;
    aiReqs = r?.n || 0;
    aiCost = r?.total || 0;
  } catch {}

  // Phase 4: Smart training pipeline stats
  let qaPending = 0;
  let qaApproved = 0;
  let qaTrusted = 0;
  let qaCacheHits = 0;
  let qaSavingsUsd = 0;
  let newsPendingReview = 0;
  let newsPublished7d = 0;
  try {
    qaPending = sum(`SELECT COUNT(*) as n FROM qa_training_cache WHERE tier='pending'`);
    qaApproved = sum(`SELECT COUNT(*) as n FROM qa_training_cache WHERE tier='approved'`);
    qaTrusted = sum(`SELECT COUNT(*) as n FROM qa_training_cache WHERE tier='trusted'`);
    const qaHitsRow = db.prepare(
      `SELECT COALESCE(SUM(hits_count), 0) as n FROM qa_training_cache WHERE tier IN ('trusted','approved')`
    ).get() as any;
    qaCacheHits = qaHitsRow?.n || 0;
    // Savings: mỗi served hit ≈ Gemini Flash 200 out + 600 in tokens
    qaSavingsUsd = qaCacheHits * ((600 * 0.075 + 200 * 0.30) / 1_000_000);
  } catch {}
  try {
    newsPendingReview = sum(`SELECT COUNT(*) as n FROM news_post_drafts WHERE status='pending'`);
    newsPublished7d = sum(
      `SELECT COUNT(*) as n FROM news_post_drafts WHERE status='published' AND published_at >= ?`,
      weekAgo,
    );
  } catch {}

  return {
    week_start: weekStart,
    conversations,
    unique_senders: uniqueSenders,
    auto_reply_sent: autoReplySent,
    auto_reply_failed: autoReplyFailed,
    phone_captures: phoneCaptures,
    learned_cache_hits: learnedHits,
    ai_rag_replies: aiRag,
    top_intents: topIntents,
    top_learned: topLearned,
    ai_cost_usd: aiCost,
    ai_requests: aiReqs,
    qa_pending: qaPending,
    qa_approved: qaApproved,
    qa_trusted: qaTrusted,
    qa_cache_hits_total: qaCacheHits,
    qa_savings_usd: qaSavingsUsd,
    news_pending_review: newsPendingReview,
    news_published_7d: newsPublished7d,
  } as WeekStats;
}

export function formatReport(s: WeekStats): string {
  const totalBotReplies = s.learned_cache_hits + s.ai_rag_replies;
  const cacheRate = totalBotReplies > 0 ? ((s.learned_cache_hits / totalBotReplies) * 100).toFixed(1) : '0';
  const successRate =
    s.auto_reply_sent + s.auto_reply_failed > 0
      ? ((s.auto_reply_sent / (s.auto_reply_sent + s.auto_reply_failed)) * 100).toFixed(1)
      : '100';

  const lines: string[] = [
    `📊 *BÁO CÁO TUẦN* — từ ${s.week_start}`,
    ``,
    `💬 Hội thoại: *${s.conversations}* tin nhắn`,
    `👥 Khách duy nhất: *${s.unique_senders}*`,
    `📞 SĐT thu được: *${s.phone_captures}*`,
    ``,
    `🤖 Auto-reply: ${s.auto_reply_sent} gửi OK / ${s.auto_reply_failed} lỗi (${successRate}%)`,
    `🧠 Cache hit rate: *${cacheRate}%* (${s.learned_cache_hits} cache / ${s.ai_rag_replies} AI)`,
  ];

  if (s.ai_requests > 0) {
    lines.push(`💰 AI requests: ${s.ai_requests} | Cost: $${s.ai_cost_usd.toFixed(4)}`);
  }

  if (s.top_intents.length > 0) {
    lines.push(``, `*Top intents:*`);
    for (const i of s.top_intents) {
      lines.push(`  • ${i.intent}: ${i.count}`);
    }
  }

  if (s.top_learned.length > 0) {
    lines.push(``, `*Top learned Q&A:*`);
    for (const l of s.top_learned) {
      const q = l.question.length > 50 ? l.question.slice(0, 50) + '…' : l.question;
      lines.push(`  • "${q}" × ${l.hits}`);
    }
  }

  // Phase 4: Training pipeline section
  if ((s.qa_pending || 0) > 0 || (s.qa_approved || 0) > 0) {
    lines.push(``, `🎓 *Training Review:*`);
    lines.push(`  • Pending: ${s.qa_pending || 0} (chờ admin duyệt)`);
    lines.push(`  • Approved + Trusted: ${(s.qa_approved || 0) + (s.qa_trusted || 0)}`);
    lines.push(`  • Cache hits tổng: ${(s.qa_cache_hits_total || 0).toLocaleString()}`);
    lines.push(`  • Tiết kiệm ước tính: $${(s.qa_savings_usd || 0).toFixed(4)}`);
  }

  // News pipeline section
  if ((s.news_pending_review || 0) > 0 || (s.news_published_7d || 0) > 0) {
    lines.push(``, `📰 *News → Post:*`);
    lines.push(`  • Đã đăng tuần này: ${s.news_published_7d || 0}/3`);
    lines.push(`  • Drafts chờ duyệt: ${s.news_pending_review || 0}`);
  }

  return lines.join('\n');
}

export async function sendWeeklyReport(): Promise<void> {
  try {
    const stats = computeWeekStats();
    const report = formatReport(stats);
    await notifyAll(report);
    console.log(`[weekly-report] sent: ${stats.conversations} conversations, ${stats.phone_captures} phones`);
  } catch (e: any) {
    console.error('[weekly-report] failed:', e.message);
  }
}
