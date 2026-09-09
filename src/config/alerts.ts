/**
 * What is worth interrupting a human for, and how often.
 *
 * GOVERNING RULE: ALERT ON DECISIONS, NOT ON ACTIVITY. A finished video is not
 * an alert. A video that could not be finished after three tries, a cover over
 * YouTube's size cap, a YouTube token that no longer works, a cron that went
 * quiet — those are. Each condition is raised once, repeated no more often
 * than the cooldown while it persists, and cleared with one resolve message.
 * A notification stream that reports work is one nobody reads (photo-publisher
 * Phase 5, carried over 2026-09-08).
 *
 * Alerts go out as Monday notifications. There is no other channel.
 */

export const ALERTS = {
  /** A condition still true tomorrow is still one condition. */
  cooldownHours: 24,

  /**
   * The sweep runs every 15 minutes; 45 covers a slow tick, a deploy and a
   * Vercel hiccup without crying wolf. Only routes that have EVER beaten are
   * judged, so a fresh deploy does not alert on a cron that has not fired yet.
   */
  cronDeadMinutes: 45,

  /** Rows kept in the log tables. `platform_posts` and `episodes` are never pruned. */
  retentionDays: {
    events: 60,
    webhookEvents: 60,
  },
} as const;

/**
 * The condition families. The key appends the specific subject — an episode,
 * a video id, a Zernio post id — so two videos stuck are two conditions and
 * one video stuck twice is one.
 */
export const ALERT_CONDITIONS = {
  /** The YouTube refresh token no longer works. Press Connect Google. */
  youtubeDisconnected: "youtube.disconnected",
  /** A YouTube post published with no resolvable episode. */
  youtubeUnknownEpisode: "youtube.unknown_episode",
  /** Three finish attempts failed. */
  youtubeFinishStuck: "youtube.finish_stuck",
  /** Read-back never confirmed the thumbnail or caption. */
  youtubeVerifyFailed: "youtube.verify_failed",
  /** `cover_<Ep>.jpg` is over YouTube's 2 MB cap. Never re-encoded silently. */
  youtubeCoverTooLarge: "youtube.cover_too_large",
  /** Three Shorts-grid attempts failed, or the grid image never matched. */
  youtubeGridStuck: "youtube.grid_stuck",
  /** The exported Studio session no longer signs in; Studio redirects to accounts.google.com. */
  studioSessionExpired: "studio.session_expired",
  /** Zernio reported a post or platform failure. */
  zernioPostFailed: "zernio.post_failed",
  cronDead: "cron.dead",
  configInvalid: "config.invalid",
} as const;

export type AlertCondition =
  (typeof ALERT_CONDITIONS)[keyof typeof ALERT_CONDITIONS];
