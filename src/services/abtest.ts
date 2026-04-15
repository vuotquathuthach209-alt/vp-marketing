import { db } from '../db';
import { generate } from './router';
import { buildContext } from './wiki';

/**
 * A/B hook testing:
 * 1. Gen 2 variant caption cho 1 chủ đề, khác nhau chỉ ở HOOK (câu mở đầu)
 * 2. Ghi vào bảng ab_experiments
 * 3. Sau 24h+ (khi có metric), tính winner theo engagement rate
 * 4. Winner → tự động append vào Wiki namespace='lesson' để AI học
 */

const VARIANT_SYSTEM = `Bạn là chuyên gia content marketing khách sạn tại Việt Nam.
Viết caption Facebook tiếng Việt với HOOK mở đầu theo phong cách cụ thể được yêu cầu.

NGUYÊN TẮC:
- Mô tả trải nghiệm cụ thể, không chung chung
- Call-to-action rõ ràng (inbox, comment)
- 5-8 hashtag
- 80-180 từ
- Không dùng "tuyệt vời", "đỉnh cao"`;

const HOOK_STYLES: Record<'A' | 'B', { name: string; desc: string }> = {
  A: {
    name: 'Câu hỏi',
    desc: 'Bắt đầu bằng 1 câu hỏi kích thích tò mò (vd: "Bạn có biết vì sao...?")',
  },
  B: {
    name: 'Con số/Insight',
    desc: 'Bắt đầu bằng 1 con số cụ thể hoặc insight bất ngờ (vd: "3 điều ít ai biết về..." hoặc "80% khách của em đều hỏi...")',
  },
};

export async function generateVariant(topic: string, variant: 'A' | 'B'): Promise<string> {
  const wikiCtx = await buildContext(topic);
  const ctxBlock = wikiCtx
    ? `\n\n--- KIẾN THỨC DOANH NGHIỆP ---\n${wikiCtx}\n--- HẾT ---\n`
    : '';
  const style = HOOK_STYLES[variant];
  const user = `Chủ đề: ${topic}${ctxBlock}\n\nHOOK STYLE: ${style.name} — ${style.desc}\n\nHãy viết caption Facebook hoàn chỉnh theo hook style trên. Nếu có kiến thức doanh nghiệp, dùng chính xác số liệu.`;

  return generate({
    task: 'caption',
    system: VARIANT_SYSTEM,
    user,
  });
}

/**
 * Tạo 2 variant và lưu vào ab_experiments (chưa gán post_id,
 * caller sẽ tạo 2 post draft rồi update post_id sau).
 */
export async function createExperiment(topic: string, pageId: number): Promise<{
  experimentId: number;
  variantA: string;
  variantB: string;
}> {
  const [variantA, variantB] = await Promise.all([
    generateVariant(topic, 'A'),
    generateVariant(topic, 'B'),
  ]);

  const result = db
    .prepare(
      `INSERT INTO ab_experiments (topic, page_id, variant_a_caption, variant_b_caption, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(topic, pageId, variantA, variantB, Date.now());

  return {
    experimentId: Number(result.lastInsertRowid),
    variantA,
    variantB,
  };
}

export function attachPosts(experimentId: number, postAId: number, postBId: number) {
  db.prepare(
    `UPDATE ab_experiments SET variant_a_post_id = ?, variant_b_post_id = ? WHERE id = ?`
  ).run(postAId, postBId, experimentId);
}

/**
 * Cron job: với mỗi experiment chưa decide winner và cả 2 post đã >= 24h tuổi,
 * tính winner theo (reactions + comments*2 + shares*3) / reach.
 * Ghi Wiki 'lesson' để AI học hook nào hiệu quả hơn.
 */
export function decidePendingWinners(): number {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const pending = db
    .prepare(
      `SELECT e.* FROM ab_experiments e
       JOIN posts pa ON pa.id = e.variant_a_post_id
       JOIN posts pb ON pb.id = e.variant_b_post_id
       WHERE e.winner IS NULL
         AND pa.published_at IS NOT NULL AND pa.published_at <= ?
         AND pb.published_at IS NOT NULL AND pb.published_at <= ?`
    )
    .all(cutoff, cutoff) as any[];

  let decided = 0;
  for (const exp of pending) {
    const scoreA = computeScore(exp.variant_a_post_id);
    const scoreB = computeScore(exp.variant_b_post_id);
    if (scoreA === null || scoreB === null) continue;

    const winner = scoreA >= scoreB ? 'A' : 'B';
    const winnerScore = Math.max(scoreA, scoreB);
    const style = HOOK_STYLES[winner];

    db.prepare(
      `UPDATE ab_experiments SET winner = ?, winner_score = ?, decided_at = ? WHERE id = ?`
    ).run(winner, winnerScore, Date.now(), exp.id);

    // Ghi lesson vào Wiki
    const slug = `hook-${exp.id}-${winner.toLowerCase()}`;
    const title = `Hook "${style.name}" thắng (A/B #${exp.id})`;
    const content = `Với chủ đề "${exp.topic}", hook dạng **${style.name}** (${style.desc}) có engagement score ${winnerScore.toFixed(4)} (A=${scoreA.toFixed(4)}, B=${scoreB.toFixed(4)}). Ưu tiên dùng style này cho chủ đề tương tự.`;

    try {
      db.prepare(
        `INSERT OR IGNORE INTO knowledge_wiki
         (namespace, slug, title, content, tags, always_inject, active, updated_at, created_at)
         VALUES ('lesson', ?, ?, ?, ?, 0, 1, ?, ?)`
      ).run(slug, title, content, JSON.stringify(['ab-test', 'hook', style.name]), Date.now(), Date.now());
    } catch {}

    decided++;
  }
  return decided;
}

function computeScore(postId: number): number | null {
  const row = db
    .prepare(
      `SELECT reach, reactions, comments, shares FROM post_metrics
       WHERE post_id = ? ORDER BY snapshot_at DESC LIMIT 1`
    )
    .get(postId) as any;
  if (!row || !row.reach) return null;
  const weighted = row.reactions + row.comments * 2 + row.shares * 3;
  return weighted / row.reach;
}

export function listExperiments(limit = 50) {
  return db
    .prepare(
      `SELECT e.*, pg.name as page_name FROM ab_experiments e
       LEFT JOIN pages pg ON pg.id = e.page_id
       ORDER BY e.id DESC LIMIT ?`
    )
    .all(limit);
}
