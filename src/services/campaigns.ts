import { db } from '../db';
import { generateCaption, generateImagePrompt } from './claude';
import { generateImageSmart } from './imagegen';
import { publishText, publishImage, mediaFullPath } from './facebook';

/**
 * Chạy chiến dịch tự động đăng hàng ngày.
 * Gọi mỗi phút từ scheduler. Match HH:MM hiện tại với times của campaign.
 */
export async function runCampaigns() {
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const slotKey = `${dateKey} ${hhmm}`;

  const campaigns = db.prepare(`SELECT * FROM campaigns WHERE active = 1`).all() as any[];

  for (const c of campaigns) {
    let times: string[], topics: string[], lastRuns: Record<string, boolean>;
    try {
      times = JSON.parse(c.times);
      topics = JSON.parse(c.topics);
      lastRuns = JSON.parse(c.last_runs || '{}');
    } catch {
      continue;
    }

    if (!times.includes(hhmm)) continue;
    if (lastRuns[slotKey]) continue; // Đã chạy slot này rồi

    // Đánh dấu đã chạy (tránh gọi trùng), giữ lại chỉ key của ngày hôm nay
    const pruned: Record<string, boolean> = {};
    for (const k of Object.keys(lastRuns)) if (k.startsWith(dateKey)) pruned[k] = true;
    pruned[slotKey] = true;
    db.prepare(`UPDATE campaigns SET last_runs = ? WHERE id = ?`).run(JSON.stringify(pruned), c.id);

    try {
      const topic = topics[Math.floor(Math.random() * topics.length)];
      console.log(`[campaigns] "${c.name}" - chủ đề: ${topic}`);

      const caption = await generateCaption(topic);

      let mediaId: number | null = null;
      let mediaFilename: string | null = null;
      if (c.with_image) {
        const prompt = await generateImagePrompt(caption);
        const imgR = await generateImageSmart(prompt);
        mediaId = imgR.mediaId;
        const m = db.prepare(`SELECT filename FROM media WHERE id = ?`).get(mediaId) as any;
        mediaFilename = m?.filename;
      }

      const page = db.prepare(`SELECT * FROM pages WHERE id = ?`).get(c.page_id) as any;
      if (!page) throw new Error(`Page id=${c.page_id} không tồn tại`);

      const postResult = db
        .prepare(
          `INSERT INTO posts (page_id, caption, media_id, media_type, status, scheduled_at, created_at)
           VALUES (?, ?, ?, ?, 'publishing', ?, ?)`
        )
        .run(c.page_id, caption, mediaId, mediaFilename ? 'image' : 'none', Date.now(), Date.now());
      const postId = Number(postResult.lastInsertRowid);

      let pubResult;
      if (mediaFilename) {
        pubResult = await publishImage(page.fb_page_id, page.access_token, caption, mediaFullPath(mediaFilename));
      } else {
        pubResult = await publishText(page.fb_page_id, page.access_token, caption);
      }

      db.prepare(
        `UPDATE posts SET status = 'published', published_at = ?, fb_post_id = ? WHERE id = ?`
      ).run(Date.now(), pubResult.fbPostId, postId);

      // v24: Cross-post FB → IG + Zalo OA (non-blocking)
      try {
        const { crossPostFromPostId } = require('./cross-post-sync');
        crossPostFromPostId(postId, 'campaign').catch((e: any) =>
          console.warn('[campaigns] cross-post fail:', e?.message)
        );
      } catch {}

      console.log(`[campaigns] ✅ Đã đăng "${c.name}" → ${pubResult.fbPostId}`);
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message || err?.message || String(err);
      console.error(`[campaigns] ❌ "${c.name}" thất bại: ${msg}`);
    }
  }
}
