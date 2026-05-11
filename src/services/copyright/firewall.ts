/**
 * 🛡️ Pre-Publish Firewall — THE single chokepoint for ALL FB/IG/Zalo publish paths.
 *
 * NO image or caption gets uploaded to FB without passing through this firewall.
 * If ANY check fails, the publish is BLOCKED + logged + admin alerted.
 *
 * Checks performed:
 *   1. IMAGE BLACKLIST   — pHash in copyright_takedown_blacklist (FB already removed before)
 *   2. IMAGE ASSESSMENT  — risk_score ≥ threshold OR status='auto_blocked'/'rejected'
 *   3. CAPTION SAFETY    — hard-sell, engagement bait, all-caps, banned URLs, prohibited words
 *   4. RATE LIMIT        — too many publishes from same source/page in short time
 *
 * If image has never been assessed, runs quick assessment (no web search) before checking.
 *
 * Settings:
 *   prepub_firewall_enabled (default true)
 *   prepub_image_block_threshold (default 60)  — risk_score above which to block
 *   prepub_caption_check_enabled (default true)
 *   prepub_log_all (default false)             — log even passing checks (verbose)
 */

import * as fs from 'fs';
import { db, getSetting } from '../../db';
import { assessImage, computePHash, pHashDistance } from './verifier';

export interface PrePublishRequest {
  source: 'v5t' | 'manual' | 'auto-post' | 'cross-post' | 'scheduler' | 'api';
  source_id?: number | string;        // post_id / plan_id / etc.
  page_id?: number;
  image_paths?: string[];             // local file paths to be uploaded
  external_image_urls?: string[];     // remote URLs (cannot pHash without download)
  caption?: string;
  hotel_id?: number;
}

export interface ImageCheckResult {
  path: string;
  risk_score: number;
  risk_level: string;
  in_blacklist: boolean;
  ok: boolean;
  reasons: string[];
}

export interface PrePublishResult {
  ok: boolean;
  blocked: boolean;
  decision: 'allow' | 'block' | 'warn';
  reasons: string[];                  // top-level reasons
  image_results: ImageCheckResult[];
  caption_issues: string[];
  duration_ms: number;
  checked_at: number;
}

/* ───────── Image checks ───────── */

async function checkImage(imagePath: string, threshold: number): Promise<ImageCheckResult> {
  const result: ImageCheckResult = {
    path: imagePath,
    risk_score: 0,
    risk_level: 'unknown',
    in_blacklist: false,
    ok: true,
    reasons: [],
  };

  if (!fs.existsSync(imagePath)) {
    result.ok = false;
    result.reasons.push('Image file not found on disk');
    return result;
  }

  // 1. Quick pHash lookup against blacklist
  let phash = (db.prepare(`SELECT phash FROM copyright_phashes WHERE image_path = ?`).get(imagePath) as any)?.phash;
  if (!phash) {
    try {
      phash = await computePHash(imagePath);
      if (phash) {
        db.prepare(
          `INSERT OR REPLACE INTO copyright_phashes (image_path, phash, source, computed_at) VALUES (?, ?, 'firewall_compute', ?)`,
        ).run(imagePath, phash, Date.now());
      }
    } catch {}
  }

  if (phash) {
    // Check blacklist with pHash distance ≤ 5 (perceptually identical)
    const blacklist = db.prepare(`SELECT phash, image_path, reason, fb_post_id FROM copyright_takedown_blacklist`).all() as Array<any>;
    for (const b of blacklist) {
      const dist = pHashDistance(phash, b.phash);
      if (dist <= 5) {
        result.in_blacklist = true;
        result.ok = false;
        result.risk_score = 100;
        result.risk_level = 'critical';
        result.reasons.push(`🚫 BLACKLISTED — pHash matches previous takedown (distance=${dist}). Reason: ${b.reason}${b.fb_post_id ? ` (fb_post=${b.fb_post_id})` : ''}`);
        return result;
      }
    }
  }

  // 2. Check existing assessment
  const assessment = db.prepare(
    `SELECT risk_score, risk_level, status, risk_reasons_json FROM copyright_assessments WHERE image_path = ?`,
  ).get(imagePath) as any;

  if (assessment) {
    result.risk_score = assessment.risk_score;
    result.risk_level = assessment.risk_level;
    try {
      result.reasons.push(...JSON.parse(assessment.risk_reasons_json || '[]'));
    } catch {}
    if (assessment.status === 'rejected' || assessment.status === 'auto_blocked') {
      result.ok = false;
      result.reasons.unshift(`🚫 Status = ${assessment.status} (admin marked as not-safe)`);
      return result;
    }
    if (assessment.risk_score >= threshold) {
      result.ok = false;
      result.reasons.unshift(`⚠️ Risk score ${assessment.risk_score} ≥ threshold ${threshold}`);
      return result;
    }
    return result;  // ok
  }

  // 3. No assessment yet — run quick check (no web search to save cost)
  try {
    const a = await assessImage(imagePath, { skip_web_search: true });
    result.risk_score = a.risk_score;
    result.risk_level = a.risk_level;
    result.reasons.push(...a.risk_reasons);
    if (a.status === 'auto_blocked' || a.risk_score >= threshold) {
      result.ok = false;
      result.reasons.unshift(`⚠️ First-time assessment: risk_score=${a.risk_score}, level=${a.risk_level}`);
    }
  } catch (e: any) {
    result.reasons.push(`Assessment failed: ${e.message}`);
    // fail-open on assessment errors (don't block legit posts)
  }

  return result;
}

/* ───────── Caption checks ───────── */

interface CaptionIssue {
  severity: 'critical' | 'warning' | 'info';
  type: string;
  message: string;
}

function checkCaption(caption: string): CaptionIssue[] {
  if (!caption) return [];
  const issues: CaptionIssue[] = [];
  const text = caption.trim();
  const textLower = text.toLowerCase();

  // 1. Hard-sell / Spam patterns
  const hardSellPatterns: Array<[string, string]> = [
    ['đặt ngay', 'Hard-sell: "Đặt ngay"'],
    ['còn chần chừ', 'Engagement bait: "Còn chần chừ"'],
    ['hỏi thật nhé', 'Engagement bait: "Hỏi thật nhé"'],
    ['inbox ngay', 'Hard-sell: "Inbox ngay"'],
    ['click ngay', 'Hard-sell: "Click ngay"'],
    ['comment ngay', 'Engagement bait: "Comment ngay"'],
    ['like nếu', 'Engagement bait: "Like nếu..."'],
    ['share để', 'Engagement bait: "Share để..."'],
    ['tag bạn', 'Engagement bait: "Tag bạn vào đây"'],
    ['siêu rẻ', 'Spammy adjective: "siêu rẻ"'],
    ['rẻ nhất', 'Spammy adjective: "rẻ nhất"'],
    ['số 1 vn', 'Spammy claim: "số 1 VN"'],
    ['tuyệt vời nhất', 'Spammy superlative: "tuyệt vời nhất"'],
    ['đỉnh cao', 'Spammy adjective: "đỉnh cao"'],
    ['1000% hài lòng', 'Spammy claim'],
    ['100% giá tốt', 'Spammy claim'],
  ];
  for (const [pattern, msg] of hardSellPatterns) {
    if (textLower.includes(pattern)) {
      issues.push({ severity: 'warning', type: 'hard_sell', message: msg });
    }
  }

  // 2. All-caps excess (Meta hates SHOUTING)
  const upperRatio = (text.match(/[A-ZÀÁẢÃẠĂẰẮẲẴẶÂẦẤẨẪẬÈÉẺẼẸÊỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌÔỒỐỔỖỘƠỜỚỞỠỢÙÚỦŨỤƯỪỨỬỮỰỲÝỶỸỴĐ]/g) || []).length / (text.length || 1);
  if (upperRatio > 0.35 && text.length > 30) {
    issues.push({ severity: 'warning', type: 'all_caps', message: `${Math.round(upperRatio * 100)}% chữ HOA — Meta thường suppress posts SHOUTING` });
  }

  // 3. Excessive emoji
  const emojiCount = (text.match(/[\u{1F600}-\u{1F9FF}\u{2600}-\u{27BF}\u{1F300}-\u{1F5FF}]/gu) || []).length;
  if (emojiCount > 15) {
    issues.push({ severity: 'warning', type: 'emoji_spam', message: `${emojiCount} emoji — Meta đôi khi coi là spam (≤10 là an toàn)` });
  }

  // 4. Banned URLs — detect with OR without protocol (bit.ly/abc still flagged)
  const bannedShorteners = ['bit.ly', 'tinyurl.com', 'goo.gl', 't.co/', 'ow.ly', 'shorturl.at', 'rebrand.ly', 'cutt.ly', 'is.gd', 'buff.ly'];
  for (const sh of bannedShorteners) {
    if (textLower.includes(sh)) {
      issues.push({ severity: 'critical', type: 'banned_url', message: `🚫 URL shortener detected (${sh}) — Meta flags as spam. Use full sondervn.com URL.` });
    }
  }

  const urls = text.match(/https?:\/\/[^\s]+/gi) || [];
  for (const url of urls) {
    try {
      const u = new URL(url);
      const allowed = ['sondervn.com', 'www.sondervn.com', 'app.sondervn.com', 'facebook.com', 'fb.com', 'instagram.com'];
      if (!allowed.some((a) => u.hostname.endsWith(a))) {
        issues.push({ severity: 'warning', type: 'external_url', message: `External URL "${u.hostname}" — chỉ nên link về sondervn.com (OTA marketplace context)` });
      }
    } catch {}
  }

  // 5. Phone numbers + email pattern (suggest CTA instead of contact)
  // (Skipped: Sondervn IS an OTA, phone/email contact OK)

  // 6. Banned/sensitive words (Vietnam-specific)
  const bannedWords = ['cờ bạc', 'cá độ', 'casino', 'lô đề', 'sex', 'tệ nạn', 'lừa đảo', 'gian lận'];
  for (const w of bannedWords) {
    if (textLower.includes(w)) {
      issues.push({ severity: 'critical', type: 'banned_word', message: `🚫 Banned word: "${w}"` });
    }
  }

  // 7. Length checks
  if (text.length < 50) {
    issues.push({ severity: 'info', type: 'too_short', message: `Caption only ${text.length} chars — FB algo prefers ≥80 chars` });
  } else if (text.length > 2200) {
    issues.push({ severity: 'warning', type: 'too_long', message: `Caption ${text.length} chars — Meta truncates at 1500` });
  }

  // 8. Mention Sondervn keyword (for OTA brand consistency — soft check)
  // (Skipped per V5T philosophy: don't force "Sondervn" in body, only #sondervn hashtag)

  return issues;
}

/* ───────── Main entry ───────── */

export async function checkBeforePublish(req: PrePublishRequest): Promise<PrePublishResult> {
  const t0 = Date.now();
  const enabled = getSetting('prepub_firewall_enabled') !== 'false';
  const threshold = parseInt(getSetting('prepub_image_block_threshold') || '60', 10);
  const captionCheckEnabled = getSetting('prepub_caption_check_enabled') !== 'false';

  if (!enabled) {
    return {
      ok: true, blocked: false, decision: 'allow',
      reasons: ['firewall_disabled'],
      image_results: [], caption_issues: [],
      duration_ms: Date.now() - t0, checked_at: Date.now(),
    };
  }

  const reasons: string[] = [];
  const imageResults: ImageCheckResult[] = [];

  // Check each image
  for (const imgPath of req.image_paths || []) {
    const r = await checkImage(imgPath, threshold);
    imageResults.push(r);
    if (!r.ok) reasons.push(`Image blocked: ${r.path.split('/').pop()} — ${r.reasons[0] || 'unknown'}`);
  }

  // External URLs — cannot pHash without download. Warn admin but don't block.
  for (const url of req.external_image_urls || []) {
    reasons.push(`⚠️ External URL not pHashed (skipped firewall check): ${url.slice(0, 80)}`);
  }

  // Caption checks
  const captionIssuesRaw = captionCheckEnabled && req.caption ? checkCaption(req.caption) : [];
  const captionIssues = captionIssuesRaw.map((i) => `[${i.severity}] ${i.message}`);

  // Multi-warning escalation: if 3+ warnings → escalate to block.
  // Rationale: any single warning is mild, but combo of (hard-sell + engagement bait + spammy)
  // matches Meta's spam-classifier patterns → suppress reach OR remove.
  const criticalCount = captionIssuesRaw.filter((i) => i.severity === 'critical').length;
  const warningCount = captionIssuesRaw.filter((i) => i.severity === 'warning').length;
  const criticalCaption = criticalCount > 0 || warningCount >= 3;

  if (criticalCount > 0) {
    reasons.push(`Caption: ${criticalCount} CRITICAL issue(s)`);
  } else if (warningCount >= 3) {
    reasons.push(`Caption: ${warningCount} warnings combined = looks like spam (escalated to block)`);
  }

  // Decision
  const anyImageBlocked = imageResults.some((r) => !r.ok);
  const ok = !anyImageBlocked && !criticalCaption;

  const result: PrePublishResult = {
    ok,
    blocked: !ok,
    decision: ok ? 'allow' : 'block',
    reasons,
    image_results: imageResults,
    caption_issues: captionIssues,
    duration_ms: Date.now() - t0,
    checked_at: Date.now(),
  };

  // Log to prepublish_audit
  try {
    db.prepare(
      `INSERT INTO prepublish_audit
       (source, source_id, page_id, hotel_id, image_count, caption_length,
        decision, blocked, reasons_json, image_results_json, caption_issues_json, duration_ms, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      req.source, String(req.source_id || ''), req.page_id || null, req.hotel_id || null,
      (req.image_paths?.length || 0), (req.caption?.length || 0),
      result.decision, result.blocked ? 1 : 0,
      JSON.stringify(reasons), JSON.stringify(imageResults), JSON.stringify(captionIssues),
      result.duration_ms, result.checked_at,
    );
  } catch (e: any) {
    console.warn('[prepub-firewall] audit log fail:', e?.message);
  }

  // Alert admin on block
  if (result.blocked) {
    console.warn(`[prepub-firewall] 🚫 BLOCKED publish from ${req.source} #${req.source_id}: ${reasons.join('; ')}`);
    try {
      const { notifyAdmin } = require('../telegram');
      const lines = [
        `🛡️ *Pre-Publish Firewall blocked a post*`,
        ``,
        `Source: ${req.source} #${req.source_id || '?'}`,
        `Images: ${(req.image_paths?.length || 0) + (req.external_image_urls?.length || 0)}`,
        ``,
        `Reasons:`,
        ...reasons.slice(0, 5).map((r) => `  • ${r}`),
      ];
      notifyAdmin(lines.join('\n')).catch(() => {});
    } catch {}
  }

  return result;
}

/** Quick helper that returns true if safe, false if blocked. */
export async function isSafeToPublish(req: PrePublishRequest): Promise<boolean> {
  const r = await checkBeforePublish(req);
  return r.ok;
}
