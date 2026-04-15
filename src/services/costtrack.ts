import { db } from '../db';

/**
 * Cost tracker cho AI calls. Giá tham khảo (USD / 1M tokens) — có thể lệch thực tế
 * nhưng dùng để estimate/so sánh, không dùng để billing.
 * Cập nhật: 2025-Q1.
 */
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'claude-haiku-4-5-20251001': { in: 0.8, out: 4.0 },
  'gemini-2.0-flash': { in: 0.1, out: 0.4 },
  'gemma2-9b-it': { in: 0.2, out: 0.2 },
  'text-embedding-004': { in: 0.0, out: 0.0 }, // free tier
};

export function estimateCost(model: string, inTok: number, outTok: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (inTok * p.in + outTok * p.out) / 1_000_000;
}

export interface UsageEntry {
  task: string;
  provider: string;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  ok: boolean;
  error?: string | null;
}

export function logUsage(e: UsageEntry) {
  const inTok = e.input_tokens || 0;
  const outTok = e.output_tokens || 0;
  const cost = estimateCost(e.model, inTok, outTok);
  try {
    db.prepare(
      `INSERT INTO ai_usage_log (task, provider, model, input_tokens, output_tokens, cost_usd, ok, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(e.task, e.provider, e.model, inTok, outTok, cost, e.ok ? 1 : 0, e.error || null, Date.now());
  } catch (err) {
    console.warn('[costtrack] log fail:', err);
  }
}

export function getCostOverview(days = 30) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const totals = db
    .prepare(
      `SELECT COUNT(*) as calls, SUM(cost_usd) as total_usd,
              SUM(input_tokens) as in_tok, SUM(output_tokens) as out_tok,
              SUM(CASE WHEN ok=0 THEN 1 ELSE 0 END) as fails
       FROM ai_usage_log WHERE created_at >= ?`
    )
    .get(cutoff) as any;

  const byProvider = db
    .prepare(
      `SELECT provider, COUNT(*) as calls, SUM(cost_usd) as cost_usd,
              SUM(input_tokens + output_tokens) as tokens
       FROM ai_usage_log WHERE created_at >= ?
       GROUP BY provider ORDER BY cost_usd DESC`
    )
    .all(cutoff);

  const byTask = db
    .prepare(
      `SELECT task, COUNT(*) as calls, SUM(cost_usd) as cost_usd
       FROM ai_usage_log WHERE created_at >= ?
       GROUP BY task ORDER BY cost_usd DESC`
    )
    .all(cutoff);

  return {
    period_days: days,
    calls: totals?.calls || 0,
    fails: totals?.fails || 0,
    total_usd: totals?.total_usd || 0,
    input_tokens: totals?.in_tok || 0,
    output_tokens: totals?.out_tok || 0,
    by_provider: byProvider,
    by_task: byTask,
  };
}
