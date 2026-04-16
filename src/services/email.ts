import nodemailer from 'nodemailer';
import { config } from '../config';
import { db } from '../db';

/**
 * Email Service — gửi email marketing, thông báo, alert
 */

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
    });
  }
  return transporter;
}

// ============ Core send ============

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(opts: EmailOptions): Promise<boolean> {
  if (!config.smtpUser) {
    console.log(`[email] SMTP not configured, skipping: ${opts.subject} → ${opts.to}`);
    return false;
  }
  try {
    await getTransporter().sendMail({
      from: config.smtpFrom,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });
    // Log
    db.prepare(`INSERT INTO email_log (to_email, subject, status, created_at) VALUES (?, ?, 'sent', ?)`)
      .run(opts.to, opts.subject, Date.now());
    return true;
  } catch (e: any) {
    console.error(`[email] Send failed to ${opts.to}:`, e.message);
    db.prepare(`INSERT INTO email_log (to_email, subject, status, error, created_at) VALUES (?, ?, 'failed', ?, ?)`)
      .run(opts.to, opts.subject, e.message, Date.now());
    return false;
  }
}

// ============ Templates ============

export function inviteHotelEmail(hotelName: string, ownerName: string, loginUrl: string): EmailOptions & { to: '' } {
  return {
    to: '',
    subject: `🏨 ${hotelName} - Moi su dung VP Marketing`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h1 style="color:#1e40af">🏨 VP Marketing</h1>
        <p>Xin chao <b>${ownerName}</b>,</p>
        <p>Khach san <b>${hotelName}</b> da duoc kich hoat tren he thong <b>VP Marketing</b> - nen tang marketing tu dong cho khach san.</p>
        <h3>Tinh nang chinh:</h3>
        <ul>
          <li>✍️ Tu dong tao & dang bai Facebook</li>
          <li>🤖 Chatbot AI tra loi tin nhan khach hang</li>
          <li>📊 Phan tich hieu qua marketing</li>
          <li>📱 Thong bao Telegram real-time</li>
          <li>📚 AI hoc tu du lieu khach san cua ban</li>
        </ul>
        <p><a href="${loginUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold">Dang nhap ngay</a></p>
        <p style="color:#64748b;font-size:12px">Ban dang nhan email nay vi khach san cua ban da duoc dang ky tren VP Marketing boi Sonder Vietnam.</p>
      </div>
    `,
  };
}

export function paymentConfirmEmail(hotelName: string, plan: string, amount: number): Omit<EmailOptions, 'to'> {
  return {
    subject: `✅ Thanh toan thanh cong - Plan ${plan.toUpperCase()}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h1 style="color:#22c55e">✅ Thanh toan thanh cong</h1>
        <p>Khach san <b>${hotelName}</b> da nang cap len plan <b>${plan.toUpperCase()}</b>.</p>
        <p>So tien: <b>${amount.toLocaleString()}d</b></p>
        <p>Tat ca tinh nang cua plan moi da duoc kich hoat.</p>
        <p style="color:#64748b;font-size:12px">VP Marketing - Sonder Vietnam</p>
      </div>
    `,
  };
}

export function alertEmail(subject: string, message: string): Omit<EmailOptions, 'to'> {
  return {
    subject: `⚠️ VP Marketing Alert: ${subject}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h1 style="color:#ef4444">⚠️ Alert</h1>
        <p>${message}</p>
        <p style="color:#64748b;font-size:12px">${new Date().toISOString()} - VP Marketing</p>
      </div>
    `,
  };
}

// ============ Bulk invite ============

export async function sendBulkInvites(loginUrl: string): Promise<{ sent: number; failed: number }> {
  // Get all hotels with owner emails that haven't been invited
  const hotels = db.prepare(`
    SELECT h.id, h.name, c.owner_name, c.owner_email
    FROM mkt_hotels h
    LEFT JOIN mkt_hotels_cache c ON c.ota_hotel_id = h.ota_hotel_id
    WHERE h.status IN ('active', 'pending') AND c.owner_email IS NOT NULL AND c.owner_email != ''
    AND c.owner_email NOT IN (SELECT to_email FROM email_log WHERE subject LIKE '%Moi su dung VP Marketing%')
  `).all() as any[];

  let sent = 0, failed = 0;
  for (const hotel of hotels) {
    const template = inviteHotelEmail(hotel.name, hotel.owner_name || 'Anh/Chi', loginUrl);
    const ok = await sendEmail({ ...template, to: hotel.owner_email });
    if (ok) sent++; else failed++;
    // Rate limit: 1 email/2s
    await new Promise(r => setTimeout(r, 2000));
  }
  return { sent, failed };
}

// ============ Alerting ============

export async function sendAlertToAdmin(subject: string, message: string): Promise<void> {
  const adminEmail = config.smtpUser; // Send alerts to SMTP account itself
  if (!adminEmail) return;
  const template = alertEmail(subject, message);
  await sendEmail({ ...template, to: adminEmail });
}

// Check & alert: high error rate, quota exceeded
export async function checkAndAlert(): Promise<void> {
  const hourAgo = Date.now() - 3600000;

  // High error rate
  const errors = db.prepare(`SELECT COUNT(*) as n FROM posts WHERE status = 'failed' AND created_at > ?`).get(hourAgo) as any;
  if (errors.n > 10) {
    await sendAlertToAdmin('High error rate', `${errors.n} bai dang that bai trong 1h qua.`);
  }

  // AI cost spike
  const aiCost = db.prepare(`SELECT SUM(COALESCE(cost, 0)) as total FROM ai_usage_log WHERE created_at > ?`).get(hourAgo) as any;
  if ((aiCost?.total || 0) > 5) { // > $5/hour
    await sendAlertToAdmin('AI cost spike', `Chi phi AI: $${aiCost.total.toFixed(2)} trong 1h qua.`);
  }
}
