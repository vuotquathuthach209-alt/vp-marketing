/**
 * News Classifier — Phase N-2.
 *
 * 2 tầng filter sau khi ingest:
 *   1. Keyword gate (fast, rule-based): match ≥ 2 travel keywords → pass
 *   2. Gemini classifier (JSON): travel_relevant + impact + political_risk
 *      + angle_hint → update article với fields này
 *
 * Criteria pass cả 2:
 *   - travel_relevant = true
 *   - impact ≥ 0.3
 *   - political_risk ≤ 0.4
 *
 * Article pass → status='angle_generated' (sẵn sàng Phase N-3)
 * Article fail → status='filtered_out' + status_note
 *
 * Thêm: dedupe bằng title embedding cosine ≥ 0.85 trong 7-day window.
 */
import { db } from '../db';
import { smartCascade } from './smart-cascade';
import { embed, cosine, encodeEmbedding, decodeEmbedding } from './embedder';
import { getSourceById } from './news-sources';

const BATCH_SIZE = 10;                           // classify 10 articles/run
const DEDUPE_SIM_THRESHOLD = 0.85;
const DEDUPE_WINDOW_MS = 7 * 24 * 3600 * 1000;   // 7 ngày
const MIN_IMPACT = 0.3;
const MAX_POLITICAL_RISK = 0.4;

/* ═══════════════════════════════════════════
   KEYWORD GATE (Stage 1)
   ═══════════════════════════════════════════ */

const TRAVEL_KEYWORDS_VI = [
  'du lịch', 'du khách', 'khách sạn', 'resort', 'homestay', 'nghỉ dưỡng',
  'chuyến bay', 'hãng hàng không', 'vé máy bay', 'hủy chuyến', 'hoãn chuyến',
  'sân bay', 'visa', 'cửa khẩu', 'xuất cảnh', 'nhập cảnh', 'hộ chiếu',
  'check-in', 'check-out', 'đặt phòng', 'booking', 'tour', 'lữ hành',
  'mùa lễ', 'hướng dẫn viên', 'điểm đến', 'airbnb', 'lưu trú',
  'căn hộ cho thuê', 'dịch vụ phòng', 'refund', 'hoàn tiền', 'đặt vé',
  'phòng ngủ', 'phòng khách', 'phòng gia đình', 'lễ tân',
];

const TRAVEL_KEYWORDS_EN = [
  'tourism', 'tourist', 'hotel', 'hospitality', 'travel', 'traveler', 'traveller',
  'airline', 'aviation', 'flight', 'airport', 'cancellation', 'booking',
  'visa', 'border', 'passport', 'immigration', 'occupancy', 'resort',
  'destination', 'airbnb', 'short-term rental', 'homestay', 'lodging',
  'tour operator', 'hospitality industry', 'accommodation', 'checkin',
  'check-in', 'check-out', 'refund', 'itinerary',
];

/** Count unique keywords matched in text (case-insensitive). */
function countKeywords(text: string, lang: 'vi' | 'en'): { count: number; matched: string[] } {
  const lower = text.toLowerCase();
  const list = lang === 'vi' ? TRAVEL_KEYWORDS_VI : TRAVEL_KEYWORDS_EN;
  const matched = new Set<string>();
  for (const kw of list) {
    if (lower.includes(kw)) matched.add(kw);
  }
  return { count: matched.size, matched: Array.from(matched) };
}

export function keywordGate(
  title: string,
  body: string | null,
  lang: 'vi' | 'en',
  sourceId?: string,
): { pass: boolean; matched: string[]; reason: string } {
  const text = [title, body || ''].join(' ');
  const primary = countKeywords(text, lang);
  const other = countKeywords(text, lang === 'vi' ? 'en' : 'vi');
  const combined = new Set([...primary.matched, ...other.matched]);

  // Source-aware threshold:
  //   - Travel/industry specific sources: threshold = 1 (any travel keyword là OK)
  //   - General sources (BBC world, VnExpress Thế giới): threshold = 2
  const src = sourceId ? getSourceById(sourceId) : undefined;
  const isTravelSource = src?.category === 'travel' || src?.category === 'industry';
  const threshold = isTravelSource ? 1 : 2;

  if (combined.size >= threshold) {
    return { pass: true, matched: Array.from(combined), reason: `${combined.size}≥${threshold} (${isTravelSource ? 'travel_src' : 'general_src'})` };
  }
  return { pass: false, matched: Array.from(combined), reason: `${combined.size}<${threshold} (${isTravelSource ? 'travel_src' : 'general_src'})` };
}

/* ═══════════════════════════════════════════
   GEMINI CLASSIFIER (Stage 2)
   ═══════════════════════════════════════════ */

export interface ClassifierResult {
  relevant: boolean;
  impact: number;            // 0..1, mức độ ảnh hưởng booking behavior
  political_risk: number;    // 0..1, bao nhiêu chính trị (>0.4 = reject)
  region: string;            // "Southeast Asia" | "Middle East" | ...
  angle_hint: string;        // ≤ 20 từ, gợi ý góc nhìn
  reasoning?: string;        // debug
}

const CLASSIFIER_SYSTEM = `Bạn là biên tập viên phân loại tin cho ngành du lịch & khách sạn Việt Nam.

Nhiệm vụ: đọc 1 tin tức → phân loại theo 5 tiêu chí, TRẢ JSON CHÍNH XÁC.

Tiêu chí:
1. relevant: tin này có tác động đến HÀNH VI ĐẶT PHÒNG / DU LỊCH / HÀNG KHÔNG không?
   (ví dụ: biến động giá vé, huỷ chuyến, thiên tai, dịch bệnh, xu hướng du khách, chính sách visa, v.v.)
2. impact: 0..1, mức độ tác động tới quyết định đặt phòng (0=không, 1=rất lớn).
3. political_risk: 0..1, mức độ CHÍNH TRỊ/NHẠY CẢM của tin.
   - 0-0.2: thuần factual (thời tiết, xu hướng, số liệu)
   - 0.3-0.4: có yếu tố bối cảnh nhưng vẫn trung lập (ví dụ "chiến tranh X → khách chuyển sang Y")
   - 0.5+: đi sâu vào chính trị, cáo buộc, tên đảng phái/lãnh đạo
4. region: khu vực bị ảnh hưởng (ngắn, tiếng Việt, ví dụ "Đông Nam Á", "Trung Đông", "Việt Nam").
5. angle_hint: góc nhìn KHÁCH SẠN có thể viết (≤ 20 từ, tập trung vào hành vi du khách).

CẤM: đưa quan điểm cá nhân, chỉ trích, phân tích chính trị.
Chỉ trả đúng JSON, không markdown, không text khác.`;

export async function classifyWithGemini(title: string, body: string | null): Promise<ClassifierResult | null> {
  const user = `Tiêu đề: ${title}
${body ? 'Nội dung: ' + body.slice(0, 800) : ''}

Trả JSON schema:
{
  "relevant": boolean,
  "impact": number,
  "political_risk": number,
  "region": string,
  "angle_hint": string
}`;

  try {
    const result = await smartCascade({
      system: CLASSIFIER_SYSTEM,
      user,
      maxTokens: 400,
      temperature: 0.1,
      json: true,
    });
    // Gemini đôi khi trả prose prefix ("Here is the JSON..."). Extract JSON block.
    let jsonText = result.text.trim();
    // Strip markdown code fence ```json ... ```
    const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) jsonText = fence[1].trim();
    // Extract { ... } block
    const braceStart = jsonText.indexOf('{');
    const braceEnd = jsonText.lastIndexOf('}');
    if (braceStart >= 0 && braceEnd > braceStart) {
      jsonText = jsonText.slice(braceStart, braceEnd + 1);
    }
    const parsed = JSON.parse(jsonText);
    return {
      relevant: !!parsed.relevant,
      impact: Math.max(0, Math.min(1, Number(parsed.impact) || 0)),
      political_risk: Math.max(0, Math.min(1, Number(parsed.political_risk) || 0)),
      region: String(parsed.region || '').slice(0, 80),
      angle_hint: String(parsed.angle_hint || '').slice(0, 200),
    };
  } catch (e: any) {
    console.warn(`[news-classifier] Gemini fail: ${e?.message}`);
    return null;
  }
}

/* ═══════════════════════════════════════════
   DEDUPE BY TITLE EMBEDDING
   ═══════════════════════════════════════════ */

/** Check nếu article này có bị trùng title với article đã có (7 ngày). */
async function isDuplicateByEmbedding(articleId: number, title: string): Promise<boolean> {
  const vec = await embed(title);
  if (!vec) return false;

  const cutoff = Date.now() - DEDUPE_WINDOW_MS;
  const rows = db.prepare(
    `SELECT id, title_embedding FROM news_articles
     WHERE id != ? AND published_at > ? AND title_embedding IS NOT NULL
       AND status IN ('angle_generated', 'pending_review', 'approved', 'published')
     ORDER BY published_at DESC LIMIT 200`
  ).all(articleId, cutoff) as any[];

  for (const r of rows) {
    try {
      const v2 = decodeEmbedding(r.title_embedding as Buffer);
      if (cosine(vec, v2) >= DEDUPE_SIM_THRESHOLD) {
        return true;
      }
    } catch { /* skip corrupt */ }
  }

  // Save embedding cho article này (dù có dup hay không)
  try {
    db.prepare(`UPDATE news_articles SET title_embedding = ? WHERE id = ?`)
      .run(encodeEmbedding(vec), articleId);
  } catch {}
  return false;
}

/* ═══════════════════════════════════════════
   MAIN CLASSIFY LOOP
   ═══════════════════════════════════════════ */

export interface ClassifyBatchResult {
  processed: number;
  passed: number;
  keyword_filtered: number;
  ai_filtered: number;
  political_filtered: number;
  duplicate: number;
  gemini_errors: number;
}

/** Classify 1 article — trả true nếu passed, update status luôn. */
export async function classifyArticle(articleId: number): Promise<'pass' | 'keyword_filter' | 'ai_filter' | 'political' | 'duplicate' | 'gemini_error'> {
  const a = db.prepare(
    `SELECT id, title, body, lang, published_at, source FROM news_articles WHERE id = ?`
  ).get(articleId) as any;
  if (!a) return 'gemini_error';

  const now = Date.now();

  // Stage 1: keyword gate (source-aware: threshold=1 cho travel sources, =2 cho general)
  const kw = keywordGate(a.title, a.body, a.lang === 'en' ? 'en' : 'vi', a.source);
  if (!kw.pass) {
    db.prepare(
      `UPDATE news_articles SET status='filtered_out', status_note=?, last_state_change_at=? WHERE id=?`
    ).run(`no_keywords ${kw.reason}`, now, articleId);
    return 'keyword_filter';
  }

  // Stage 2: Gemini classifier
  const cls = await classifyWithGemini(a.title, a.body);
  if (!cls) {
    // Gemini error → giữ status='ingested' để retry sau (không mark failed)
    return 'gemini_error';
  }

  // Update classification fields regardless
  db.prepare(
    `UPDATE news_articles
     SET is_travel_relevant=?, relevance_score=?, impact_score=?, political_risk=?,
         region=?, angle_hint=?, last_state_change_at=?
     WHERE id = ?`
  ).run(
    cls.relevant ? 1 : 0,
    cls.relevant ? 1 : 0,  // alias
    cls.impact,
    cls.political_risk,
    cls.region,
    cls.angle_hint,
    now,
    articleId
  );

  // Decision
  if (!cls.relevant) {
    db.prepare(`UPDATE news_articles SET status='filtered_out', status_note='ai_not_relevant' WHERE id=?`)
      .run(articleId);
    return 'ai_filter';
  }
  if (cls.impact < MIN_IMPACT) {
    db.prepare(`UPDATE news_articles SET status='filtered_out', status_note=? WHERE id=?`)
      .run(`impact_too_low(${cls.impact.toFixed(2)})`, articleId);
    return 'ai_filter';
  }
  if (cls.political_risk > MAX_POLITICAL_RISK) {
    db.prepare(`UPDATE news_articles SET status='filtered_out', status_note=? WHERE id=?`)
      .run(`political_risk(${cls.political_risk.toFixed(2)})`, articleId);
    return 'political';
  }

  // Stage 3: dedupe by title embedding
  const dup = await isDuplicateByEmbedding(articleId, a.title);
  if (dup) {
    db.prepare(`UPDATE news_articles SET status='filtered_out', status_note='duplicate_title' WHERE id=?`)
      .run(articleId);
    return 'duplicate';
  }

  // PASS → ready for angle generation (Phase N-3)
  db.prepare(`UPDATE news_articles SET status='angle_generated', status_note=NULL WHERE id=?`)
    .run(articleId);
  return 'pass';
}

/** Classify batch articles ở status='ingested', ưu tiên gần nhất */
export async function classifyBatch(limit = BATCH_SIZE): Promise<ClassifyBatchResult> {
  const result: ClassifyBatchResult = {
    processed: 0, passed: 0, keyword_filtered: 0, ai_filtered: 0,
    political_filtered: 0, duplicate: 0, gemini_errors: 0,
  };

  const pending = db.prepare(
    `SELECT id FROM news_articles WHERE status='ingested'
     ORDER BY published_at DESC LIMIT ?`
  ).all(limit) as any[];

  for (const row of pending) {
    const r = await classifyArticle(row.id);
    result.processed++;
    if (r === 'pass') result.passed++;
    else if (r === 'keyword_filter') result.keyword_filtered++;
    else if (r === 'ai_filter') result.ai_filtered++;
    else if (r === 'political') result.political_filtered++;
    else if (r === 'duplicate') result.duplicate++;
    else if (r === 'gemini_error') result.gemini_errors++;
  }

  console.log(`[news-classifier] batch: ${JSON.stringify(result)}`);
  return result;
}
