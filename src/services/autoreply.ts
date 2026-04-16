import axios from 'axios';
import { db } from '../db';
import { smartReply, smartReplyWithSender } from './smartreply';
import { markTransferReceived, hasActiveBooking } from './bookingflow';
import { notifyAll } from './telegram';
import { notifyHotelOrGlobal } from './hotel-telegram';

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
        fields: 'id,updated_time,messages.limit(3){id,from,message,created_time,attachments}',
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
      if (!latest.id) continue;
      // Tin mới nhất là của page → không cần reply
      if (latest.from?.id === page.fb_page_id) continue;

      const exists = db.prepare(`SELECT id FROM auto_reply_log WHERE fb_id = ?`).get(latest.id);
      if (exists) continue;

      // Detect image attachments
      const attachments = latest.attachments?.data || [];
      const imageAttach = attachments.find((a: any) =>
        a.mime_type?.startsWith('image/') || a.type === 'image'
      );
      const hasImage = !!imageAttach;
      const imageUrl = imageAttach?.image_data?.url || imageAttach?.url || null;
      const messageText = latest.message || '';
      const senderId = latest.from?.id;
      const senderName = latest.from?.name;

      // If no text and no image, skip
      if (!messageText && !hasImage) continue;

      try {
        // If image + awaiting transfer → handle transfer
        if (hasImage && senderId && hasActiveBooking(senderId)) {
          const transferResult = markTransferReceived(senderId, imageUrl);
          if (transferResult) {
            // Send reply to customer
            await sendFBMessage(page.access_token, senderId, transferResult.reply);
            db.prepare(
              `INSERT INTO auto_reply_log (page_id, kind, fb_id, original_text, reply_text, status, created_at)
               VALUES (?, 'message', ?, ?, ?, 'sent', ?)`
            ).run(page.id, latest.id, '[ảnh chuyển khoản]', transferResult.reply, Date.now());

            // Notify Telegram
            const b = transferResult.booking;
            const tgMsg = `📸 CHUYỂN KHOẢN MỚI\n` +
              `Booking #${b.id}\n` +
              `Khách: ${b.fb_sender_name || senderId}\n` +
              `Phòng: ${b.room_type || 'N/A'}, ${b.nights} đêm (${b.checkin_date} → ${b.checkout_date})\n` +
              `Tổng: ${b.total_price.toLocaleString('vi-VN')}₫ | Cọc: ${b.deposit_amount.toLocaleString('vi-VN')}₫\n\n` +
              `Lễ tân xác nhận: /confirm ${b.id} [số phòng]\n` +
              `Từ chối: /reject ${b.id} [lý do]`;
            notifyHotelOrGlobal(page.id, tgMsg).catch(() => {});

            console.log(`[auto-reply] ✅ Transfer image received, booking #${b.id}`);
            continue;
          }
        }

        const { reply, images } = await smartReplyWithSender(
          messageText || '(ảnh)',
          senderId,
          senderName,
          hasImage,
          page.hotel_id || 1,
          page.id
        );
        await sendFBMessage(page.access_token, senderId, reply);

        // Send room images gallery if available
        if (images && images.length > 0) {
          try {
            await sendFBGallery(page.access_token, senderId, images.map(img => ({
              title: img.title,
              subtitle: img.subtitle,
              image_url: img.image_url,
            })));
          } catch (imgErr: any) {
            console.error(`[auto-reply] Gallery send failed:`, imgErr?.response?.data?.error?.message || imgErr.message);
            // Fallback: send images one by one
            for (const img of images.slice(0, 3)) {
              try {
                await sendFBImage(page.access_token, senderId, img.image_url);
              } catch {}
            }
          }
        }
        db.prepare(
          `INSERT INTO auto_reply_log (page_id, kind, fb_id, original_text, reply_text, status, created_at)
           VALUES (?, 'message', ?, ?, ?, 'sent', ?)`
        ).run(page.id, latest.id, messageText, reply, Date.now());
        console.log(`[auto-reply] ✅ Reply message ${latest.id}`);
      } catch (err: any) {
        const msg = err?.response?.data?.error?.message || err?.message;
        try {
          db.prepare(
            `INSERT INTO auto_reply_log (page_id, kind, fb_id, original_text, reply_text, status, error, created_at)
             VALUES (?, 'message', ?, ?, '', 'failed', ?, ?)`
          ).run(page.id, latest.id, messageText, msg, Date.now());
        } catch {}
        console.error(`[auto-reply] ❌ Message ${latest.id}: ${msg}`);
      }
    }
  } catch (err: any) {
    console.error(`[auto-reply] Fetch messages ${page.name}:`, err?.response?.data?.error?.message || err.message);
  }
}

/** Send a message to a Facebook user via Messenger */
export async function sendFBMessage(accessToken: string, recipientId: string, text: string) {
  await axios.post(
    `${GRAPH}/me/messages`,
    {
      recipient: { id: recipientId },
      message: { text },
      messaging_type: 'RESPONSE',
    },
    {
      params: { access_token: accessToken },
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    }
  );
}

/**
 * Send a FB message to a sender using the first available page token.
 * Used by Telegram commands to send booking confirmations.
 */
export async function sendFBMessageToSender(senderId: string, text: string) {
  const page = db.prepare(`SELECT access_token FROM pages LIMIT 1`).get() as { access_token: string } | undefined;
  if (!page) throw new Error('Chưa có Fanpage nào được cấu hình');
  await sendFBMessage(page.access_token, senderId, text);
}

/** Send an image to a Facebook user via Messenger */
export async function sendFBImage(accessToken: string, recipientId: string, imageUrl: string) {
  await axios.post(
    `${GRAPH}/me/messages`,
    {
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: 'image',
          payload: { url: imageUrl, is_reusable: true }
        }
      },
      messaging_type: 'RESPONSE',
    },
    {
      params: { access_token: accessToken },
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    }
  );
}

/** Send a gallery (generic template) of room images via Messenger */
export async function sendFBGallery(
  accessToken: string,
  recipientId: string,
  elements: Array<{ title: string; subtitle: string; image_url: string; buttons?: Array<{type: string; title: string; url?: string; payload?: string}> }>
) {
  // FB limits to 10 elements
  const limited = elements.slice(0, 10);
  await axios.post(
    `${GRAPH}/me/messages`,
    {
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: 'template',
          payload: {
            template_type: 'generic',
            elements: limited.map(el => ({
              title: el.title,
              subtitle: el.subtitle,
              image_url: el.image_url,
              buttons: el.buttons || [{ type: 'web_url', title: 'Đặt phòng', url: 'https://sondervn.com' }],
            })),
          },
        },
      },
      messaging_type: 'RESPONSE',
    },
    {
      params: { access_token: accessToken },
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    }
  );
}

export async function runAutoReply() {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.fb_page_id, p.access_token, p.hotel_id,
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
