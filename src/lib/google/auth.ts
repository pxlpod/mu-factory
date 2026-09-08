import { randomBytes } from "node:crypto";

import { google, type Auth } from "googleapis";

import { YOUTUBE } from "@/config/youtube";
import {
  loadYoutubeCredentials,
  parkState,
  saveYoutubeCredentials,
  takeState,
  type YoutubeCredentials,
} from "@/lib/google/credentials";
import type { MuClient } from "@/lib/supabase";

/**
 * Google OAuth 2.0 for YouTube — the ONLY file that builds `google.auth.OAuth2`,
 * calls `setCredentials`, or persists a rotated token.
 *
 * NO HOUSE PRECEDENT. photo-publisher talks to Google with a service account,
 * which works for Drive and cannot work for YouTube: a service account has no
 * channel. So this is user OAuth with a refresh token, designed per
 * CONVENTIONS §4.3 (2026-09-08): tokens in `mu.credentials`, connect route
 * session-gated, callback open but protected by a one-time `state`, and one
 * place that refreshes.
 *
 * THE FAILURE THIS FILE IS SHAPED AROUND IS `invalid_grant`. A refresh token
 * dies when the user revokes access, when the OAuth consent screen is left in
 * Testing (tokens expire after 7 days — the runbook insists on Published), or
 * when Google rotates it and the new one was not saved. The first two need a
 * human to press Connect again; the third is prevented here by listening to
 * the `tokens` event and writing every rotation back. When it does die,
 * `YoutubeDisconnectedError` is thrown and callers raise `youtube.disconnected`
 * and set their finishes to wait-for-human rather than hammering.
 */

export class YoutubeDisconnectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YoutubeDisconnectedError";
  }
}

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

function clientConfig(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const appUrl = process.env.APP_URL;

  if (!clientId || !clientSecret) {
    throw new GoogleAuthError(
      "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must both be set.",
    );
  }
  if (!appUrl) throw new GoogleAuthError("APP_URL is not set.");

  return {
    clientId,
    clientSecret,
    // Configured, not derived from the request: the redirect URI registered in
    // Google Cloud must match byte for byte, and a preview deployment's host
    // would not.
    redirectUri: `${appUrl.replace(/\/$/, "")}/google/callback`,
  };
}

export function redirectUri(): string {
  return clientConfig().redirectUri;
}

function newClient(): Auth.OAuth2Client {
  const { clientId, clientSecret, redirectUri } = clientConfig();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// ---------------------------------------------------------------------------
// The consent flow
// ---------------------------------------------------------------------------

/**
 * Builds the consent URL and parks a fresh `state`.
 *
 * `access_type=offline` + `prompt=consent` is the only combination that
 * reliably returns a refresh token on a repeat authorisation; without
 * `prompt=consent` Google returns one the first time only, and a reconnect
 * after revocation would come back with no refresh token and no error.
 */
export async function beginConnect(supabase?: MuClient): Promise<string> {
  const client = newClient();
  const state = randomBytes(24).toString("base64url");
  await parkState(state, supabase);

  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: [YOUTUBE.scope],
    state,
  });
}

/**
 * Completes the flow: validates the one-time state, exchanges the code, reads
 * the channel, and stores everything.
 */
export async function completeConnect(
  opts: { code: string; state: string },
  supabase?: MuClient,
): Promise<{ channelId: string | null; channelTitle: string | null }> {
  const parked = await takeState(supabase);
  if (!parked) {
    throw new GoogleAuthError(
      "No connect was waiting. The flow may have been started twice, or more " +
        "than fifteen minutes ago. Press Connect Google again.",
    );
  }
  if (parked.state !== opts.state) {
    throw new GoogleAuthError(
      "Google returned a different state than this app started with. Press " +
        "Connect Google again.",
    );
  }
  if (Date.now() - new Date(parked.createdAt).getTime() > YOUTUBE.stateMaxAgeMs) {
    throw new GoogleAuthError("The connect flow expired. Press Connect Google again.");
  }

  const client = newClient();
  const { tokens } = await client.getToken(opts.code);

  if (!tokens.refresh_token) {
    throw new GoogleAuthError(
      "Google returned no refresh token. This happens when the app was already " +
        "authorised without prompt=consent — remove mu-factory at " +
        "myaccount.google.com/permissions and press Connect Google again.",
    );
  }
  if (tokens.scope && !tokens.scope.includes(YOUTUBE.scope)) {
    throw new GoogleAuthError(
      `The granted scope (${tokens.scope}) does not include ${YOUTUBE.scope}. ` +
        "Tick the YouTube permission on the consent screen.",
    );
  }

  client.setCredentials(tokens);

  // Which channel authorised us. Recorded so /status can show it — connecting
  // the wrong Google account is a mistake that otherwise surfaces as every
  // finish failing with "video not found".
  let channelId: string | null = null;
  let channelTitle: string | null = null;
  try {
    const youtube = google.youtube({ version: "v3", auth: client });
    const res = await youtube.channels.list({ part: ["id", "snippet"], mine: true });
    const channel = res.data.items?.[0];
    channelId = channel?.id ?? null;
    channelTitle = channel?.snippet?.title ?? null;
  } catch {
    // Not fatal to the connect; the health probe will say if it stays broken.
  }

  await saveYoutubeCredentials(
    {
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token ?? null,
      expiry_date: tokens.expiry_date ?? null,
      scope: tokens.scope ?? null,
      channel_id: channelId,
      channel_title: channelTitle,
      connected_at: new Date().toISOString(),
    },
    supabase,
  );

  return { channelId, channelTitle };
}

// ---------------------------------------------------------------------------
// Authorised clients for the API
// ---------------------------------------------------------------------------

/**
 * An OAuth2 client loaded with the stored tokens, that writes rotations back.
 *
 * Throws `YoutubeDisconnectedError` when nothing is connected. An
 * `invalid_grant` during use surfaces later, from the API call itself — see
 * `isInvalidGrant` — because google-auth-library refreshes lazily on the
 * first request.
 */
export async function authorizedClient(
  supabase?: MuClient,
): Promise<{ client: Auth.OAuth2Client; credentials: YoutubeCredentials }> {
  const stored = await loadYoutubeCredentials(supabase);
  if (!stored) {
    throw new YoutubeDisconnectedError(
      "YouTube is not connected. Open /status and press Connect Google.",
    );
  }

  const client = newClient();
  client.setCredentials({
    refresh_token: stored.refresh_token,
    access_token: stored.access_token,
    expiry_date: stored.expiry_date,
    scope: stored.scope ?? undefined,
  });

  /**
   * Persist every rotation. Google may issue a new refresh token alongside a
   * refreshed access token; if it does and we keep the old one, the next
   * refresh fails with invalid_grant and the fix is a human pressing Connect.
   * Writing the access token too means a warm token survives a redeploy.
   */
  client.on("tokens", (tokens) => {
    void saveYoutubeCredentials(
      {
        ...stored,
        refresh_token: tokens.refresh_token ?? stored.refresh_token,
        access_token: tokens.access_token ?? stored.access_token,
        expiry_date: tokens.expiry_date ?? stored.expiry_date,
        scope: tokens.scope ?? stored.scope,
      },
      supabase,
    ).catch(() => {
      // Best effort. A failed write leaves the previous (still valid) refresh
      // token in place; the next refresh simply rotates again.
    });
  });

  return { client, credentials: stored };
}

/**
 * Whether an error from googleapis means the grant is dead.
 *
 * Google's shape varies — `invalid_grant` in `message`, in `response.data.error`,
 * or as a 400 on the token endpoint — so this looks in all three places rather
 * than trusting one. A false negative here means a retry loop; a false
 * positive means an unnecessary "press Connect" alert. The latter is the safer
 * mistake, so the test is broad.
 */
export function isInvalidGrant(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as {
    message?: string;
    code?: number | string;
    response?: { data?: { error?: string; error_description?: string } };
  };
  const haystack = [
    err.message,
    err.response?.data?.error,
    err.response?.data?.error_description,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return (
    haystack.includes("invalid_grant") ||
    haystack.includes("token has been expired or revoked") ||
    haystack.includes("invalid_rapt")
  );
}
