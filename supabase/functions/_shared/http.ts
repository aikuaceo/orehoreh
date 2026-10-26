// CORS and JSON helpers shared by the OREH Edge Functions.
const ALLOWED = (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://orehoreh.com,https://www.orehoreh.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

export function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

export function preflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response('ok', { headers: cors(req) }) : null;
}

export function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
  const text = await req.text();
  if (text.length > 20000) throw new HttpError(413, 'too_large');
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch (_) { /* fall through */ }
  throw new HttpError(400, 'bad_json');
}

export function handle(fn: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    const pre = preflight(req);
    if (pre) return pre;
    try {
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError) return json(req, e.status, { error: e.code, message: e.message });
      console.error(e);
      return json(req, 500, { error: 'server_error' });
    }
  };
}

// text the visitor typed: trimmed, control characters removed, length-capped
export function clean(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, '').trim().slice(0, max);
}

export function int(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}
