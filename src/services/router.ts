import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { getSetting } from '../db';
import { pickKey, getAllKeys, countKeys, markKeyCooldown } from './keyrotator';
import { logUsage } from './costtrack';

// AI tier governs the cost/quality trade-off of the fallback cascade
type AiTier = 'free' | 'balanced' | 'premium';
function getAiTier(): AiTier {
  const t = getSetting('ai_tier') || 'balanced';
  return (['free', 'balanced', 'premium'].includes(t) ? t : 'balanced') as AiTier;
}

/**
 * Multi-model Router — tiết kiệm 60-80% chi phí token bằng cách route task
 * đến model rẻ (Gemini Flash, Groq Gemma) cho những việc đơn giản,
 * chỉ dùng Claude Sonnet cho caption chính + reply phức tạp.
 *
 * Providers hỗ trợ:
 * - anthropic  : Claude Sonnet/Haiku (chất lượng cao nhất, tiếng Việt xuất sắc)
 * - google     : Gemini 2.0 Flash (rẻ 40x Sonnet, tiếng Việt rất ổn)
 * - groq       : Gemma/Llama qua Groq (siêu nhanh, gần như miễn phí)
 * - deepseek   : DeepSeek V3/R1 (rẻ, code tốt, tiếng Việt OK)
 * - openai     : GPT-4o/4o-mini (chất lượng cao, đa năng)
 * - mistral    : Mistral Large/Small (EU, nhanh, rẻ)
 *
 * Các task:
 * - caption         : viết caption chính (mặc định Claude Sonnet)
 * - image_prompt    : dịch caption → image prompt EN (mặc định Gemini Flash)
 * - classify        : phân loại comment/intent (mặc định Groq Gemma)
 * - reply_simple    : reply comment ngắn (mặc định Claude Haiku)
 * - reply_complex   : reply inbox phức tạp (mặc định Claude Sonnet)
 */

export type TaskType = 'caption' | 'image_prompt' | 'classify' | 'reply_simple' | 'reply_complex' | 'intent_gateway' | 'reply_qwen';
export type Provider = 'anthropic' | 'google' | 'groq' | 'deepseek' | 'openai' | 'mistral' | 'ollama';

// Ollama local (Qwen 2.5-7B on VPS) — free, no API key
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct-q4_K_M';

interface RouteConfig {
  provider: Provider;
  model: string;
  maxTokens: number;
}

// Mặc định — sẽ đọc override từ bảng settings (key: 'router_config' JSON)
const DEFAULT_ROUTES: Record<TaskType, RouteConfig> = {
  caption:       { provider: 'anthropic', model: 'claude-sonnet-4-6',      maxTokens: 1024 },
  image_prompt:  { provider: 'google',    model: 'gemini-2.5-flash',       maxTokens: 400  },
  classify:      { provider: 'groq',      model: 'gemma2-9b-it',           maxTokens: 100  },
  reply_simple:  { provider: 'groq',      model: 'gemma2-9b-it',           maxTokens: 400  },
  reply_complex: { provider: 'google',    model: 'gemini-2.5-flash',       maxTokens: 600  },
  // v5 cascade:
  intent_gateway:{ provider: 'google',    model: 'gemini-2.5-flash-lite',  maxTokens: 200  },
  reply_qwen:    { provider: 'ollama',    model: OLLAMA_MODEL,              maxTokens: 500  },
};

/**
 * Fallback chain: nếu provider chính không có key, tự chuyển sang provider khác.
 * Đảm bảo app vẫn chạy dù user chưa cấu hình Gemini/Groq.
 */
// FALLBACK chains per AI tier. User picks tier in Settings.
// - free:     chỉ dùng provider miễn phí (Ollama local + Gemini free tier)
// - balanced: + Claude Haiku cho reply phức tạp + OpenAI/DeepSeek fallback (~$15/mo)
// - premium:  ưu tiên Claude Sonnet/Haiku, dùng mọi provider paid
const FALLBACK_BY_TIER: Record<AiTier, Record<Provider, Provider[]>> = {
  free: {
    google:    ['google', 'ollama'],
    ollama:    ['ollama', 'google'],
    anthropic: ['google', 'ollama'],   // downgrade to free
    deepseek:  ['google', 'ollama'],
    openai:    ['google', 'ollama'],
    groq:      ['google', 'ollama'],
    mistral:   ['google', 'ollama'],
  },
  balanced: {
    google:    ['google', 'ollama', 'anthropic', 'deepseek', 'openai'],
    ollama:    ['ollama', 'google', 'anthropic', 'deepseek', 'openai'],
    anthropic: ['anthropic', 'google', 'ollama', 'deepseek', 'openai'],
    deepseek:  ['deepseek', 'google', 'ollama', 'anthropic', 'openai'],
    openai:    ['openai', 'google', 'ollama', 'anthropic', 'deepseek'],
    groq:      ['google', 'ollama', 'anthropic'],
    mistral:   ['google', 'ollama', 'anthropic'],
  },
  premium: {
    anthropic: ['anthropic', 'openai', 'google', 'deepseek', 'ollama'],
    openai:    ['openai', 'anthropic', 'google', 'deepseek', 'ollama'],
    google:    ['google', 'anthropic', 'openai', 'deepseek', 'ollama'],
    deepseek:  ['deepseek', 'anthropic', 'google', 'openai', 'ollama'],
    ollama:    ['ollama', 'anthropic', 'google', 'openai', 'deepseek'],
    groq:      ['anthropic', 'google', 'openai', 'ollama'],
    mistral:   ['anthropic', 'google', 'openai', 'ollama'],
  },
};

function hasKey(provider: Provider): boolean {
  if (provider === 'anthropic') return countKeys('anthropic_api_key', config.anthropicApiKey) > 0;
  if (provider === 'google') return countKeys('google_api_key', process.env.GOOGLE_API_KEY) > 0;
  if (provider === 'groq') return countKeys('groq_api_key', process.env.GROQ_API_KEY) > 0;
  if (provider === 'deepseek') return countKeys('deepseek_api_key') > 0;
  if (provider === 'openai') return countKeys('openai_api_key') > 0;
  if (provider === 'mistral') return countKeys('mistral_api_key') > 0;
  if (provider === 'ollama') return ollamaReady;
  return false;
}

// Ollama readiness — probed at startup + periodically; no key needed
let ollamaReady = false;
async function probeOllama(): Promise<void> {
  try {
    const r = await axios.get(`${OLLAMA_HOST}/api/tags`, { timeout: 3000 });
    ollamaReady = Array.isArray(r.data?.models) && r.data.models.length > 0;
  } catch { ollamaReady = false; }
}
probeOllama();
setInterval(probeOllama, 60_000).unref();

function resolveRoute(task: TaskType): RouteConfig {
  const route = { ...DEFAULT_ROUTES[task] };
  // Thử provider chính trước, nếu không có key → đi theo fallback chain
  // Chain thay đổi theo tier user chọn (free/balanced/premium)
  const tier = getAiTier();
  const chain = FALLBACK_BY_TIER[tier][route.provider] || [route.provider];
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
  if (p === 'google') return 'gemini-2.5-flash';
  if (p === 'groq') return 'gemma2-9b-it';
  if (p === 'deepseek') return task === 'caption' || task === 'reply_complex' ? 'deepseek-chat' : 'deepseek-chat';
  if (p === 'openai') return task === 'caption' || task === 'reply_complex' ? 'gpt-4o' : 'gpt-4o-mini';
  if (p === 'mistral') return task === 'caption' || task === 'reply_complex' ? 'mistral-large-latest' : 'mistral-small-latest';
  if (p === 'ollama') return OLLAMA_MODEL;
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

  try {
    let result: { text: string; inTok: number; outTok: number };
    switch (route.provider) {
      case 'anthropic':
        result = await callAnthropic(route, system, user);
        break;
      case 'google':
        result = await callGemini(route, system, user);
        break;
      case 'groq':
        result = await callGroq(route, system, user);
        break;
      case 'deepseek':
        result = await callDeepSeek(route, system, user);
        break;
      case 'openai':
        result = await callOpenAI(route, system, user);
        break;
      case 'mistral':
        result = await callMistral(route, system, user);
        break;
      case 'ollama':
        result = await callOllama(route, system, user, task);
        break;
    }
    logUsage({
      task,
      provider: route.provider,
      model: route.model,
      input_tokens: result.inTok,
      output_tokens: result.outTok,
      ok: true,
    });
    return result.text;
  } catch (e: any) {
    logUsage({
      task,
      provider: route.provider,
      model: route.model,
      ok: false,
      error: e?.message || String(e),
    });
    throw e;
  }
}

type CallResult = { text: string; inTok: number; outTok: number };

// ---------- Anthropic ----------
async function callAnthropic(route: RouteConfig, system: string, user: string): Promise<CallResult> {
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
      return {
        text: block.text.trim(),
        inTok: msg.usage?.input_tokens || 0,
        outTok: msg.usage?.output_tokens || 0,
      };
    } catch (e: any) {
      lastErr = e;
      const status = e?.status || e?.response?.status;
      if (![401, 403, 429, 529].includes(status)) throw e;
      if (status === 429 || status === 529) markKeyCooldown(key);
      console.warn(`[router/anthropic] key ${key.slice(-6)} lỗi ${status}, thử key kế`);
    }
  }
  throw lastErr;
}

// ---------- Google Gemini ----------
async function callGemini(route: RouteConfig, system: string, user: string): Promise<CallResult> {
  const keys = getAllKeys('google_api_key', process.env.GOOGLE_API_KEY);
  const startKey = pickKey('google_api_key', process.env.GOOGLE_API_KEY);
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
      const usage = resp.data?.usageMetadata || {};
      return {
        text: String(text).trim(),
        inTok: usage.promptTokenCount || 0,
        outTok: usage.candidatesTokenCount || 0,
      };
    } catch (e: any) {
      lastErr = e;
      const status = e?.response?.status;
      if (![401, 403, 404, 429, 500, 503].includes(status)) throw e;
      if (status === 429) markKeyCooldown(key);
      console.warn(`[router/gemini] key ${key.slice(-6)} lỗi ${status} model=${route.model}, thử key kế`);
    }
  }
  throw lastErr;
}

// ---------- Groq (OpenAI-compatible, host Gemma/Llama) ----------
async function callGroq(route: RouteConfig, system: string, user: string): Promise<CallResult> {
  const keys = getAllKeys('groq_api_key', process.env.GROQ_API_KEY);
  const startKey = pickKey('groq_api_key', process.env.GROQ_API_KEY);
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
      const usage = resp.data?.usage || {};
      return {
        text: String(text).trim(),
        inTok: usage.prompt_tokens || 0,
        outTok: usage.completion_tokens || 0,
      };
    } catch (e: any) {
      lastErr = e;
      const status = e?.response?.status;
      if (![401, 403, 429, 500, 503].includes(status)) throw e;
      if (status === 429) markKeyCooldown(key);
      console.warn(`[router/groq] key ${key.slice(-6)} lỗi ${status}, thử key kế`);
    }
  }
  throw lastErr;
}

// ---------- DeepSeek (OpenAI-compatible) ----------
async function callDeepSeek(route: RouteConfig, system: string, user: string): Promise<CallResult> {
  return callOpenAICompatible({
    settingKey: 'deepseek_api_key',
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    route, system, user, providerName: 'deepseek',
  });
}

// ---------- OpenAI ----------
async function callOpenAI(route: RouteConfig, system: string, user: string): Promise<CallResult> {
  return callOpenAICompatible({
    settingKey: 'openai_api_key',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    route, system, user, providerName: 'openai',
  });
}

// ---------- Mistral ----------
async function callMistral(route: RouteConfig, system: string, user: string): Promise<CallResult> {
  return callOpenAICompatible({
    settingKey: 'mistral_api_key',
    baseUrl: 'https://api.mistral.ai/v1/chat/completions',
    route, system, user, providerName: 'mistral',
  });
}

// ---------- Ollama local (Qwen / Llama / etc.) ----------
async function callOllama(route: RouteConfig, system: string, user: string, task?: TaskType): Promise<CallResult> {
  const t0 = Date.now();
  // Task-aware timeout: user-facing chat cần nhanh, background có thể chờ lâu.
  // reply_qwen = hội thoại realtime → 12s. Hết timeout thì throw để fallback sang Gemini.
  const timeoutMs = task === 'reply_qwen' ? 12000 : 60000;
  try {
    const resp = await axios.post(
      `${OLLAMA_HOST}/api/chat`,
      {
        model: route.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        stream: false,
        options: {
          num_predict: route.maxTokens,
          temperature: 0.5,
        },
      },
      { timeout: timeoutMs, headers: { 'Content-Type': 'application/json' } }
    );
    const text = resp.data?.message?.content;
    if (!text) throw new Error('Ollama: không có text trả về');
    console.log(`[router/ollama] ${route.model} ${Date.now() - t0}ms`);
    return {
      text: String(text).trim(),
      inTok: resp.data?.prompt_eval_count || 0,
      outTok: resp.data?.eval_count || 0,
    };
  } catch (e: any) {
    ollamaReady = false; // re-probe next cycle
    throw e;
  }
}

// ---------- Generic OpenAI-compatible caller ----------
async function callOpenAICompatible(opts: {
  settingKey: string; baseUrl: string; route: RouteConfig;
  system: string; user: string; providerName: string;
}): Promise<CallResult> {
  const keys = getAllKeys(opts.settingKey);
  const startKey = pickKey(opts.settingKey);
  const startIdx = keys.indexOf(startKey);

  let lastErr: any;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(startIdx + i) % keys.length];
    try {
      const resp = await axios.post(
        opts.baseUrl,
        {
          model: opts.route.model,
          max_tokens: opts.route.maxTokens,
          temperature: 0.7,
          messages: [
            { role: 'system', content: opts.system },
            { role: 'user', content: opts.user },
          ],
        },
        {
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          timeout: 90000,
        }
      );
      const text = resp.data?.choices?.[0]?.message?.content;
      if (!text) throw new Error(`${opts.providerName}: không có text trả về`);
      const usage = resp.data?.usage || {};
      return {
        text: String(text).trim(),
        inTok: usage.prompt_tokens || 0,
        outTok: usage.completion_tokens || 0,
      };
    } catch (e: any) {
      lastErr = e;
      const status = e?.response?.status;
      if (![401, 403, 429, 500, 503].includes(status)) throw e;
      if (status === 429) markKeyCooldown(key);
      console.warn(`[router/${opts.providerName}] key ${key.slice(-6)} lỗi ${status}, thử key kế`);
    }
  }
  throw lastErr;
}

/**
 * Trả về tình trạng router: mỗi task đang route đến provider/model nào
 * (sau khi xử lý fallback dựa trên key nào đang có).
 */
export function getRouterStatus() {
  const tasks: TaskType[] = ['caption', 'image_prompt', 'classify', 'reply_simple', 'reply_complex', 'intent_gateway', 'reply_qwen'];
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
      google:    { configured: hasKey('google'),    count: countKeys('google_api_key', process.env.GOOGLE_API_KEY) },
      groq:      { configured: hasKey('groq'),      count: countKeys('groq_api_key', process.env.GROQ_API_KEY) },
      deepseek:  { configured: hasKey('deepseek'),  count: countKeys('deepseek_api_key') },
      openai:    { configured: hasKey('openai'),     count: countKeys('openai_api_key') },
      mistral:   { configured: hasKey('mistral'),    count: countKeys('mistral_api_key') },
      ollama:    { configured: hasKey('ollama'),     host: OLLAMA_HOST, model: OLLAMA_MODEL },
    },
  };
}
