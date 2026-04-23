/**
 * Brand Positioning Migrator (v24 hotfix)
 *
 * Force-update existing DB rows để reflect positioning đúng:
 *   Sonder = "hệ thống tư vấn phòng lưu trú" (NOT "chuỗi khách sạn").
 *
 * Chạy 1 lần khi app boot. Idempotent — chỉ update rows có bad positioning.
 *
 * Tables affected:
 *   - reply_templates (variant C của greeting_new)
 *   - knowledge_wiki (sonder-brand, customer-care-tone)
 */

import { db } from '../db';

const BAD_PHRASES = [
  'chuỗi 7 chỗ',
  'chuỗi khách sạn',
  'chuỗi 7',
  'chuỗi khách sạn & căn hộ',
];

/** Check if content contains brand-positioning bug. */
function hasBadPositioning(content: string): boolean {
  if (!content) return false;
  const lower = content.toLowerCase();
  return BAD_PHRASES.some(p => lower.includes(p.toLowerCase()));
}

export function migrateBrandPositioning(): { updated_templates: number; updated_wiki: number; scanned: number } {
  const result = { updated_templates: 0, updated_wiki: 0, scanned: 0 };

  try {
    // 1. reply_templates — tìm bad positioning + mark as inactive để seeder re-insert
    const tmpl = db.prepare(
      `SELECT id, template_key, variant_name, content FROM reply_templates WHERE active = 1`
    ).all() as any[];
    result.scanned += tmpl.length;

    for (const t of tmpl) {
      if (hasBadPositioning(t.content)) {
        // Deactivate old row; seeder on next boot will re-create with correct content
        db.prepare(`UPDATE reply_templates SET active = 0, updated_at = ? WHERE id = ?`)
          .run(Date.now(), t.id);
        // Also delete directly so seeder fires INSERT
        db.prepare(`DELETE FROM reply_templates WHERE id = ?`).run(t.id);
        result.updated_templates++;
        console.log(`[brand-migrator] removed bad template #${t.id} (${t.template_key}/${t.variant_name})`);
      }
    }

    // 2. knowledge_wiki — check brand + tone entries
    const wiki = db.prepare(
      `SELECT id, namespace, slug, content FROM knowledge_wiki WHERE active = 1`
    ).all() as any[];
    result.scanned += wiki.length;

    for (const w of wiki) {
      const bad = hasBadPositioning(w.content);
      // customer-care-tone: check for old pronoun guidance "mình (bot) — bạn/anh/chị (khách)"
      const badTone = w.slug === 'customer-care-tone' && (
        w.content.includes('"mình" (bot)') ||
        w.content.includes('mình (bot)') ||
        w.content.includes('Xưng hô: "mình"')
      );
      if (bad || badTone) {
        // Delete → seeder will re-insert on next boot
        db.prepare(`DELETE FROM knowledge_wiki WHERE id = ?`).run(w.id);
        result.updated_wiki++;
        console.log(`[brand-migrator] removed bad wiki #${w.id} (${w.namespace}/${w.slug}) reason=${bad ? 'bad_brand' : 'bad_tone'}`);
      }
    }

    if (result.updated_templates > 0 || result.updated_wiki > 0) {
      console.log(`[brand-migrator] v24 positioning migration: removed ${result.updated_templates} template(s) + ${result.updated_wiki} wiki(s) → re-seed on next tick`);
    }
  } catch (e: any) {
    console.warn('[brand-migrator] fail:', e?.message);
  }

  return result;
}
