/**
 * Monday.com — the human control surface.
 *
 * MONDAY IS WHERE PAUSHA LOOKS AND POSTGRES IS THE RECORD. Phase 1 reads the
 * Publishing board to find an episode's item and sends notifications to it;
 * it writes no column. Every board id and column id lives here so the health
 * check can walk this object and say which one has drifted — a write to a
 * column that no longer exists is accepted by the API and keeps nothing.
 *
 * ALERTS ARE MONDAY NOTIFICATIONS (`create_notification`), aimed at
 * the episode's Publishing item when known, else at the fallback item below.
 */

export const MONDAY = {
  api: "https://api.monday.com/v2",

  /**
   * NOT PINNED TO AN OLD VERSION. A stale version hides columns, and writes to
   * a hidden column are accepted and keep nothing (photo-publisher, 2026-08-28).
   */
  apiVersion: "2025-10",

  requestTimeoutMs: 30_000,

  boards: {
    publishing: "18426983206",
    videoPerformance: "18428543723",
    production: "18426983492",
    videoLibrary: "18426983202",
    answers: "18426983490",
  },

  /**
   * Publishing board columns. Phase 1 reads EP to find an item. Since
   * 2026-10-17 (migration spec 16, §6) the app also WRITES one column —
   * `factory` — and nothing else: Status stays Pausha's (Review → Queued is her
   * flip; Published is written only by the reconcile phase, on a read-back
   * platform post id). The health check walks this object, so a renamed or
   * deleted column is a red line rather than a silent no-op.
   */
  publishingColumns: {
    date: "date_mm6atprg",
    ep: "text_mm6ac5fn",
    status: "color_mm6at4nb",
    type: "color_mm6xxttp",
    coverStatus: "color_mm6mm3nw",
    ttPostId: "text_mm6aj8ba",
    igPostId: "text_mm6a3qqq",
    ytPostId: "text_mm6avbc9",
    fbPostId: "text_mm6xjhsy",
    /** Output only. Created 2026-10-17 with the six labels below, in this order. */
    factory: "color_mm87a7t3",
  },

  /**
   * Status label INDEXES on the Publishing board (read back from the board
   * 2026-10-17). Written by index, never label — label text is editable.
   */
  publishingStatus: {
    review: 3,
    draft: 7,
    /** Pausha's approval. The only value that authorises a hand-off. */
    queued: 8,
    /** The system's flip, only on a read-back platform post id (reconcile phase). */
    published: 9,
  },
  publishingType: { video: 0, text: 1 },
  coverStatus: { awaitingReview: 0, approved: 1, fixQuestion: 2, noCoverYet: 3 },

  /**
   * The Factory column's labels, by index. Pausha approved the six words on
   * 2026-10-17 ("These are fine"); the words may change on the board, the
   * indexes may not.
   */
  factory: {
    waiting: 0,
    needsFiles: 1,
    queuedInZernio: 2,
    live: 3,
    ytFinished: 4,
    needsYou: 5,
  },

  /** Video Performance board columns. Named now; used from Phase 2. */
  videoPerformanceColumns: {
    ep: "text_mm6m6rng",
    youtubeLink: "link_mm6mnbjs",
    ytPostId: "text_mm6mfkmm",
  },

  /**
   * Notification target type for an item. Monday's enum is `Project` for
   * board items and `Post` for updates; an item is a Project.
   */
  notificationTargetType: "Project",

  /** Env var holding the fallback item id for alerts with no episode. */
  alertFallbackItemEnv: "MONDAY_ALERT_ITEM_ID",
} as const;

export type FactoryLabel = keyof typeof MONDAY.factory;

/**
 * Where an alert lands when no episode item is known. Read lazily: env is
 * never read at module top level in this house, so a missing value shows up
 * as a red line on /status rather than a build-time surprise.
 */
export function alertFallbackItemId(): string | null {
  const value = process.env[MONDAY.alertFallbackItemEnv];
  return value && value.trim() ? value.trim() : null;
}
