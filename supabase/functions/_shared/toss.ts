// Toss Payments core API (https://docs.tosspayments.com/reference). The secret key never leaves the server.
const API = 'https://api.tosspayments.com/v1';

function auth(): string {
  const key = Deno.env.get('TOSS_SECRET_KEY');
  if (!key) throw new Error('TOSS_SECRET_KEY is not set');
  return 'Basic ' + btoa(key + ':');
}

export type TossResult = { ok: boolean; status: number; body: Record<string, unknown> };

// Toss asks for a UUID-shaped Idempotency-Key (valid 15 days). Derived from a seed so a retry reuses it.
async function idemKey(seed: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x40; h[8] = (h[8] & 0x3f) | 0x80;
  const x = Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

async function call(method: string, path: string, body?: unknown, idem?: string): Promise<TossResult> {
  const headers: Record<string, string> = { Authorization: auth(), 'Content-Type': 'application/json' };
  if (idem) headers['Idempotency-Key'] = await idemKey(idem);
  const r = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let parsed: Record<string, unknown> = {};
  try { parsed = await r.json(); } catch (_) { /* empty body */ }
  return { ok: r.ok, status: r.status, body: parsed };
}

// 결제 승인: the amount sent here must be the amount stored for this order, never one taken from the browser.
export const confirmPayment = (paymentKey: string, orderId: string, amount: number) =>
  call('POST', '/payments/confirm', { paymentKey, orderId, amount }, 'confirm-' + orderId);

export const getPayment = (paymentKey: string) => call('GET', '/payments/' + encodeURIComponent(paymentKey));

export const cancelPayment = (paymentKey: string, cancelReason: string, idem: string, cancelAmount?: number) =>
  call('POST', '/payments/' + encodeURIComponent(paymentKey) + '/cancel',
    cancelAmount ? { cancelReason, cancelAmount } : { cancelReason }, idem);

// Toss payment status → our order status
export function mapStatus(s: unknown): string | null {
  switch (s) {
    case 'DONE': return 'paid';
    case 'CANCELED': return 'canceled';
    case 'PARTIAL_CANCELED': return 'partial_canceled';
    case 'ABORTED': return 'failed';
    case 'EXPIRED': return 'expired';
    default: return null; // READY, IN_PROGRESS, WAITING_FOR_DEPOSIT: leave as is
  }
}
