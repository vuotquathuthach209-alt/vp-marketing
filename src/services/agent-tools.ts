/**
 * AI Agent Tool Framework — unlock ARPU 10x (Vector C).
 *
 * Architecture:
 *   1. Tool registry: mỗi tool = { name, description, params_schema, handler, industries[] }
 *   2. After ragReply generates text, decideTools() asks Gemini:
 *      "given conversation + draft reply, which tool (if any) to invoke?"
 *      → JSON { tool, params } or null
 *   3. If tool picked → execute handler → append result to reply (+ audit log)
 *
 * Design choices:
 *   - Không dùng native function-calling vì Ollama Qwen không hỗ trợ tốt;
 *     chạy Gemini 1 call riêng với JSON output — nhanh + rẻ + deterministic.
 *   - Handler idempotent where possible (appointments by phone+date).
 *   - Per-tenant: industry gate + hotel.features flag.
 */
import { db } from '../db';
import { generate } from './router';

// ── Schema ──────────────────────────────────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  sender_id TEXT,
  tool TEXT NOT NULL,
  params TEXT,        -- JSON
  result TEXT,        -- JSON
  status TEXT NOT NULL,  -- 'success' | 'fail' | 'skipped'
  error TEXT,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_hotel_ts ON agent_tool_calls(hotel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON agent_tool_calls(tool);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  sender_id TEXT,
  customer_name TEXT,
  phone TEXT,
  service TEXT,
  scheduled_at INTEGER NOT NULL,       -- epoch ms of appointment time
  duration_min INTEGER DEFAULT 60,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | done | cancelled
  source TEXT DEFAULT 'bot',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appts_hotel_ts ON appointments(hotel_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_appts_phone ON appointments(phone);
`);

// ── Types ───────────────────────────────────────────────────────────────
export interface ToolContext {
  hotelId: number;
  senderId?: string;
  senderName?: string;
  industry: string;
  message: string;
  draftReply: string;
  history: Array<{ role: string; message: string }>;
}

export interface ToolResult {
  success: boolean;
  append_to_reply?: string;  // thêm vào cuối reply (ví dụ "Đã đặt lịch lúc 14h ngày mai")
  data?: any;
  error?: string;
}

export interface ToolDef {
  name: string;
  description: string;         // đưa vào prompt cho Gemini decider
  params_schema: string;       // mô tả JSON params
  industries: string[];        // ['spa', 'clinic', 'education'] hoặc ['*']
  handler: (params: any, ctx: ToolContext) => Promise<ToolResult>;
}

// ── Tools ───────────────────────────────────────────────────────────────
const TOOLS: ToolDef[] = [];
export function registerTool(t: ToolDef) { TOOLS.push(t); }

function matchTool(name: string, industry: string): ToolDef | null {
  const t = TOOLS.find(x => x.name === name);
  if (!t) return null;
  if (t.industries.includes('*')) return t;
  if (t.industries.includes(industry)) return t;
  return null;
}

// ── Decider: Gemini chọn tool ───────────────────────────────────────────
async function decideTools(ctx: ToolContext): Promise<{ tool: string; params: any } | null> {
  const availableTools = TOOLS.filter(t => t.industries.includes('*') || t.industries.includes(ctx.industry));
  if (availableTools.length === 0) return null;

  const toolList = availableTools.map(t => `- ${t.name}: ${t.description}\n  params: ${t.params_schema}`).join('\n');

  const historyStr = ctx.history.slice(-6).map(h => `${h.role === 'user' ? 'Khách' : 'Bot'}: ${h.message}`).join('\n');

  const sys = `Bạn là bộ phân loại. Dựa trên hội thoại, quyết định có cần gọi tool nào để thực hiện hành động (đặt lịch, gửi link thanh toán, lưu liên hệ) hay KHÔNG.

Tools khả dụng:
${toolList}

Quy tắc:
- Chỉ chọn tool khi khách RÕ RÀNG muốn hành động (ví dụ: "đặt lịch 2h chiều mai", "gửi link chuyển khoản", "SĐT của em là 0901...").
- Nếu không chắc → trả về null.
- Trả về JSON thuần, không giải thích.

Format:
{"tool":"tool_name","params":{...}}
hoặc
null`;

  const userPrompt = `HỘI THOẠI:\n${historyStr}\nKhách: ${ctx.message}\nBot (draft): ${ctx.draftReply}\n\nQUYẾT ĐỊNH (JSON):`;

  try {
    const raw = await generate({ task: 'classify', system: sys, user: userPrompt });
    const txt = raw.trim();
    if (txt === 'null' || txt.toLowerCase().includes('null')) return null;
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    if (!parsed.tool) return null;
    return { tool: parsed.tool, params: parsed.params || {} };
  } catch (e: any) {
    console.warn('[agent-tools] decide fail:', e?.message);
    return null;
  }
}

// ── Public: run tool pipeline ───────────────────────────────────────────
export async function runAgentTools(ctx: ToolContext): Promise<{ appended: string; tool?: string; result?: ToolResult }> {
  try {
    const decision = await decideTools(ctx);
    if (!decision) return { appended: '' };

    const tool = matchTool(decision.tool, ctx.industry);
    if (!tool) {
      logCall(ctx, decision.tool, decision.params, { success: false, error: 'unknown_or_disabled_tool' }, 'skipped', 0);
      return { appended: '' };
    }

    const t0 = Date.now();
    let result: ToolResult;
    try {
      result = await tool.handler(decision.params, ctx);
    } catch (e: any) {
      result = { success: false, error: e?.message || 'handler_error' };
    }
    const latency = Date.now() - t0;

    logCall(ctx, decision.tool, decision.params, result, result.success ? 'success' : 'fail', latency);

    return {
      appended: result.append_to_reply || '',
      tool: decision.tool,
      result,
    };
  } catch (e: any) {
    console.error('[agent-tools] pipeline error:', e?.message);
    return { appended: '' };
  }
}

function logCall(ctx: ToolContext, tool: string, params: any, result: ToolResult, status: string, latency: number) {
  try {
    db.prepare(
      `INSERT INTO agent_tool_calls (hotel_id, sender_id, tool, params, result, status, error, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      ctx.hotelId,
      ctx.senderId || null,
      tool,
      JSON.stringify(params).slice(0, 2000),
      JSON.stringify(result.data || {}).slice(0, 2000),
      status,
      result.error || null,
      latency,
      Date.now()
    );
  } catch (e: any) { console.error('[agent-tools] log fail:', e?.message); }
}

// ═══════════════════════════════════════════════════════════════════════
// TOOL: capture_contact — lưu SĐT + tên khách
// ═══════════════════════════════════════════════════════════════════════
registerTool({
  name: 'capture_contact',
  description: 'Lưu số điện thoại và tên khách khi khách chủ động để lại. Dùng khi khách nói "SĐT của em là...", "gọi em qua 09xx".',
  params_schema: '{"phone":"0901234567","name":"optional tên khách"}',
  industries: ['*'],
  handler: async (params, ctx) => {
    const phone = String(params.phone || '').replace(/\D/g, '');
    if (!phone || phone.length < 9 || phone.length > 11) {
      return { success: false, error: 'invalid phone' };
    }
    const name = params.name || ctx.senderName || null;
    const now = Date.now();

    try {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS customer_contacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          sender_id TEXT,
          name TEXT,
          phone TEXT NOT NULL,
          source TEXT,
          notes TEXT,
          created_at INTEGER NOT NULL
        )
      `).run();

      const existing = db.prepare(
        `SELECT id FROM customer_contacts WHERE hotel_id = ? AND phone = ? LIMIT 1`
      ).get(ctx.hotelId, phone) as any;

      if (existing) {
        return { success: true, data: { phone, existing: true }, append_to_reply: '' };
      }

      db.prepare(
        `INSERT INTO customer_contacts (hotel_id, sender_id, name, phone, source, notes, created_at)
         VALUES (?, ?, ?, ?, 'bot', ?, ?)`
      ).run(ctx.hotelId, ctx.senderId || null, name, phone, ctx.message.slice(0, 200), now);

      // Notify staff
      try {
        const { notifyAll } = require('./telegram');
        notifyAll(`📞 SĐT mới: ${phone}${name ? ` (${name})` : ''}\nNgành: ${ctx.industry}\nHotel #${ctx.hotelId}`).catch(() => {});
      } catch {}

      return { success: true, data: { phone, name }, append_to_reply: '' };
    } catch (e: any) {
      return { success: false, error: e?.message };
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════
// TOOL: create_appointment — đặt lịch hẹn (spa/clinic/education/restaurant)
// ═══════════════════════════════════════════════════════════════════════
function parseVietnameseDateTime(text: string): number | null {
  // Cơ bản: "14h mai", "15:30 ngày 20/4", "sáng thứ 7"...
  const now = new Date();
  const t = text.toLowerCase();

  // Bắt giờ
  const hourMatch = t.match(/(\d{1,2})(?::(\d{2}))?\s*(h|giờ|:)/);
  let hour = hourMatch ? parseInt(hourMatch[1], 10) : 9;
  let min = hourMatch && hourMatch[2] ? parseInt(hourMatch[2], 10) : 0;
  if (t.includes('chiều') && hour < 12) hour += 12;
  if (t.includes('tối') && hour < 12) hour += 12;

  const result = new Date(now);
  result.setSeconds(0, 0);
  result.setHours(hour, min);

  // Bắt ngày
  if (t.includes('mai') || t.includes('ngày mai')) {
    result.setDate(now.getDate() + 1);
  } else if (t.includes('mốt') || t.includes('kia')) {
    result.setDate(now.getDate() + 2);
  } else {
    const dmy = t.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
    if (dmy) {
      const d = parseInt(dmy[1], 10), m = parseInt(dmy[2], 10);
      const y = dmy[3] ? (parseInt(dmy[3], 10) < 100 ? 2000 + parseInt(dmy[3], 10) : parseInt(dmy[3], 10)) : now.getFullYear();
      result.setFullYear(y, m - 1, d);
    } else if (result.getTime() < now.getTime()) {
      // Nếu giờ đã qua hôm nay → mặc định mai
      result.setDate(now.getDate() + 1);
    }
  }
  return result.getTime();
}

registerTool({
  name: 'create_appointment',
  description: 'Tạo lịch hẹn khi khách muốn đặt lịch (chọn giờ + dịch vụ). Dùng cho spa, clinic, education, restaurant. Ví dụ: "đặt lịch chăm sóc da 2h chiều mai".',
  params_schema: '{"when":"mô tả thời gian (14h mai, 15:00 20/4)","service":"tên dịch vụ","name":"tên khách?","phone":"SĐT?","notes":"ghi chú?"}',
  industries: ['spa', 'clinic', 'education', 'restaurant'],
  handler: async (params, ctx) => {
    const whenText = String(params.when || '').trim();
    if (!whenText) return { success: false, error: 'missing when' };

    const when = parseVietnameseDateTime(whenText);
    if (!when || when < Date.now() - 3600_000) return { success: false, error: 'cannot parse time' };

    const service = String(params.service || 'Tư vấn').slice(0, 100);
    const phone = String(params.phone || '').replace(/\D/g, '') || null;
    const name = params.name || ctx.senderName || null;
    const notes = String(params.notes || '').slice(0, 300);

    const now = Date.now();
    const r = db.prepare(
      `INSERT INTO appointments (hotel_id, sender_id, customer_name, phone, service, scheduled_at, notes, status, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'bot', ?)`
    ).run(ctx.hotelId, ctx.senderId || null, name, phone, service, when, notes, now);

    const dateStr = new Date(when).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });

    try {
      const { notifyAll } = require('./telegram');
      notifyAll(`📅 Lịch hẹn mới #${r.lastInsertRowid}\n${name || 'Khách'} - ${phone || 'no phone'}\nDịch vụ: ${service}\nGiờ: ${dateStr}\nHotel #${ctx.hotelId}`).catch(() => {});
    } catch {}

    return {
      success: true,
      data: { appointment_id: r.lastInsertRowid, scheduled_at: when, service, when: dateStr },
      append_to_reply: `\n\n✅ Đã ghi nhận lịch hẹn: ${service} lúc ${dateStr}. Nhân viên sẽ xác nhận lại trong ít phút ạ!`,
    };
  },
});

// ═══════════════════════════════════════════════════════════════════════
// TOOL: send_payment_link — gửi QR/VietQR + amount + memo
// ═══════════════════════════════════════════════════════════════════════
registerTool({
  name: 'send_payment_link',
  description: 'Tạo QR chuyển khoản khi khách muốn thanh toán / đặt cọc. Sẽ sinh VietQR link với số tiền + nội dung.',
  params_schema: '{"amount":500000,"memo":"Dat coc spa abc"}',
  industries: ['*'],
  handler: async (params, ctx) => {
    const amount = Math.max(10_000, Math.min(50_000_000, parseInt(params.amount, 10) || 0));
    if (!amount) return { success: false, error: 'invalid amount' };
    const memo = String(params.memo || `VPMKT H${ctx.hotelId} ${Date.now().toString(36)}`).slice(0, 80);

    const { getSetting } = require('../db');
    const bin = getSetting('bank_bin');
    const account = getSetting('bank_account');
    const holder = getSetting('bank_holder') || '';
    if (!bin || !account) return { success: false, error: 'bank_not_configured' };

    const url = `https://img.vietqr.io/image/${bin}-${account}-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(memo)}&accountName=${encodeURIComponent(holder)}`;

    return {
      success: true,
      data: { amount, memo, qr_url: url },
      append_to_reply: `\n\n💳 QR chuyển khoản:\n- Số tiền: ${amount.toLocaleString('vi')}đ\n- Nội dung: ${memo}\n- QR: ${url}\n(Hệ thống sẽ tự xác nhận khi tiền về)`,
    };
  },
});

// Exported for smartReply
export function isToolsEnabled(hotelId: number): boolean {
  try {
    const h = db.prepare(`SELECT plan, features FROM mkt_hotels WHERE id = ?`).get(hotelId) as any;
    if (!h) return false;
    // Gói trả phí (starter/pro/enterprise) và free trial mới được dùng agent tools
    if (!['starter', 'pro', 'enterprise', 'free'].includes(h.plan || '')) return false;
    try {
      const f = JSON.parse(h.features || '{}');
      if (f.agent_tools === false) return false;
    } catch {}
    return true;
  } catch { return false; }
}
