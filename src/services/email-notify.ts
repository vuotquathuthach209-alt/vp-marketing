/**
 * Email Notify — optional SMTP notifications for booking leads.
 *
 * Config via .env:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 *   NOTIFY_EMAIL_TO (comma-separated admin emails)
 *
 * Silent-skip if SMTP not configured (non-blocking).
 */

import nodemailer from 'nodemailer';
import { db, getSetting } from '../db';

let transporter: nodemailer.Transporter | null = null;
let transporterReady = false;

function getTransporter(): nodemailer.Transporter | null {
  if (transporterReady) return transporter;
  transporterReady = true;

  const host = process.env.SMTP_HOST || getSetting('smtp_host');
  const port = parseInt(process.env.SMTP_PORT || getSetting('smtp_port') || '587', 10);
  const user = process.env.SMTP_USER || getSetting('smtp_user');
  const pass = process.env.SMTP_PASS || getSetting('smtp_pass');

  if (!host || !user || !pass) {
    console.log('[email-notify] SMTP not configured — email notifications disabled');
    return null;
  }

  try {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
    console.log(`[email-notify] SMTP configured: ${host}:${port}`);
    return transporter;
  } catch (e: any) {
    console.warn('[email-notify] createTransport fail:', e?.message);
    return null;
  }
}

export interface BookingEmailPayload {
  name?: string;
  phone?: string;
  email?: string;
  hotel_name?: string;
  room_name?: string;
  checkin?: string;
  checkout?: string;
  nights?: number;
  months?: number;
  guests?: number;
  total?: number;
  sender_id?: string;
}

export async function sendBookingLeadEmail(data: BookingEmailPayload): Promise<boolean> {
  const tx = getTransporter();
  if (!tx) return false;

  const toList = (process.env.NOTIFY_EMAIL_TO || getSetting('notify_email_to') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!toList.length) return false;

  const subject = `🎯 New Booking Lead — ${data.name || 'Unknown'} | ${data.hotel_name || 'Sonder'}`;

  const qty = data.months ? `${data.months} tháng` : `${data.nights || 1} đêm`;
  const datesStr = data.checkin
    ? `${data.checkin}${data.checkout ? ' → ' + data.checkout : ''} (${qty})`
    : qty;

  const html = `
    <div style="font-family: Inter, Arial, sans-serif; max-width: 600px;">
      <h2 style="color: #4f46e5;">🎯 Booking Lead Mới từ Bot</h2>

      <table style="border-collapse: collapse; width: 100%;">
        <tr><td style="padding: 8px; font-weight: bold; color: #64748b;">Khách hàng:</td>
            <td style="padding: 8px;">${escape(data.name || '(chưa có tên)')}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; color: #64748b;">SĐT:</td>
            <td style="padding: 8px;"><a href="tel:${escape(data.phone || '')}">${escape(data.phone || '?')}</a></td></tr>
        ${data.email ? `<tr><td style="padding: 8px; font-weight: bold; color: #64748b;">Email:</td><td style="padding: 8px;">${escape(data.email)}</td></tr>` : ''}
        <tr><td style="padding: 8px; font-weight: bold; color: #64748b;">Chỗ đặt:</td>
            <td style="padding: 8px;">${escape(data.hotel_name || '(chưa chọn)')}</td></tr>
        ${data.room_name ? `<tr><td style="padding: 8px; font-weight: bold; color: #64748b;">Loại phòng:</td><td style="padding: 8px;">${escape(data.room_name)}</td></tr>` : ''}
        <tr><td style="padding: 8px; font-weight: bold; color: #64748b;">Ngày:</td>
            <td style="padding: 8px;">${escape(datesStr)}</td></tr>
        <tr><td style="padding: 8px; font-weight: bold; color: #64748b;">Số khách:</td>
            <td style="padding: 8px;">${data.guests || '?'}</td></tr>
        ${data.total ? `<tr><td style="padding: 8px; font-weight: bold; color: #64748b;">Tổng tạm:</td><td style="padding: 8px; color: #16a34a; font-weight: bold;">${data.total.toLocaleString('vi-VN')} ₫</td></tr>` : ''}
      </table>

      <div style="margin-top: 24px; padding: 16px; background: #fef3c7; border-left: 4px solid #f59e0b;">
        <strong>⏰ Hành động:</strong> Call khách trong <strong>15 phút</strong> để chốt đơn!
      </div>

      <div style="margin-top: 16px; font-size: 12px; color: #94a3b8;">
        Sender: <code>${escape(data.sender_id || '')}</code><br/>
        Admin panel: <a href="https://app.sondervn.com/funnel">app.sondervn.com/funnel</a>
      </div>
    </div>
  `;

  try {
    await tx.sendMail({
      from: process.env.SMTP_FROM || getSetting('smtp_from') || process.env.SMTP_USER || '',
      to: toList.join(', '),
      subject,
      html,
    });
    return true;
  } catch (e: any) {
    console.warn('[email-notify] send fail:', e?.message);
    return false;
  }
}

function escape(s: string): string {
  return String(s || '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] || c));
}
