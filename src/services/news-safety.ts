/**
 * News Safety Gate — Phase N-4.
 *
 * 3 lớp check trên draft BEFORE status='pending':
 *   Lớp 1: Keyword blocklist (40+ từ cấm) — rule-based, fast
 *   Lớp 2: Gemini tone/criticism/offensive classifier — AI check
 *   Lớp 3: Fact-source check — có ít nhất 1 trong:
 *           • nguồn tin ("theo Reuters/Skift/VnExpress")
 *           • số liệu (%, nghìn/triệu, số đêm, số khách)
 *           • timeframe ("tháng X", "quý Y", "gần đây")
 *
 * Auto-reject nếu fail bất kỳ lớp 1/2. Lớp 3 chỉ warn — admin quyết.
 */
import { smartCascade } from './smart-cascade';

export interface SafetyFlags {
  keyword_hits: string[];          // từ cấm trúng
  tone: 'neutral' | 'positive' | 'negative' | 'aggressive' | 'political' | 'unknown';
  has_criticism: boolean;
  offensive_score: number;          // 0..1
  fact_source: boolean;             // có dẫn nguồn/số liệu?
  passed: boolean;                  // overall verdict
  failure_reason?: string;
}

/* ═══════════════════════════════════════════
   LỚP 1: KEYWORD BLOCKLIST
   ═══════════════════════════════════════════ */

// Từ cấm chia theo nhóm. Match sẽ auto-reject.
const BLOCK_TERMS = [
  // Criticism / blame verbs (toàn cấm)
  'đáng trách', 'đáng lên án', 'phải chịu trách nhiệm', 'thủ phạm',
  'lỗi của', 'do lỗi', 'gây ra bởi', 'vì lỗi', 'vô đạo đức',
  'tội ác', 'hung thủ', 'kẻ tội phạm', 'vô nhân đạo',
  'chỉ trích', 'phản đối mạnh mẽ', 'lên án mạnh mẽ',

  // Political names (tránh nhắc tên khi chưa cần thiết)
  'donald trump', 'joe biden', 'biden', 'trump', 'putin', 'vladimir putin',
  'xi jinping', 'tập cận bình', 'netanyahu', 'benjamin netanyahu',
  'zelensky', 'erdogan', 'kim jong un',

  // Religious conflict (không bao giờ đủ tinh tế để post auto)
  'hồi giáo cực đoan', 'kitô giáo phản động', 'công giáo phản động',
  'phật giáo phản động', 'đạo giáo cực đoan',

  // Discriminatory / ethnic slurs
  'bọn chúng', 'lũ kia', 'dân tộc đó', 'người da ', 'phân biệt chủng tộc',

  // Conspiracy / misinformation markers
  'âm mưu', 'tin đồn cho rằng', 'theo nguồn tin chưa xác thực',
  'rò rỉ cho thấy', 'chưa được kiểm chứng',
];

export function keywordBlocklistCheck(text: string): string[] {
  const lower = text.toLowerCase();
  return BLOCK_TERMS.filter(t => lower.includes(t));
}

/* ═══════════════════════════════════════════
   LỚP 2: AI TONE CLASSIFIER
   ═══════════════════════════════════════════ */

const TONE_SYSTEM = `Bạn kiểm duyệt nội dung cho fanpage du lịch. Đọc bài đăng, trả JSON đúng 4 trường.

Ví dụ output:
{"tone":"neutral","criticism":false,"offensive":0.1,"fact_source":true}

Trường:
- tone: "neutral" | "positive" | "negative" | "aggressive" | "political"
- criticism: true nếu bài có chỉ trích quốc gia/tổ chức/cá nhân
- offensive: 0..1 — mức xúc phạm / gây tranh cãi
- fact_source: true nếu có dẫn nguồn, số liệu, timeframe`;

export async function toneCheck(draftText: string): Promise<{
  tone: string;
  criticism: boolean;
  offensive: number;
  fact_source: boolean;
} | null> {
  const user = `Bài đăng: "${draftText.slice(0, 1500)}"

Trả JSON 4 trường (tone, criticism, offensive, fact_source). Đầy đủ.`;

  try {
    const result = await smartCascade({
      system: TONE_SYSTEM,
      user,
      maxTokens: 300,
      temperature: 0.1,
    });
    let jsonText = result.text.trim();
    const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) jsonText = fence[1].trim();
    const s = jsonText.indexOf('{');
    const e = jsonText.lastIndexOf('}');
    if (s >= 0 && e > s) jsonText = jsonText.slice(s, e + 1);
    const parsed = JSON.parse(jsonText);
    return {
      tone: String(parsed.tone || 'unknown').toLowerCase(),
      criticism: !!parsed.criticism,
      offensive: Math.max(0, Math.min(1, Number(parsed.offensive) || 0)),
      fact_source: !!parsed.fact_source,
    };
  } catch (e: any) {
    console.warn(`[news-safety] tone check fail: ${e?.message}`);
    return null;
  }
}

/* ═══════════════════════════════════════════
   LỚP 3: FACT-SOURCE HEURISTIC
   ═══════════════════════════════════════════ */

const SOURCE_MARKERS_VI = [
  'theo ', 'nguồn tin ', 'báo cáo ', 'công bố bởi ', 'số liệu từ ',
  'theo báo ', 'theo đài ', 'dẫn nguồn ',
];
const SOURCE_MARKERS_EN = ['according to', 'reuters', 'associated press', 'afp', 'bbc', 'skift'];
const NUMBER_PATTERN = /\b\d+([\.,]\d+)?\s*(%|triệu|nghìn|đồng|USD|\$|đêm|khách|lượt|năm|tháng|quý)/i;
const TIMEFRAME_PATTERN = /(tháng \d+|quý [1-4]|trong (tuần|tháng|quý|năm)|đầu tháng|cuối tháng|giữa năm|gần đây|năm 20\d\d)/i;

export function factSourceCheck(text: string): {
  has_source: boolean;
  has_number: boolean;
  has_timeframe: boolean;
  pass: boolean;
} {
  const lower = text.toLowerCase();
  const hasSource = SOURCE_MARKERS_VI.some(m => lower.includes(m)) ||
                    SOURCE_MARKERS_EN.some(m => lower.includes(m));
  const hasNumber = NUMBER_PATTERN.test(text);
  const hasTimeframe = TIMEFRAME_PATTERN.test(text);
  // Pass nếu có ít nhất 1 trong 3
  return { has_source: hasSource, has_number: hasNumber, has_timeframe: hasTimeframe,
           pass: hasSource || hasNumber || hasTimeframe };
}

/* ═══════════════════════════════════════════
   MAIN SAFETY GATE
   ═══════════════════════════════════════════ */

export async function runSafetyGate(draftText: string): Promise<SafetyFlags> {
  // LỚP 1: blocklist (hard fail)
  const kwHits = keywordBlocklistCheck(draftText);
  if (kwHits.length > 0) {
    return {
      keyword_hits: kwHits,
      tone: 'unknown',
      has_criticism: false,
      offensive_score: 0,
      fact_source: false,
      passed: false,
      failure_reason: `blocklist: ${kwHits.slice(0, 3).join(', ')}${kwHits.length > 3 ? '...' : ''}`,
    };
  }

  // LỚP 3: fact-source (không block, chỉ warn)
  const fact = factSourceCheck(draftText);

  // LỚP 2: AI tone check
  const tone = await toneCheck(draftText);
  if (!tone) {
    // AI không check được → giữ conservative, đẩy cho admin review (không auto-reject)
    return {
      keyword_hits: [],
      tone: 'unknown',
      has_criticism: false,
      offensive_score: 0,
      fact_source: fact.pass,
      passed: true,                // default pass khi AI fail
      failure_reason: undefined,
    };
  }

  // Decision logic
  let passed = true;
  let reason: string | undefined;

  if (tone.criticism) {
    passed = false;
    reason = 'criticism_detected';
  } else if (tone.offensive > 0.3) {
    passed = false;
    reason = `offensive_score=${tone.offensive.toFixed(2)}`;
  } else if (['aggressive', 'political'].includes(tone.tone)) {
    passed = false;
    reason = `tone=${tone.tone}`;
  }
  // Note: negative tone không auto-reject vì có thể chỉ là mô tả fact
  //       (ví dụ "du khách hủy phòng" là negative nhưng chính đáng)

  return {
    keyword_hits: [],
    tone: tone.tone as any,
    has_criticism: tone.criticism,
    offensive_score: tone.offensive,
    fact_source: fact.pass,
    passed,
    failure_reason: reason,
  };
}
