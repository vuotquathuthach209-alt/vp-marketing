import cron from 'node-cron';
import { db } from '../db';
import { publishText, publishImage, publishVideo, mediaFullPath } from './facebook';
import { runCampaigns } from './campaigns';
import { runAutoReply } from './autoreply';

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
    } catch (err: any) {
      const msg = err?.response?.data?.error?.message || err?.message || String(err);
      db.prepare(`UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?`).run(msg, post.id);
      console.error(`[scheduler] Post #${post.id} thất bại: ${msg}`);
    }
  }
}

export function startScheduler() {
  // Mỗi phút: xử lý bài đăng lên lịch + chạy campaign
  cron.schedule('* * * * *', () => {
    processDuePosts().catch((e) => console.error('[scheduler] posts error:', e));
    runCampaigns().catch((e) => console.error('[scheduler] campaigns error:', e));
  });
  // Mỗi 5 phút: auto reply comment & tin nhắn
  cron.schedule('*/5 * * * *', () => {
    runAutoReply().catch((e) => console.error('[scheduler] auto-reply error:', e));
  });
  console.log('[scheduler] Đã khởi động: posts+campaigns mỗi phút, auto-reply mỗi 5 phút');
}
