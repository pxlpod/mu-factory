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

  /**
   * Width ÷ height of MU's covers (1620×2880). The verifier cuts this aspect
   * out of the centre of whatever YouTube serves before hashing, because
   * YouTube pads a portrait thumbnail into 16:9 with a blurred copy of itself.
   */
  coverAspect: 9 / 16,
} as const;

/**
 * The Shorts GRID thumbnail — a second, Studio-only slot.
 *
 * PROVEN 2026-09-09 02:50Z: `thumbnails.set` fills only the classic thumbnail
 * (the watch page, search, embeds). The card a viewer sees on the channel's
 * Shorts tab reads a SEPARATE image that YouTube Studio alone can set, served
 * as `https://i.ytimg.com/vi/<videoId>/sardefault.jpg?sqp=…`. The Data API has
 * no call for it. So the grid step drives Studio's own edit page in a headless
 * browser with a signed-in session Christopher exports from his Mac, uploads
 * the same `cover_<Ep>.jpg` bytes, saves — and then, MU LAW 3, loads the PUBLIC
 * Shorts grid as an anonymous viewer, downloads the card image and hashes it
 * against the cover. Nothing here trusts the Save button.
 */
export const STUDIO = {
  /** `mu.credentials.provider` holding the Playwright storageState export. */
  credentialKey: "studio_session",

  /** Studio's edit page for a video; the thumbnail uploader lives here. */
  editUrl: (videoId: string) => `https://studio.youtube.com/video/${videoId}/edit`,
  /** Where a signed-out session lands. Any URL on this host means "expired". */
  signInHost: "accounts.google.com",
  /** The public Shorts grid, read anonymously — what Pausha sees. */
  shortsGridUrl: `https://www.youtube.com/${YOUTUBE.channelHandle}/shorts`,

  /**
   * Selectors observed 2026-09-09. Studio is a Polymer app: the file input is
   * hidden (Playwright's setInputFiles does not care) and the Save button is a
   * custom element whose `disabled` attribute toggles.
   */
  selectors: {
    fileInput: "ytcp-thumbnail-uploader input#file-loader",
    saveButton: "ytcp-button#save",
    /** The card for one Short on the public grid, found by its link. */
    shortCard: (videoId: string) => `a[href*="/shorts/${videoId}"]`,
  },

  /**
   * Studio refuses headless Chrome as "unsupported browser" (the UA carries
   * HeadlessChrome). The session export records the UA it was signed in with
   * and that is what is sent; this is the fallback when it did not.
   */
  fallbackUserAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  viewport: { width: 1440, height: 1000 },

  /** Wall-clock ceilings for the browser. */
  navigationTimeoutMs: 45_000,
  /** The Save button re-enables once Studio has accepted the file. */
  saveEnableTimeoutMs: 60_000,
  /** …and disables again once the save round-trip completes. */
  saveCompleteTimeoutMs: 60_000,
  /** Studio keeps working after Save disables; leaving early loses the upload. */
  saveSettleMs: 8_000,

  /**
   * Verification: poll the public grid this long, this often. The grid image
   * followed a Studio save within about two minutes on 2026-09-09.
   */
  verifyWindowMs: 120_000,
  verifyPollMs: 10_000,
  /** Same rule as the classic slot: the served card must hash within this. */
  gridMaxDistance: YOUTUBE.thumbnailMaxDistance,

  /**
   * Rows per run. One row is a browser launch, a Studio page, an upload and
   * up to two minutes of polling — about three minutes worst case. Two fit the
   * route's 300 s ceiling only when the first verifies fast, so the pass also
   * stops opening rows once fewer than `perRowBudgetMs` remain.
   */
  maxPerRun: 2,
  runBudgetMs: 270_000,
  perRowBudgetMs: 150_000,

  /** Consecutive failed grid attempts before the row waits for a human. */
  gridAttempts: 3,
  gridRetryMs: 15 * 60 * 1000,

  /** Downloading one card image from i.ytimg.com. */
  imageFetchTimeoutMs: 20_000,

  /**
   * Set on the anonymous context so youtube.com serves the grid rather than a
   * consent interstitial when the function happens to run outside the US.
   */
  consentCookie: { name: "SOCS", value: "CAI", domain: ".youtube.com", path: "/" },
} as const;

export type FinishState =
  | "pending"
  | "verify-pending"
  | "done"
  | "wait-for-human"
  | "skipped";
