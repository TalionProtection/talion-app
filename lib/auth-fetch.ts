/**
 * Shared helper for attaching a Supabase bearer token to raw fetch/fetchWithTimeout
 * calls. Several backend routes (/alerts, /api/conversations, /dispatch,
 * /api/patrol, /api/messaging) require requireAuth — this fetches a fresh token on
 * every call rather than caching it, since it can expire between calls.
 *
 * Prefer this for any direct fetch()/fetchWithTimeout() call to those prefixes.
 * services/api.ts's axios client already attaches this automatically via an
 * interceptor and doesn't need it.
 */
import { supabase } from '@/lib/auth-context';

export async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}
