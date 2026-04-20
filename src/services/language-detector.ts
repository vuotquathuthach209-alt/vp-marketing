/**
 * Language Detector
 *
 * Phát hiện ngôn ngữ khách dùng → bot tự động trả lời đúng ngôn ngữ.
 * Việt Nam có nhiều khách Hàn/Trung/Anh, đặc biệt là khách sạn gần sân bay.
 *
 * Supported: vi (default) | en | ko | zh | ja | ru | fr | de | th | id
 *
 * Strategy:
 *  1. Cache language trong guest_profiles.language (đã có cột sẵn).
 *  2. Nếu lần đầu hoặc > 2 câu: re-detect dựa trên charset + common words.
 *  3. Unicode block detection cho non-Latin scripts (rất nhanh).
 *  4. Common-word matching cho Latin-script languages.
 */
import { db } from '../db';

export type Lang = 'vi' | 'en' | 'ko' | 'zh' | 'ja' | 'ru' | 'fr' | 'de' | 'th' | 'id';

export const LANG_LABELS: Record<Lang, string> = {
  vi: 'Tiếng Việt', en: 'English', ko: '한국어', zh: '中文', ja: '日本語',
  ru: 'Русский', fr: 'Français', de: 'Deutsch', th: 'ไทย', id: 'Bahasa Indonesia',
};

// Unicode ranges for fast detection
const SCRIPT_TESTS: Array<{ lang: Lang; re: RegExp; weight: number }> = [
  // Korean Hangul (U+AC00-D7AF + U+1100-11FF)
  { lang: 'ko', re: /[\uAC00-\uD7AF\u1100-\u11FF]/, weight: 3 },
  // Japanese Hiragana/Katakana (U+3040-30FF) — but kanji overlaps Chinese
  { lang: 'ja', re: /[\u3040-\u309F\u30A0-\u30FF]/, weight: 3 },
  // Chinese Han (but also Japanese kanji) — lower weight if no hiragana
  { lang: 'zh', re: /[\u4E00-\u9FFF]/, weight: 2 },
  // Thai (U+0E00-0E7F)
  { lang: 'th', re: /[\u0E00-\u0E7F]/, weight: 3 },
  // Cyrillic (U+0400-04FF)
  { lang: 'ru', re: /[\u0400-\u04FF]/, weight: 3 },
];

// Common-word detection for Latin-script languages
const COMMON_WORDS: Record<Lang, RegExp[]> = {
  vi: [/\b(tôi|em|bạn|của|không|phòng|khách sạn|có|là|được|cho|nhé|ạ|với)\b/i],
  en: [/\b(the|is|are|have|want|book|room|hotel|please|thanks?|hello|hi|for|with|how|what|when|where|can you)\b/i],
  fr: [/\b(bonjour|merci|chambre|réservation|avec|pour|comment|hôtel|je|nous|vous)\b/i],
  de: [/\b(guten|danke|zimmer|buchung|mit|für|wie|hotel|ich|wir|sie)\b/i],
  id: [/\b(saya|terima|kamar|pesan|dengan|untuk|bagaimana|hotel|kami|anda)\b/i],
  ko: [], ja: [], zh: [], ru: [], th: [], // non-Latin
};

export function detectLanguage(message: string): { lang: Lang; confidence: number } {
  if (!message || message.trim().length < 2) return { lang: 'vi', confidence: 0.3 };
  const text = message.trim();

  // Step 1: Non-Latin script detection (highest confidence)
  let scriptScores: Record<string, number> = {};
  for (const t of SCRIPT_TESTS) {
    const matches = text.match(new RegExp(t.re.source, 'g'));
    if (matches && matches.length > 0) {
      scriptScores[t.lang] = (scriptScores[t.lang] || 0) + matches.length * t.weight;
    }
  }
  // If we have hiragana/katakana, it's Japanese even if kanji present
  if (scriptScores.ja) {
    return { lang: 'ja', confidence: 0.95 };
  }
  // Korean
  if (scriptScores.ko) {
    return { lang: 'ko', confidence: 0.95 };
  }
  // Thai
  if (scriptScores.th) {
    return { lang: 'th', confidence: 0.95 };
  }
  // Cyrillic
  if (scriptScores.ru) {
    return { lang: 'ru', confidence: 0.9 };
  }
  // Chinese (no hiragana)
  if (scriptScores.zh) {
    return { lang: 'zh', confidence: 0.9 };
  }

  // Step 2: Latin-script — count common words
  const wordScores: Record<Lang, number> = { vi: 0, en: 0, fr: 0, de: 0, id: 0, ko: 0, ja: 0, zh: 0, ru: 0, th: 0 };
  for (const lang of Object.keys(COMMON_WORDS) as Lang[]) {
    for (const re of COMMON_WORDS[lang]) {
      const matches = text.match(new RegExp(re.source, 'gi'));
      if (matches) wordScores[lang] += matches.length;
    }
  }

  // Vietnamese has diacritics — boost
  if (/[àáạảãăằắặẳẵâầấậẩẫèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(text)) {
    wordScores.vi += 3;
  }

  const entries = (Object.entries(wordScores) as [Lang, number][]).filter(([, v]) => v > 0);
  if (entries.length === 0) {
    // No strong signal → default vi (local market)
    return { lang: 'vi', confidence: 0.4 };
  }

  entries.sort((a, b) => b[1] - a[1]);
  const [best, bestScore] = entries[0];
  const total = entries.reduce((s, [, v]) => s + v, 0);
  const conf = Math.min(0.9, 0.5 + (bestScore / total) * 0.4);
  return { lang: best, confidence: conf };
}

/**
 * Lấy ngôn ngữ cached của khách, hoặc detect + cache lại.
 */
export function resolveUserLanguage(opts: {
  senderId?: string;
  hotelId: number;
  message: string;
}): { lang: Lang; fromCache: boolean; confidence: number } {
  const { senderId, hotelId, message } = opts;
  const detected = detectLanguage(message);

  if (!senderId) return { lang: detected.lang, fromCache: false, confidence: detected.confidence };

  // Cached language
  let cached: Lang | null = null;
  try {
    const row = db.prepare(
      `SELECT language FROM guest_profiles WHERE hotel_id = ? AND fb_user_id = ?`
    ).get(hotelId, senderId) as any;
    if (row?.language && row.language !== 'vi') cached = row.language as Lang;
  } catch {}

  // Logic:
  //  - If detect confident (>=0.7) and differs from cache → update
  //  - If cache exists and detect vague → use cache
  //  - Else use detected
  if (detected.confidence >= 0.7) {
    if (cached !== detected.lang) {
      try {
        db.prepare(
          `UPDATE guest_profiles SET language = ? WHERE hotel_id = ? AND fb_user_id = ?`
        ).run(detected.lang, hotelId, senderId);
      } catch {}
    }
    return { lang: detected.lang, fromCache: false, confidence: detected.confidence };
  }
  if (cached) return { lang: cached, fromCache: true, confidence: 0.7 };
  return { lang: detected.lang, fromCache: false, confidence: detected.confidence };
}

/**
 * Directive câu system prompt để bot trả lời đúng ngôn ngữ.
 */
export function languageDirective(lang: Lang): string {
  if (lang === 'vi') return ''; // default, không cần thêm
  const instructions: Record<Lang, string> = {
    vi: '',
    en: `⚠️ IMPORTANT: The customer is writing in English. You MUST reply in natural, friendly English only. Use warm hospitality tone. Do NOT mix Vietnamese words.`,
    ko: `⚠️ 중요: 고객이 한국어로 말하고 있습니다. 친절하고 자연스러운 한국어로만 답변하세요. 베트남어를 섞지 마세요. 존댓말 사용.`,
    zh: `⚠️ 重要：客户使用中文。请只用自然、友好的中文回复。不要混用越南语。`,
    ja: `⚠️ 重要：お客様は日本語を話しています。自然で丁寧な日本語のみで返答してください。ベトナム語を混ぜないでください。`,
    ru: `⚠️ ВАЖНО: Клиент пишет на русском. Отвечайте только на естественном, дружелюбном русском. Не смешивайте с вьетнамским.`,
    fr: `⚠️ IMPORTANT : Le client écrit en français. Répondez uniquement en français naturel et amical. Ne mélangez pas avec le vietnamien.`,
    de: `⚠️ WICHTIG: Der Kunde schreibt auf Deutsch. Antworten Sie nur auf natürlichem, freundlichem Deutsch. Mischen Sie nicht mit Vietnamesisch.`,
    th: `⚠️ สำคัญ: ลูกค้าพูดภาษาไทย กรุณาตอบเป็นภาษาไทยที่เป็นธรรมชาติและเป็นมิตรเท่านั้น ห้ามปนภาษาเวียดนาม`,
    id: `⚠️ PENTING: Tamu menggunakan Bahasa Indonesia. Balas hanya dalam Bahasa Indonesia yang alami dan ramah. Jangan campur dengan bahasa Vietnam.`,
  };
  return instructions[lang];
}
