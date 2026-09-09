import { STUDIO, YOUTUBE } from "@/config/youtube";

/**
 * One table for how every operation retries.
 *
 * WHY THIS EXISTS. photo-publisher learned by Phase 5 that retry rules living
 * in four files quietly disagree, and moved them into one table with the
 * reasoning attached. MU starts there rather than arriving there.
 *
 * The two behaviours at the cap are KEPT DISTINCT, because they are correct
 * rather than accidental:
 *
 *   `backoff` — keep trying, slowly, forever. For failures that fix
 *   themselves: a cover Pausha has not exported yet, a YouTube CDN that has
 *   not surfaced the thumbnail.
 *
 *   `wait-for-human` — stop, alert, and stay stopped until someone acts. For
 *   failures that need a decision: a cover over 2 MB, a video YouTube says
 *   does not exist, a refresh token that no longer works. Retrying those on a
 *   schedule manufactures identical errors and burns quota.
 *
 * The counts come from `src/config/youtube.ts`; this file says what happens
 * when they are reached.
 */

export type Operation = "youtube_finish" | "youtube_verify" | "youtube_grid" | "cover_fetch";

export interface AttemptPolicy {
  /** Consecutive failures before automatic retrying changes behaviour. */
  maxAttempts: number;
  atCap: "backoff" | "wait-for-human";
  /** Delay before the next try, both under the cap (for backoff) and at it. */
  retryMs: number;
  /** What a human does to restart it, in plain words, for the runbook and /status. */
  manualRetry: string;
  /** One line on why this operation's policy is what it is. */
  rationale: string;
}

const MINUTE = 60_000;

export const ATTEMPT_POLICIES: Record<Operation, AttemptPolicy> = {
  youtube_finish: {
    maxAttempts: YOUTUBE.finishAttempts,
    atCap: "wait-for-human",
    retryMs: 15 * MINUTE,
    manualRetry:
      "Fix the cause (usually the cover or the YouTube connection), then set the " +
      "row's state back to pending in the mu.youtube_finish table, or ask Claude Code to.",
    rationale:
      "Three failures at thumbnails.set or captions.insert means YouTube is " +
      "refusing something specific — a video that is not ours, a track that " +
      "already exists, a token gone bad. Each retry costs up to 550 quota units " +
      "and produces the same error until someone reads it.",
  },

  youtube_verify: {
    maxAttempts: YOUTUBE.verifyAttempts,
    atCap: "wait-for-human",
    retryMs: YOUTUBE.verifyRetryMs,
    manualRetry:
      "Open the video in YouTube Studio and check the thumbnail and the caption " +
      "track by eye. If they are right, set the row to done; if not, set it back to pending.",
    rationale:
      "YouTube surfaces a custom thumbnail with a lag, so verification waits " +
      "and re-reads. But it must be able to fail: after two hours of the " +
      "thumbnail not matching, the honest state is 'a human should look', not " +
      "'verified because the set call returned 200'.",
  },

  youtube_grid: {
    maxAttempts: STUDIO.gridAttempts,
    atCap: "wait-for-human",
    retryMs: STUDIO.gridRetryMs,
    manualRetry:
      "Open the video in YouTube Studio and check the Shorts-grid thumbnail by eye. " +
      "If it is right, set grid_thumbnail_verified_at (and the distance) on the row; " +
      "if not, read grid_error, fix the cause, and set grid_attempts back to 0.",
    rationale:
      "The grid slot is set by driving Studio's own page in a browser, and then " +
      "proved by hashing the card the PUBLIC Shorts grid serves. One attempt is an " +
      "upload plus two minutes of polling. Three misses means Studio changed its " +
      "page, the session is bad, or the grid is not taking the image — none of " +
      "which a fourth identical attempt would tell us. A stale session is its own " +
      "alert (studio.session_expired) and does not consume an attempt.",
  },

  cover_fetch: {
    maxAttempts: Number.POSITIVE_INFINITY,
    atCap: "backoff",
    retryMs: YOUTUBE.coverRetryMs,
    manualRetry: "Export cover_<Ep>.jpg into Drive Covers/yt. The next hourly look picks it up.",
    rationale:
      "A missing cover is not an error — Pausha may simply not have produced " +
      "it yet. The row stays pending and is looked at hourly; a warn line on " +
      "/status says so. Nothing alerts, because nothing is broken.",
  },
};

export function policy(operation: Operation): AttemptPolicy {
  return ATTEMPT_POLICIES[operation];
}

/**
 * Whether to try again now, given consecutive failures and when the last one was.
 *
 * `next_attempt_at` on the row is the primary gate (the sweep's query honours
 * it); this is the second opinion for callers that hold the counts in hand.
 */
export function shouldAttempt(
  operation: Operation,
  opts: { attempts: number; lastAttemptAt?: string | Date | null },
): { attempt: boolean; reason: string } {
  const p = policy(operation);

  if (opts.attempts >= p.maxAttempts) {
    if (p.atCap === "wait-for-human") {
      return {
        attempt: false,
        reason: `${p.maxAttempts} attempts — waiting for you. ${p.manualRetry}`,
      };
    }
  }

  const last = opts.lastAttemptAt ? new Date(opts.lastAttemptAt).getTime() : 0;
  const since = Date.now() - last;
  if (last && since < p.retryMs) {
    return {
      attempt: false,
      reason: `backing off, ${Math.round((p.retryMs - since) / MINUTE)} minutes left`,
    };
  }

  return { attempt: true, reason: opts.attempts === 0 ? "first attempt" : "retry window open" };
}

/** ISO timestamp for the next look, per policy. */
export function nextAttemptAt(operation: Operation, from = new Date()): string {
  return new Date(from.getTime() + policy(operation).retryMs).toISOString();
}
