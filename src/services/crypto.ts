/**
 * AES-256-GCM encryption cho secrets (access tokens, refresh tokens, app secrets)
 *
 * Format trong DB:  enc:v1:<base64(iv|tag|ciphertext)>
 * Plaintext legacy: không có prefix — decrypt() detect và trả về nguyên.
 *
 * Key: process.env.SECRET_KEY (tối thiểu 32 chars). Nếu thiếu → derive từ
 * JWT_SECRET fallback để không crash, nhưng log cảnh báo.
 */
import crypto from 'crypto';

const PREFIX = 'enc:v1:';

let _key: Buffer | null = null;
function getKey(): Buffer {
  if (_key) return _key;
  const raw = process.env.SECRET_KEY || process.env.JWT_SECRET || '';
  if (!raw || raw.length < 16) {
    console.warn('[crypto] SECRET_KEY missing/short — using weak default. SET IT IN .env!');
  }
  _key = crypto.createHash('sha256').update(raw || 'vp-mkt-default-insecure').digest();
  return _key;
}

export function encrypt(plain: string | null | undefined): string | null {
  if (plain == null || plain === '') return plain as any;
  if (typeof plain === 'string' && plain.startsWith(PREFIX)) return plain; // already encrypted
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

export function decrypt(payload: string | null | undefined): string | null {
  if (payload == null) return null;
  if (typeof payload !== 'string' || !payload.startsWith(PREFIX)) return payload as any; // legacy plaintext
  try {
    const buf = Buffer.from(payload.slice(PREFIX.length), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (e: any) {
    console.error('[crypto] decrypt fail:', e?.message);
    return null;
  }
}

/** Mask for display: giữ 4 đầu, che phần giữa */
export function mask(s: string | null | undefined): string {
  if (!s) return '';
  const p = decrypt(s) || s;
  if (p.length <= 8) return '***';
  return p.slice(0, 4) + '…' + p.slice(-3);
}
