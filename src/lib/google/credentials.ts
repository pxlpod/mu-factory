import { YOUTUBE } from "@/config/youtube";
import { createServiceClient, type MuClient } from "@/lib/supabase";

/**
 * YouTube OAuth tokens, in Postgres.
 *
 * IN THE DATABASE RATHER THAN AN ENV VAR, because the token is obtained by
 * pressing Connect Google on /status, not by anyone editing Vercel — and
 * because Google rotates it, so a value pasted into an env var would be stale
 * the first time the refresh token is reissued. Same table and same reasoning
 * as photo-publisher's Flickr tokens (2026-09-08).
 *
 * SERVICE-ROLE ONLY. `mu.credentials` has RLS on with no policy, so nothing
 * but a server route holding the service key can read it. These values are
 * the authority to edit MU's channel; they never reach a browser and never
 * appear in a response body.
 *
 * This file only reads and writes rows. Building the OAuth2 client, calling
 * setCredentials and deciding when to persist a rotated token happens in
 * `auth.ts` and nowhere else.
 */

export interface YoutubeCredentials {
  refresh_token: string;
  access_token: string | null;
  /** Epoch milliseconds, as google-auth-library reports it. */
  expiry_date: number | null;
  scope: string | null;
  channel_id: string | null;
  channel_title: string | null;
  /** When the tokens were last written — the refresh token's own age is what Google cares about. */
  connected_at: string | null;
}

export async function loadYoutubeCredentials(
  supabase?: MuClient,
): Promise<YoutubeCredentials | null> {
  const client = supabase ?? createServiceClient();

  const { data } = await client
    .from("credentials")
    .select("data")
    .eq("provider", YOUTUBE.credentialKeys.youtube)
    .maybeSingle();

  const stored = (data as { data?: Partial<YoutubeCredentials> } | null)?.data;
  if (!stored?.refresh_token) return null;

  return {
    refresh_token: stored.refresh_token,
    access_token: stored.access_token ?? null,
    expiry_date: stored.expiry_date ?? null,
    scope: stored.scope ?? null,
    channel_id: stored.channel_id ?? null,
    channel_title: stored.channel_title ?? null,
    connected_at: stored.connected_at ?? null,
  };
}

export async function saveYoutubeCredentials(
  credentials: YoutubeCredentials,
  supabase?: MuClient,
): Promise<void> {
  const client = supabase ?? createServiceClient();
  await client
    .from("credentials")
    .upsert(
      { provider: YOUTUBE.credentialKeys.youtube, data: credentials as never },
      { onConflict: "provider" },
    );
}

export async function deleteYoutubeCredentials(supabase?: MuClient): Promise<void> {
  const client = supabase ?? createServiceClient();
  await client
    .from("credentials")
    .delete()
    .eq("provider", YOUTUBE.credentialKeys.youtube);
}

/**
 * The OAuth `state`, parked between Connect and the callback.
 *
 * In the database rather than a cookie because the callback arrives from
 * accounts.google.com, and a cookie set on a route in one region is not
 * something to bet a one-time flow on. Overwritten by the next Connect;
 * consumed by the callback.
 */
export async function parkState(state: string, supabase?: MuClient): Promise<void> {
  const client = supabase ?? createServiceClient();
  await client.from("credentials").upsert(
    {
      provider: YOUTUBE.credentialKeys.state,
      data: { state, created_at: new Date().toISOString() } as never,
    },
    { onConflict: "provider" },
  );
}

/** Returns the parked state ONCE and deletes it, or null when nothing is waiting. */
export async function takeState(
  supabase?: MuClient,
): Promise<{ state: string; createdAt: string } | null> {
  const client = supabase ?? createServiceClient();

  const { data } = await client
    .from("credentials")
    .select("data")
    .eq("provider", YOUTUBE.credentialKeys.state)
    .maybeSingle();

  const parked = (data as { data?: { state?: string; created_at?: string } } | null)
    ?.data;
  if (!parked?.state) return null;

  // One use only.
  await client
    .from("credentials")
    .delete()
    .eq("provider", YOUTUBE.credentialKeys.state);

  return { state: parked.state, createdAt: parked.created_at ?? new Date(0).toISOString() };
}
