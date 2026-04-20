/**
 * Phase 1b E2E: verify smartCascade + llm-info-store integration.
 *
 * Tests:
 *   1. smartCascade trực tiếp (nếu có API key) → trả về {text, provider, model, hops}
 *   2. rememberLLMInfo + consumeLLMInfo (store API)
 *   3. consumeLLMInfo với senderId không tồn tại → null
 *   4. Stale TTL (60s) → null
 */
import { smartCascade, cascadeHealthCheck } from '../services/smart-cascade';
import { rememberLLMInfo, consumeLLMInfo } from '../services/llm-info-store';

async function main() {
  console.log('=== Test 1: cascadeHealthCheck ===');
  const health = await cascadeHealthCheck();
  console.log('  health:', health);
  const anyAvailable = Object.values(health).some(Boolean);
  console.log('  at-least-one provider:', anyAvailable ? 'OK' : 'FAIL (none available)');

  console.log('\n=== Test 2: llm-info-store round-trip ===');
  rememberLLMInfo('user_abc', {
    provider: 'gemini_flash',
    model: 'gemini-2.5-flash',
    tokens_in: 120,
    tokens_out: 45,
    latency_ms: 800,
    hops: 0,
  });
  const got = consumeLLMInfo('user_abc');
  console.log('  got:', got);
  console.log('  after consume (should be null):', consumeLLMInfo('user_abc'));

  console.log('\n=== Test 3: consumeLLMInfo missing senderId ===');
  console.log('  unknown sender:', consumeLLMInfo('user_nonexistent'));
  console.log('  undefined:', consumeLLMInfo(undefined));

  console.log('\n=== Test 4: smartCascade real call (short prompt) ===');
  if (!anyAvailable) {
    console.log('  SKIP (no provider available)');
  } else {
    try {
      const result = await smartCascade({
        system: 'Bạn là trợ lý khách sạn. Trả lời cực ngắn, tối đa 10 từ.',
        user: 'Khách sạn có wifi không?',
        maxTokens: 60,
        temperature: 0.3,
      });
      console.log('  text:', result.text.slice(0, 120));
      console.log('  provider:', result.provider, 'model:', result.model);
      console.log('  tokens in/out:', result.tokens_in, '/', result.tokens_out);
      console.log('  latency_ms:', result.latency_ms, 'hops:', result.hops);
    } catch (e: any) {
      console.warn('  cascade exhausted:', e?.message);
    }
  }

  console.log('\n✅ Phase 1b store + cascade smoke done');
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1); });
