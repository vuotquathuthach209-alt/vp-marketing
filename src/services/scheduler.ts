import cron from 'node-cron';
import { db } from '../db';
import { publishText, publishImage, publishVideo, mediaFullPath } from './facebook';
import { runCampaigns } from './campaigns';
import { runAutoReply } from './autoreply';
import { pullMetrics } from './analytics';
import { decidePendingWinners } from './abtest';
import { notifyAll } from './telegram';
import { getSetting } from '../db';
import { runAutopilotCycle, generateMorningReport, generateEveningReport, researchTopics } from './autopilot';

interface PostRow {
  id: number;
  page_id: number;
  caption: string;
  media_id: number | null;
  media_type: string | null;
  scheduled_at: number;
}

interface PageRow {
  id: number;
  fb_page_id: string;
  access_token: string;
}

interface MediaRow {
  filename: string;
}

async function processDuePosts() {
  const now = Date.now();
  const due = db
    .prepare(
      `SELECT id, page_id, caption, media_id, media_type, scheduled_at
       FROM posts
       WHERE status = 'scheduled' AND scheduled_at <= ?
       ORDER BY scheduled_at ASC
       LIMIT 5`
    )
    .all(now) as PostRow[];

  for (const post of due) {
    db.prepare(`UPDATE posts SET status = 'publishing' WHERE id = ?`).run(post.id);

    try {
      const page = db
        .prepare(`SELECT id, fb_page_id, access_token FROM pages WHERE id = ?`)
        .get(post.page_id) as PageRow | undefined;

      if (!page) throw new Error(`Không tìm thấy page id=${post.page_id}`);

      let result;
      if (post.media_type === 'image' && post.media_id) {
        const media = db
          .prepare(`SELECT filename FROM media WHERE id = ?`)
          .get(post.media_id) as MediaRow | undefined;
        if (!media) throw new Error('Không tìm thấy media');
        result = await publishImage(page.fb_page_id, page.access_token, post.caption, mediaFullPath(media.filename));
      } else if (post.media_type === 'video' && post.media_id) {
        const media = db
          .prepare(`SELECT filename FROM media WHERE id = ?`)
          .get(post.media_id) as MediaRow | undefined;
        if (!media) throw new Error('Không tìm thấy media');
        result = await publishVideo(page.fb_page_id, page.access_token, post.caption, mediaFullPath(media.filename));
      } else {
        result = await publishText(page.fb_page_id, page.access_token, post.caption);
      }

      db.prepare(
        `UPDATE posts SET status = 'published', published_at = ?, fb_post_id = ?, error_message = NULL WHERE id = ?`
      ).run(Date.now(), result.fbPostId, post.id);
      console.log(`[scheduler] Đăng thành công post #${post.id} → ${result.fbPostId}`);
      notifyAll(`✅ *Đăng thành công* post #${post.id}\n\`${result.fbPostId}\`\n\n${post.caption.slice(0, 200)}`).catch(() => {});
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message || err?.message || String(err);
      db.prepare(`UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?`).run(msg, post.id);
      console.error(`[scheduler] Post #${post.id} thất bại: ${msg}`);
      notifyAll(`❌ *Post #${post.id} FAIL*\n${msg}`).catch(() => {});
    }
  }
}

export function startScheduler() {
  // Mỗi phút: xử lý bài đăng lên lịch + chạy campaign
  cron.schedule('* * * * *', () => {
    processDuePosts().catch((e) => console.error('[scheduler] posts error:', e));
    runCampaigns().catch((e) => console.error('[scheduler] campaigns error:', e));
  });
  // Mỗi phút: auto reply comment & tin nhắn (near real-time)
  cron.schedule('* * * * *', () => {
    runAutoReply().catch((e) => console.error('[scheduler] auto-reply error:', e));
  });
  // Mỗi 2 giờ: pull FB insights cho các post đã đăng
  cron.schedule('0 */2 * * *', () => {
    pullMetrics()
      .then((r) => console.log(`[scheduler] metrics pulled: ok=${r.ok} fail=${r.fail}`))
      .catch((e) => console.error('[scheduler] metrics error:', e));
  });
  // Mỗi giờ: check A/B experiments nào đã đủ 24h → quyết định winner
  cron.schedule('15 * * * *', () => {
    try {
      const n = decidePendingWinners();
      if (n > 0) console.log(`[scheduler] A/B: decided ${n} winner(s)`);
    } catch (e) {
      console.error('[scheduler] ab decide error:', e);
    }
  });
  // ── Autopilot: morning prep 6:30 AM VN ──
  cron.schedule('30 6 * * *', async () => {
    try {
      if (getSetting('autopilot_enabled') !== '1') return;
      console.log('[autopilot] Morning run — researching & scheduling posts');

      // Get first page as default
      const page = db.prepare('SELECT id FROM pages LIMIT 1').get() as { id: number } | undefined;
      if (!page) { console.warn('[autopilot] No pages configured'); return; }

      // Create 2 scheduled posts (10:00 & 19:00)
      await runAutopilotCycle(page.id);
      await runAutopilotCycle(page.id);

      const report = await generateMorningReport();
      await notifyAll(report);
    } catch (e) {
      console.error('[autopilot] morning error:', e);
    }
  });

  // ── Autopilot: evening report 9:00 PM VN ──
  cron.schedule('0 21 * * *', async () => {
    try {
      if (getSetting('autopilot_enabled') !== '1') return;
      const report = await generateEveningReport();
      await notifyAll(report);
    } catch (e) {
      console.error('[autopilot] evening error:', e);
    }
  });

  console.log('[scheduler] Đã khởi động: posts+campaigns 1p, auto-reply 1p, metrics 2h, ab decide 1h, autopilot 6:30/21:00');
}
