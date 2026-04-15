import { db } from '../db';
import { generate } from './router';

/**
 * FAQ Auto-learn:
 * Scan 100 comment gần nhất từ bảng auto_reply_log (kind='comment'),
 * dùng AI classify để cluster câu hỏi lặp lại, gợi ý FAQ mới cho user confirm.
 *
 * Trả về danh sách đề xuất FAQ, KHÔNG tự động ghi vào Wiki (cần user approve).
 */

interface CommentRow {
  original_text: string;
  created_at: number;
}

export async function analyzeRecentComments(minCount = 2): Promise<{
  suggestions: Array<{ question: string; count: number; examples: string[] }>;
  analyzed: number;
}> {
  const rows = db
    .prepare(
      `SELECT original_text, created_at FROM auto_reply_log
       WHERE kind = 'comment' AND original_text IS NOT NULL AND length(original_text) > 5
       ORDER BY created_at DESC LIMIT 100`
    )
    .all() as CommentRow[];

  if (rows.length === 0) {
    return { suggestions: [], analyzed: 0 };
  }

  // Format comment list gửi AI
  const numbered = rows
    .map((r, i) => `${i + 1}. ${r.original_text.slice(0, 200).replace(/\n/g, ' ')}`)
    .join('\n');

  const system = `Bạn là analyst đọc comment khách hàng khách sạn. Nhiệm vụ:
- Phân loại comment thành các NHÓM CÂU HỎI giống nhau
- Bỏ qua comment khen/chê chung chung (vd: "đẹp quá", "thích lắm")
- Chỉ trích những câu có intent hỏi thông tin cụ thể (giá, giờ, tiện nghi, vị trí, ...)

Output format (JSON, không giải thích):
{
  "groups": [
    {"question": "Câu hỏi chuẩn hóa", "count": N, "examples": ["bản gốc 1", "bản gốc 2"]}
  ]
}`;

  const user = `Đây là ${rows.length} comment gần nhất:\n\n${numbered}\n\nPhân cụm thành các nhóm câu hỏi lặp lại (mỗi nhóm phải có ít nhất 2 comment). Trả về JSON.`;

  let rawJson: string;
  try {
    rawJson = await generate({ task: 'classify', system, user });
  } catch (e: any) {
    throw new Error(`Không gọi được AI: ${e.message}`);
  }

  // Extract JSON (có thể bị wrap trong ```json ... ```)
  let parsed: any;
  try {
    const m = rawJson.match(/\{[\s\S]*\}/);
    const jsonStr = m ? m[0] : rawJson;
    parsed = JSON.parse(jsonStr);
  } catch {
    return { suggestions: [], analyzed: rows.length };
  }

  const groups: any[] = parsed?.groups || [];
  const suggestions = groups
    .filter((g) => (g.count || g.examples?.length || 0) >= minCount)
    .map((g) => ({
      question: String(g.question || '').slice(0, 200),
      count: Number(g.count || g.examples?.length || 0),
      examples: Array.isArray(g.examples) ? g.examples.slice(0, 3).map((e: any) => String(e).slice(0, 150)) : [],
    }))
    .sort((a, b) => b.count - a.count);

  return { suggestions, analyzed: rows.length };
}
