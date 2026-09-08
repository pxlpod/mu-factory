/**
 * YouTube — the finisher's every tunable.
 *
 * WHY A FINISHER EXISTS. Zernio publishes the Short, and then two things go
 * wrong on YouTube's side that Zernio cannot fix: the auto-generated caption
 * track double-prints over MU's burned-in karaoke captions, and the thumbnail
 * is whatever frame YouTube picked. Until 2026-09-08 a human opened YouTube
 * Studio per video to upload `cover_<Ep>.jpg` and publish a blank caption
 * track. This file holds the constants that automate exactly those two chores
 * and nothing else.
 *
 * MU LAW 3: A VERIFICATION MUST BE ABLE TO FAIL. `thumbnailMaxDistance` and
 * `verifyAttempts` are what make "verified" a fact rather than an echo of a
 * 200 response.
 */

export const YOUTUBE = {
  channelHandle: "@mindless_mu",

  /** The one scope. Read + write on the user's own channel; no upload of video. */
  scope: "https://www.googleapis.com/auth/youtube.force-ssl",

  /** Keys in `mu.credentials`. */
  credentialKeys: {
    youtube: "youtube",
    /** The OAuth `state`, parked between Connect and the callback. */
    state: "google:state",
  },

  /** A parked `state` older than this is refused; press Connect again. */
  stateMaxAgeMs: 15 * 60 * 1000,

  /**
   * Videos finished per sweep.
   *
   * Quota arithmetic (YouTube Data API v3, 10,000 units/day): per video the
   * finisher spends videos.list 1 + captions.list 50 + captions.insert 400 +
   * thumbnails.set 50 + (videos.update 50 when the language is missing), and
   * each verify pass costs videos.list 1 + captions.list 50. Eight a run is a
   * backlog drain, not a steady state — MU publishes about one Short a day.
   */
  maxPerRun: 8,

  /** Consecutive failed finish attempts before the row waits for a human. */
  finishAttempts: 3,

  /**
   * Verify passes before giving up. YouTube can take a while to surface a
   * custom thumbnail into `snippet.thumbnails`; eight passes fifteen minutes
   * apart is two hours of patience before it becomes an alert.
   */
  verifyAttempts: 8,
  verifyRetryMs: 15 * 60 * 1000,

  /** No cover in Drive yet: look again in an hour, quietly. */
  coverRetryMs: 60 * 60 * 1000,

  /**
   * dHash Hamming distance at or under which the thumbnail YouTube serves is
   * accepted as our cover. 64-bit hash; 14 bits allows for YouTube's own
   * re-encode, letterbox trimming and scaling while still rejecting a
   * different frame outright (two unrelated frames land near 32).
   */
  thumbnailMaxDistance: 14,

  /** dHash sample grid: 9 wide × 8 tall greyscale → 64 horizontal gradients. */
  dhash: { width: 9, height: 8 },

  /** YouTube's hard cap on a custom thumbnail. Never re-encode to fit it. */
  thumbnailMaxBytes: 2 * 1024 * 1024,

  /** `snippet.defaultLanguage` must be this before the caption track is right. */
  videoLanguage: "en",

  /** The override track. */
  caption: {
    language: "en",
    name: "English",
    mimeType: "application/x-subrip",
    /**
     * One cue, one braille blank (U+2800), 0 → 1 s. YouTube treats a published
     * standard track in the video's language as authoritative and stops
     * showing the ASR track — so a track that displays nothing is the fix.
     */
    blankSrt: "1\n00:00:00,000 --> 00:00:01,000\n⠀\n\n",
  },

  /** Thumbnail sizes tried in order when verifying. */
  verifyThumbnailKeys: ["maxres", "high"] as const,

  /** Wall-clock ceiling for downloading a thumbnail from YouTube's CDN. */
  thumbnailFetchTimeoutMs: 20_000,

  /** Wall-clock ceiling for the simple-upload thumbnails.set call (≤ 2 MB body). */
  uploadTimeoutMs: 60_000,
} as const;

export type FinishState =
  | "pending"
  | "verify-pending"
  | "done"
  | "wait-for-human"
  | "skipped";
