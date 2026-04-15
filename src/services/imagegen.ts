import { generateImageGoogle, hasGoogleImageKey } from './googleimage';
import { generateImagePollinations } from './pollinations';
import { generateImage as generateImageFal } from './falai';
import { countKeys } from './keyrotator';
import { getSetting } from '../db';
import { config } from '../config';

/**
 * Meta-wrapper: chọn provider gen ảnh tốt nhất hiện có.
 *
 * Thứ tự ưu tiên mặc định:
 *   1) Google Imagen/Nano Banana (nếu google key có quyền — hiện cần paid tier)
 *   2) Pollinations.ai (MIỄN PHÍ 100%, không cần key, dùng ngay)
 *   3) fal.ai Flux schnell (cần balance)
 *
 * Có thể override qua setting `image_provider` = 'google' | 'pollinations' | 'fal' | 'auto'.
 * Nếu provider chính fail → tự động fallback.
 */

export interface ImageGenResult {
  mediaId: number;
  provider: 'google' | 'pollinations' | 'fal';
  model?: string;
}

type Provider = 'google' | 'pollinations' | 'fal';

function getPreferredProvider(): Provider | 'auto' {
  const s = (getSetting('image_provider') || 'auto').toLowerCase() as any;
  if (['google', 'pollinations', 'fal', 'auto'].includes(s)) return s;
  return 'auto';
}

function availableChain(pref: Provider | 'auto'): Provider[] {
  const hasGoogle = hasGoogleImageKey();
  const hasFal = countKeys('fal_api_key', config.falApiKey) > 0;
  const all: Provider[] = [];
  if (hasGoogle) all.push('google');
  all.push('pollinations'); // luôn khả dụng, không cần key
  if (hasFal) all.push('fal');

  if (pref === 'auto') return all;
  // Đẩy provider được chỉ định lên đầu, giữ các provider khác làm fallback
  const preferred = all.filter((p) => p === pref);
  const rest = all.filter((p) => p !== pref);
  return [...preferred, ...rest];
}

export async function generateImageSmart(prompt: string): Promise<ImageGenResult> {
  const pref = getPreferredProvider();
  const chain = availableChain(pref);

  if (chain.length === 0) {
    throw new Error('Không có provider gen ảnh nào khả dụng.');
  }

  const errors: string[] = [];

  for (const provider of chain) {
    try {
      console.log(`[imagegen] thử ${provider}...`);
      if (provider === 'google') {
        const r = await generateImageGoogle(prompt);
        return { mediaId: r.mediaId, provider: 'google', model: r.model };
      }
      if (provider === 'pollinations') {
        const mediaId = await generateImagePollinations(prompt);
        return { mediaId, provider: 'pollinations', model: 'flux' };
      }
      if (provider === 'fal') {
        const mediaId = await generateImageFal(prompt);
        return { mediaId, provider: 'fal', model: 'flux-schnell' };
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      errors.push(`${provider}: ${msg}`);
      console.warn(`[imagegen] ${provider} fail:`, msg);
    }
  }

  throw new Error(`Gen ảnh fail ở tất cả provider:\n${errors.join('\n')}`);
}
