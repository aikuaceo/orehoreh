// Admin client: bypasses RLS, so it lives only inside Edge Functions.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { HttpError } from './http.ts';

// Supabase injects the new secret keys as JSON ({"default": "sb_secret_..."}) and, while they last
// (deprecated end of 2026), the legacy service_role JWT. Prefer the new one.
function keyFrom(jsonVar: string, legacyVar: string): string {
  try {
    const v = JSON.parse(Deno.env.get(jsonVar) ?? '{}');
    if (typeof v.default === 'string' && v.default) return v.default;
  } catch (_) { /* not set */ }
  return Deno.env.get(legacyVar) ?? '';
}

export const db = createClient(
  Deno.env.get('SUPABASE_URL')!,
  keyFrom('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false } },
);

// The browser sends the project's public key on `apikey`. It is public, so this only keeps
// stray traffic out; every amount and status is still checked against the database and Toss.
export function requireClientKey(req: Request) {
  const got = req.headers.get('apikey') ?? '';
  let pub: string[] = [];
  try { pub = Object.values(JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}')) as string[]; } catch (_) { /* not set */ }
  const ok = [...pub, Deno.env.get('SUPABASE_ANON_KEY') ?? ''].filter(Boolean);
  if (!got || !ok.includes(got)) throw new HttpError(401, 'bad_api_key');
}

export function todayKST(): string {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
