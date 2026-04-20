/**
 * Smart Cascade — cascade AI providers cho chatbot (task='reply_smart').
 *
 * Thứ tự (đã chốt với user):
 *   1. Gemini 2.5 Flash (free tier 1500 RPD primary)
 *   2. Gemini 2.5 Pro (paid, reasoning tốt hơn khi Flash fail)
 *   3. ChatGPT GPT-4o-mini (OpenAI, khi Gemini family down)
 *   4. Qwen 2.5-7B local (safety net, không bao giờ fail)
 *
 * Claude KHÔNG được gọi ở đây — reserved cho marketing tasks.
 *
 * Return: { text, provider, model, tokens, hops }
 */
import axios from 'axios';
import { config } from '../config';
import { pickKey, getAllKeys, markKeyCooldown } from './keyrotator';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct-q4_K_M';

export type SmartProvider = 'gemini_flash' | 'gemini_pro' | 'chatgpt' | 'qwen';

export interface CascadeResult {
  text: string;
  provider: SmartProvider;
  model: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  hops: number;  // 0 = first try, 3 = final fallback
}

export interface CascadeOpts {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  json?: boolean;  // set responseMimeType=application/json nếu cần
  startFrom?: SmartProvider;  // skip earlier providers
}

// ── Gemini 2.5 Flash ───────────────────────────────────────────────
async function callGeminiFlash(opts: CascadeOpts): Promise<CascadeResult> {
  return callGemini(opts, 'gemini-2.5-flash', 'gemini_flash');
}

async function callGeminiPro(opts: CascadeOpts): Promise<CascadeResult> {
  return callGemini(opts, 'gemini-2.5-pro', 'gemini_pro');
}

async function callGemini(opts: CascadeOpts, model: string, provider: SmartProvider): Promise<CascadeResult> {
  const keys = getAllKeys('google_api_key', process.env.GOOGLE_API_KEY);
  const startKey = pickKey('google_api_key', process.env.GOOGLE_API_KEY);
  const startIdx = Math.max(0, keys.indexOf(startKey));
  let lastErr: any;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[(startIdx + i) % keys.length];
    const t0 = Date.now();
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const genCfg: any = {
        maxOutputTokens: opts.maxTokens || 800,
        temperature: opts.temperature ?? 0.7,
        // Gemini 2.5 Flash có "thinking mode" mặc định tốn 200-800 tokens
        // reasoning, ăn vào maxOutputTokens → output thực tế bị truncate.
        // Disable thinking cho tasks thông thường (Q&A, classify, reply).
        thinkingConfig: { thinkingBudget: 0 },
      };
      if (opts.json) genCfg.responseMimeType = 'application/json';

      const resp = await axios.post(
        url,
        {
          systemInstruction: { parts: [{ text: opts.system }] },
          contents: [{ role: 'user', parts: [{ text: opts.user }] }],
          generationConfig: genCfg,
        },
        { timeout: 30000, headers: { 'Content-Type': 'application/json' } },
      );
      const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error(`${provider}: empty text`);
      const usage = resp.data?.usageMetadata || {};
      return {
        text: String(text).trim(),
        provider, model,
        tokens_in: usage.promptTokenCount || 0,
        tokens_out: usage.candidatesTokenCount || 0,
        latency_ms: Date.now() - t0,
        hops: 0,
      };
    } catch (e: any) {
      lastErr = e;
      const status = e?.response?.status;
      if (status === 429) markKeyCooldown(key);
      if (![401, 403, 404, 429, 500, 503].includes(status)) throw e;
    }
  }
  throw lastErr || new Error(`${provider}: all keys failed`);
}

// ── ChatGPT (OpenAI) ───────────────────────────────────────────────
async function callChatGPT(opts: CascadeOpts): Promise<CascadeResult> {
  const keys = getAllKeys('openai_api_key', process.env.OPENAI_API_KEY);
  if (keys.length === 0) throw new Error('chatgpt: no OPENAI_API_KEY configured');
  const key = pickKey('openai_api_key', process.env.OPENAI_API_KEY);
  if (!key) throw new Error('chatgpt: no OPENAI_API_KEY configured');
  const t0 = Date.now();

  const model = 'gpt-4o-mini';
  try {
    const body: any = {
      model,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      max_tokens: opts.maxTokens || 800,
      temperature: opts.temperature ?? 0.7,
    };
    if (opts.json) body.response_format = { type: 'json_object' };

    const resp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      body,
      {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
        },
      },
    );
    const text = resp.data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('chatgpt: empty text');
    return {
      text: String(text).trim(),
      provider: 'chatgpt',
      model,
      tokens_in: resp.data?.usage?.prompt_tokens || 0,
      tokens_out: resp.data?.usage?.completion_tokens || 0,
      latency_ms: Date.now() - t0,
      hops: 0,
    };
  } catch (e: any) {
    const status = e?.response?.status;
    if (status === 429) markKeyCooldown(key);
    throw e;
  }
}

// ── Qwen local (safety net) ────────────────────────────────────────
async function callQwen(opts: CascadeOpts): Promise<CascadeResult> {
  const t0 = Date.now();
  const resp = await axios.post(
    `${OLLAMA_HOST}/api/chat`,
    {
      model: OLLAMA_MODEL,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      stream: false,
      options: {
        num_predict: opts.maxTokens || 500,
        temperature: opts.temperature ?? 0.5,
      },
    },
    { timeout: 60000, headers: { 'Content-Type': 'application/json' } },
  );
  const text = resp.data?.message?.content;
  if (!text) throw new Error('qwen: empty text');
  return {
    text: String(text).trim(),
    provider: 'qwen',
    model: OLLAMA_MODEL,
    tokens_in: resp.data?.prompt_eval_count || 0,
    tokens_out: resp.data?.eval_count || 0,
    latency_ms: Date.now() - t0,
    hops: 0,
  };
}

// ── Cascade orchestrator ───────────────────────────────────────────
const CASCADE_ORDER: SmartProvider[] = ['gemini_flash', 'gemini_pro', 'chatgpt', 'qwen'];

async function tryProvider(provider: SmartProvider, opts: CascadeOpts): Promise<CascadeResult> {
  switch (provider) {
    case 'gemini_flash': return callGeminiFlash(opts);
    case 'gemini_pro':   return callGeminiPro(opts);
    case 'chatgpt':      return callChatGPT(opts);
    case 'qwen':         return callQwen(opts);
  }
}

export async function smartCascade(opts: CascadeOpts): Promise<CascadeResult> {
  const startIdx = opts.startFrom ? CASCADE_ORDER.indexOf(opts.startFrom) : 0;
  const errors: Array<{ provider: string; error: string }> = [];

  for (let hop = Math.max(0, startIdx); hop < CASCADE_ORDER.length; hop++) {
    const provider = CASCADE_ORDER[hop];
    try {
      const result = await tryProvider(provider, opts);
      result.hops = hop - startIdx;
      if (hop > startIdx) {
        console.log(`[cascade] fallback: ${errors.map(e => e.provider).join('→')} → ${provider} OK after ${hop - startIdx} hops`);
      }
      return result;
    } catch (e: any) {
      errors.push({ provider, error: (e?.message || String(e)).slice(0, 200) });
      console.warn(`[cascade] ${provider} fail:`, e?.message);
      // Continue to next in cascade
    }
  }
  // All failed
  throw new Error(`cascade exhausted: ${JSON.stringify(errors)}`);
}

/** Test cascade health */
export async function cascadeHealthCheck(): Promise<Record<SmartProvider, boolean>> {
  const result: Record<SmartProvider, boolean> = {
    gemini_flash: false,
    gemini_pro: false,
    chatgpt: false,
    qwen: false,
  };
  for (const p of CASCADE_ORDER) {
    try {
      await tryProvider(p, { system: 'Reply "OK" only.', user: 'ping', maxTokens: 10 });
      result[p] = true;
    } catch {}
  }
  return result;
}
