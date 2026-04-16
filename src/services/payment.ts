import crypto from 'crypto';
import { config } from '../config';

/**
 * Payment Service — VNPay & MoMo integration
 *
 * VNPay: redirect-based payment (phổ biến nhất VN)
 * MoMo: QR / app-based payment
 */

// ============ VNPay ============

interface VnpayParams {
  orderId: string;
  amount: number;       // VND
  orderInfo: string;
  ipAddr: string;
  locale?: string;
}

export function createVnpayUrl(params: VnpayParams): string {
  const { orderId, amount, orderInfo, ipAddr, locale = 'vn' } = params;
  const date = new Date();
  const createDate = formatVnpDate(date);
  const expireDate = formatVnpDate(new Date(date.getTime() + 15 * 60000)); // 15 min

  const vnpParams: Record<string, string> = {
    vnp_Version: '2.1.0',
    vnp_Command: 'pay',
    vnp_TmnCode: config.vnpTmnCode,
    vnp_Locale: locale,
    vnp_CurrCode: 'VND',
    vnp_TxnRef: orderId,
    vnp_OrderInfo: orderInfo,
    vnp_OrderType: 'other',
    vnp_Amount: String(amount * 100), // VNPay expects amount * 100
    vnp_ReturnUrl: config.vnpReturnUrl,
    vnp_IpAddr: ipAddr,
    vnp_CreateDate: createDate,
    vnp_ExpireDate: expireDate,
  };

  // Sort params and create hash
  const sortedKeys = Object.keys(vnpParams).sort();
  const queryString = sortedKeys.map(k => `${k}=${encodeURIComponent(vnpParams[k])}`).join('&');
  const hmac = crypto.createHmac('sha512', config.vnpHashSecret);
  const signed = hmac.update(Buffer.from(queryString, 'utf-8')).digest('hex');

  return `${config.vnpUrl}?${queryString}&vnp_SecureHash=${signed}`;
}

export function verifyVnpayReturn(query: Record<string, string>): { valid: boolean; orderId: string; responseCode: string; amount: number } {
  const secureHash = query.vnp_SecureHash;
  const params = { ...query };
  delete params.vnp_SecureHash;
  delete params.vnp_SecureHashType;

  const sortedKeys = Object.keys(params).sort();
  const queryString = sortedKeys.map(k => `${k}=${encodeURIComponent(params[k])}`).join('&');
  const hmac = crypto.createHmac('sha512', config.vnpHashSecret);
  const signed = hmac.update(Buffer.from(queryString, 'utf-8')).digest('hex');

  return {
    valid: signed === secureHash,
    orderId: query.vnp_TxnRef || '',
    responseCode: query.vnp_ResponseCode || '',
    amount: parseInt(query.vnp_Amount || '0') / 100,
  };
}

function formatVnpDate(d: Date): string {
  return d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0') +
    String(d.getHours()).padStart(2, '0') +
    String(d.getMinutes()).padStart(2, '0') +
    String(d.getSeconds()).padStart(2, '0');
}

// ============ MoMo ============

interface MomoParams {
  orderId: string;
  amount: number;
  orderInfo: string;
}

export async function createMomoPayment(params: MomoParams): Promise<{ payUrl: string; qrCodeUrl: string; deeplink: string }> {
  const { orderId, amount, orderInfo } = params;
  const requestId = `REQ_${Date.now()}`;
  const extraData = '';

  // Create signature
  const rawSignature = `accessKey=${config.momoAccessKey}&amount=${amount}&extraData=${extraData}&ipnUrl=${config.momoIpnUrl}&orderId=${orderId}&orderInfo=${orderInfo}&partnerCode=${config.momoPartnerCode}&redirectUrl=${config.momoReturnUrl}&requestId=${requestId}&requestType=payWithMethod`;
  const signature = crypto.createHmac('sha256', config.momoSecretKey).update(rawSignature).digest('hex');

  const body = {
    partnerCode: config.momoPartnerCode,
    partnerName: 'VP Marketing',
    storeId: 'VPMarketing',
    requestId,
    amount,
    orderId,
    orderInfo,
    redirectUrl: config.momoReturnUrl,
    ipnUrl: config.momoIpnUrl,
    lang: 'vi',
    requestType: 'payWithMethod',
    autoCapture: true,
    extraData,
    signature,
  };

  const res = await fetch(config.momoEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await res.json() as any;
  if (data.resultCode !== 0) {
    throw new Error(`MoMo error: ${data.message || data.resultCode}`);
  }

  return {
    payUrl: data.payUrl || '',
    qrCodeUrl: data.qrCodeUrl || '',
    deeplink: data.deeplink || '',
  };
}

export function verifyMomoIpn(body: Record<string, any>): { valid: boolean; orderId: string; resultCode: number } {
  const { orderId, resultCode, amount, extraData, message, orderInfo, orderType, partnerCode, requestId, responseTime, transId } = body;
  const rawSignature = `accessKey=${config.momoAccessKey}&amount=${amount}&extraData=${extraData}&message=${message}&orderId=${orderId}&orderInfo=${orderInfo}&orderType=${orderType}&partnerCode=${partnerCode}&payType=${body.payType}&requestId=${requestId}&responseTime=${responseTime}&resultCode=${resultCode}&transId=${transId}`;
  const signature = crypto.createHmac('sha256', config.momoSecretKey).update(rawSignature).digest('hex');

  return {
    valid: signature === body.signature,
    orderId: orderId || '',
    resultCode: resultCode || -1,
  };
}

// ============ Order helpers ============

export function generateOrderId(hotelId: number, plan: string): string {
  return `VPM_${hotelId}_${plan}_${Date.now()}`;
}

export function parseOrderId(orderId: string): { hotelId: number; plan: string } | null {
  const parts = orderId.split('_');
  if (parts.length < 4 || parts[0] !== 'VPM') return null;
  return { hotelId: parseInt(parts[1]), plan: parts[2] };
}
