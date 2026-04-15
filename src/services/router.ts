import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { pickKey, getAllKeys, countKeys } from './keyrotator';

/**
 * Multi-model Router — tiết kiệm 60-80% chi phí token bằng cách route task
 * đến model rẻ (Gemini Flash, Groq Gemma) cho những việc đơn giản,
 * chỉ dùng Claude Sonnet cho caption chính + reply phức tạp.
 *
 * Providers hỗ trợ:
 * - anthropic  : Claude Sonnet/Haiku (chất lượng cao nhất, tiếng Việt xuất sắc)
 * - google     : Gemini 2.0 Flash (rẻ 40x Sonnet, tiếng Việt rất ổn)
 * - groq       : Gemma/Llama qua Groq (siêu nhanh, gần như miễn phí)
 *
 * Các task:
 * - caption         : viết caption chính (mặc định Claude Sonnet)
 * - image_prompt    : dịch caption → image prompt EN (mặc định Gemini Flash)
 * - classify        : phân loại comment/intent (mặc định Groq Gemma)
 * - reply_simple    : reply comment ngắn (mặc định Claude Haiku)
 * - reply_complex   : reply inbox phức tạp (mặc định Claude Sonnet)
 */

export type TaskType = 'caption' | 'image_prompt' | 'classify' | 'reply_simple' | 'reply_complex';
export type Provider = 'anthropic' | 'google' | 'groq';

interface RouteConfig {
  provider: Provider;
  model: string;
  maxTokens: number;
}

// Mặc định — sẽ đọc override từ bảng settings (key: 'router_config' JSON)
const DEFAULT_ROUTES: Record<TaskType, RouteConfig> = {
  caption:       { provider: 'anthropic', model: 'claude-sonnet-4-6',      maxTokens: 1024 },
  image_prompt:  { provider: 'google',    model: 'gemini-2.0-flash',       maxTokens: 400  },
  classify:      { provider: 'groq',      model: 'gemma2-9b-it',           maxTokens: 100  },
  reply_simple:  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', maxTokens: 400 },
  reply_complex: { provider: 'anthropic', model: 'claude-sonnet-4-6',      maxTokens: 800  },
};

/**
 * Fallback chain: nếu provider chính không có key, tự chuyển sang provider khác.
 * Đảm bảo app vẫn chạy dù user chưa cấu hình Gemini/Groq.
 */
const FALLBACK: Record<Provider, Provider[]> = {
  google:    ['google', 'anthropic', 'groq'],
  groq:      ['groq', 'google', 'anthropic'],
  anthropic: ['anthropic', 'google', 'groq'],
};

function hasKey(provider: Provider): boolean {
  if (provider === 'anthropic') return countKeys('anthropic_api_key', config.anthropicApiKey) > 0;
  if (provider === 'google') return countKeys('google_api_key') > 0;
  if (provider === 'groq') return countKeys('groq_api_key') > 0;
  return false;
}

function resolveRoute(task: TaskType): RouteConfig {
  const route = { ...DEFAULT_ROUTES[task] };
  // Thử provider chính trước, nếu không có key → đi theo fallback chain
  const chain = FALLBACK[route.provider];
  for (const p of chain) {
    if (hasKey(p)) {
      if (p !== route.provider) {
        // Fallback sang provider khác → đổi model tương ứng
        route.provider = p;
        route.model = defaultModelFor(p, task);
      }
      return route;
    }
  }
  throw new Error(`Không có API key nào cấu hình cho task "${task}". Vào Cấu hình để nhập.`);
}

function defaultModelFor(p: Provider, task: TaskType): string {
  if (p === 'anthropic') {
    return task === 'caption' || task === 'reply_complex'
      ? 'claude-sonnet-4-6'
      : 'claude-haiku-4-5-20251001';
  }
  if (p === 'google') return 'gemini-2.0-flash';
  if (p === 'groq') return 'gemma2-9b-it';
  return '';
}

interface GenInput {
  task: TaskType;
  system: string;
  user: string;
}

/**
 * Main entry point — gọi AI theo task type, tự route sang model phù hợp.
 */
export async function generate({ task, system, user }: GenInput): Promise<string> {
  const route = resolveRoute(task);
  console.log(`[router] ${task} → ${route.provider}/${route.model}`);

  switch (route.provider) {
    case 'anthropic':
      return callAnthropic(route, system, user);
    case 'google':
      return callGemini(route, system, user);
    case 'groq':
      return callGroq(route, system, user);
  }
}

// ---------- Anthropic ----------
async function callAnthropic(route: RouteConfig, system: string, user: string): Promise<string> {
  const keys = getAllKeys('anthropic_api_key', config.anthropicApiKey);
  const startKey = pickKey('anthropic_api_key', config.anthropicApiKey);
  const startIdx = keys.indexOf(startKey);

  let lastErr: any;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(startIdx + i) % keys.length];
    try {
      const client = new Anthropic({ apiKey: key });
      const msg = await client.messages.create({
        model: route.model,
        max_tokens: route.maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      });
      const block = msg.content.find((b) => b.type === 'text');
      if (!block || block.type !== 'text') throw new Error('Anthropic: không có text block');
      return block.text.trim();
    } catch (e: any) {
      lastErr = e;
      const status = e?.status || e?.response?.status;
      if (![401, 403, 429, 529].includes(status)) throw e;
      console.warn(`[router/anthropic] key ${key.slice(-6)} lỗi ${status}, thử key kế`);
    }
  }
  throw lastErr;
}

// ---------- Google Gemini ----------
async function callGemini(route: RouteConfig, system: string, user: string): Promise<string> {
  const keys = getAllKeys('google_api_key');
  const startKey = pickKey('google_api_key');
  const startIdx = keys.indexOf(startKey);

  let lastErr: any;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(startIdx + i) % keys.length];
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${route.model}:generateContent?key=${key}`;
      const resp = await axios.post(
        url,
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            maxOutputTokens: route.maxTokens,
            temperature: 0.8,
          },
        },
        { timeout: 60000, headers: { 'Content-Type': 'application/json' } }
      );
      const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Gemini: không có text trả về');
      return String(text).trim();
    } catch (e: any) {
      lastErr = e;
      const status = e?.response?.status;
      if (![401, 403, 429, 500, 503].includes(status)) throw e;
      console.warn(`[router/gemini] key ${key.slice(-6)} lỗi ${status}, thử key kế`);
    }
  }
  throw lastErr;
}

// ---------- Groq (OpenAI-compatible, host Gemma/Llama) ----------
async function callGroq(route: RouteConfig, system: string, user: string): Promise<string> {
  const keys = getAllKeys('groq_api_key');
  const startKey = pickKey('groq_api_key');
  const startIdx = keys.indexOf(startKey);

  let lastErr: any;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(startIdx + i) % keys.length];
    try {
      const resp = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: route.model,
          max_tokens: route.maxTokens,
          temperature: 0.7,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        }
      );
      const text = resp.data?.choices?.[0]?.message?.content;
      if (!text) throw new Error('Groq: không có text trả về');
      return String(text).trim();
    } catch (e: any) {
      lastErr = e;
      const status = e?.response?.status;
      if (![401, 403, 429, 500, 503].includes(status)) throw e;
      console.warn(`[router/groq] key ${key.slice(-6)} lỗi ${status}, thử key kế`);
    }
  }
  throw lastErr;
}

/**
 * Trả về tình trạng router: mỗi task đang route đến provider/model nào
 * (sau khi xử lý fallback dựa trên key nào đang có).
 */
export function getRouterStatus() {
  const tasks: TaskType[] = ['caption', 'image_prompt', 'classify', 'reply_simple', 'reply_complex'];
  const status: Record<string, any> = {};
  for (const t of tasks) {
    try {
      const r = resolveRoute(t);
      status[t] = {
        provider: r.provider,
        model: r.model,
        default: DEFAULT_ROUTES[t].provider === r.provider,
      };
    } catch (e: any) {
      status[t] = { error: e.message };
    }
  }
  return {
    tasks: status,
    providers: {
      anthropic: { configured: hasKey('anthropic'), count: countKeys('anthropic_api_key', config.anthropicApiKey) },
      google:    { configured: hasKey('google'),    count: countKeys('google_api_key') },
      groq:      { configured: hasKey('groq'),      count: countKeys('groq_api_key') },
    },
  };
}
