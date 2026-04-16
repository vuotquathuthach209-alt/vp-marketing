import axios from 'axios';
import { db } from '../db';
import { smartReply } from './smartreply';

const GRAPH = 'https://graph.facebook.com/v21.0';

async function replyToComments(page: any) {
  try {
    const resp = await axios.get(`${GRAPH}/${page.fb_page_id}/posts`, {
      params: {
        fields: 'id,comments.limit(10){id,from,message,created_time}',
        limit: 10,
        access_token: page.access_token,
      },
      timeout: 20000,
    });

    const posts = resp.data?.data || [];
    for (const post of posts) {
      const comments = post.comments?.data || [];
      for (const comment of comments) {
        if (!comment.id || !comment.message) continue;
        // Bỏ qua comment của chính page
        if (comment.from?.id === page.fb_page_id) continue;
        // Đã xử lý chưa
        const exists = db.prepare(`SELECT id FROM auto_reply_log WHERE fb_id = ?`).get(comment.id);
        if (exists) continue;

        try {
          const { reply } = await smartReply(comment.message);
          await axios.post(
            `${GRAPH}/${comment.id}/comments`,
            null,
            {
              params: { message: reply, access_token: page.access_token },
              timeout: 15000,
            }
          );
          db.prepare(
            `INSERT INTO auto_reply_log (page_id, kind, fb_id, original_text, reply_text, status, created_at)
             VALUES (?, 'comment', ?, ?, ?, 'sent', ?)`
          ).run(page.id, comment.id, comment.message, reply, Date.now());
          console.log(`[auto-reply] ✅ Reply comment ${comment.id}`);
        } catch (err: any) {
          const msg = err?.response?.data?.error?.message || err?.message;
          try {
            db.prepare(
              `INSERT INTO auto_reply_log (page_id, kind, fb_id, original_text, reply_text, status, error, created_at)
               VALUES (?, 'comment', ?, ?, '', 'failed', ?, ?)`
            ).run(page.id, comment.id, comment.message, msg, Date.now());
          } catch {}
          console.error(`[auto-reply] ❌ Comment ${comment.id}: ${msg}`);
        }
      }
    }
  } catch (err: any) {
    console.error(`[auto-reply] Fetch comments ${page.name}:`, err?.response?.data?.error?.message || err.message);
  }
}

async function replyToMessages(page: any) {
  try {
    const resp = await axios.get(`${GRAPH}/${page.fb_page_id}/conversations`, {
      params: {
        fields: 'id,updated_time,messages.limit(3){id,from,message,created_time}',
        limit: 15,
        access_token: page.access_token,
      },
      timeout: 20000,
    });

    const convos = resp.data?.data || [];
    for (const convo of convos) {
      const messages = convo.messages?.data || [];
      if (messages.length === 0) continue;
      const latest = messages[0]; // Mới nhất
      if (!latest.id || !latest.message) continue;
      // Tin mới nhất là của page → không cần reply
      if (latest.from?.id === page.fb_page_id) continue;

      const exists = db.prepare(`SELECT id FROM auto_reply_log WHERE fb_id = ?`).get(latest.id);
      if (exists) continue;

      try {
        const { reply } = await smartReply(latest.message);
        await axios.post(
          `${GRAPH}/me/messages`,
          {
            recipient: { id: latest.from.id },
            message: { text: reply },
            messaging_type: 'RESPONSE',
          },
          {
            params: { access_token: page.access_token },
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000,
          }
        );
        db.prepare(
          `INSERT INTO auto_reply_log (page_id, kind, fb_id, original_text, reply_text, status, created_at)
           VALUES (?, 'message', ?, ?, ?, 'sent', ?)`
        ).run(page.id, latest.id, latest.message, reply, Date.now());
        console.log(`[auto-reply] ✅ Reply message ${latest.id}`);
      } catch (err: any) {
        const msg = err?.response?.data?.error?.message || err?.message;
        try {
          db.prepare(
            `INSERT INTO auto_reply_log (page_id, kind, fb_id, original_text, reply_text, status, error, created_at)
             VALUES (?, 'message', ?, ?, '', 'failed', ?, ?)`
          ).run(page.id, latest.id, latest.message, msg, Date.now());
        } catch {}
        console.error(`[auto-reply] ❌ Message ${latest.id}: ${msg}`);
      }
    }
  } catch (err: any) {
    console.error(`[auto-reply] Fetch messages ${page.name}:`, err?.response?.data?.error?.message || err.message);
  }
}

export async function runAutoReply() {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.fb_page_id, p.access_token,
              COALESCE(c.reply_comments, 0) as reply_comments,
              COALESCE(c.reply_messages, 0) as reply_messages,
              COALESCE(c.system_prompt, '') as system_prompt
       FROM pages p LEFT JOIN auto_reply_config c ON c.page_id = p.id`
    )
    .all() as any[];

  for (const page of rows) {
    if (page.reply_comments) await replyToComments(page);
    if (page.reply_messages) await replyToMessages(page);
  }
}
