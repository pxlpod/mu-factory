/**
 * Zernio (a.k.a. Late) — MU's scheduling API.
 *
 * MU LAW 1: THIS ACCOUNT ALSO HOLDS CLIENT WORK. The Zernio key can see every
 * profile in the workspace, and the other profiles belong to PXLPOD clients.
 * Every list, analytics or read call this app makes MUST pass `profileId`, and
 * every webhook delivery is checked against the four MU account ids before
 * anything acts on it. A call that reads across profiles is a bug even when it
 * returns the right answer.
 */

export const ZERNIO = {
  /** Same base URL photo-publisher's client uses (confirmed 2026-09-07). */
  baseUrl: "https://zernio.com/api/v1",

  /** MU = the `Default` profile. Id kept alongside the name so a rename cannot move us. */
  profileName: "Default",
  profileId: "6a832a6b4928398841af0647",

  /** The four MU accounts. Anything else is client work: recorded, never acted on. */
  accountIds: {
    tiktok: "6a832dd677555aae01a4a7c2",
    instagram: "6a832dfb77555aae01a4b366",
    youtube: "6a833dde77555aae01a94637",
    facebook: "6a9c71ca77555aae01e1bbb5",
  },

  /**
   * Webhook events we subscribe to. `post.platform.published` is the one that
   * drives the YouTube finisher; the rest are recorded so the log can answer
   * "what did Zernio say" without opening its dashboard.
   */
  webhookEvents: [
    "post.platform.published",
    "post.published",
    "post.failed",
    "post.platform.failed",
    "post.tiktok.url_resolved",
  ],

  /**
   * The poll fallback's window. Webhooks are the primary path; the sweep also
   * lists published YouTube posts this far back so a delivery that never
   * arrived — a deploy mid-flight, a 500, a disabled subscription — is still
   * finished within fifteen minutes of the next tick.
   */
  pollWindowDays: 14,

  /**
   * `GET /posts` query parameters, from the Zernio API reference (checked
   * 2026-09-08 via the docs search): `profileId`, `platform`, `status`,
   * `dateFrom`/`dateTo` (YYYY-MM-DD or ISO 8601), `page`, `limit`. The
   * response ENVELOPE is not documented in the same place, so the client
   * tolerates `posts`, `data` and a bare array.
   */
  listParams: {
    platform: "youtube",
    status: "published",
    pageSize: 50,
    /** Pages walked per sweep. 14 days of Shorts is nowhere near this. */
    maxPages: 5,
  },

  requestTimeoutMs: 30_000,
} as const;

export type ZernioPlatform = keyof typeof ZERNIO.accountIds;

/** Account id → platform, for classifying a webhook's platform block. */
export const MU_ACCOUNT_PLATFORM: Record<string, ZernioPlatform> = Object.fromEntries(
  Object.entries(ZERNIO.accountIds).map(([platform, id]) => [id, platform]),
) as Record<string, ZernioPlatform>;

export function isMuAccount(accountId: string | null | undefined): boolean {
  return Boolean(accountId && accountId in MU_ACCOUNT_PLATFORM);
}
