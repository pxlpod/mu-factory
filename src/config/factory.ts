/**
 * Every id, name and threshold that describes MU itself.
 *
 * NOTHING ELSE IN THE APP HARDCODES A SCHEMA NAME, A BUCKET, A FOLDER NAME, A
 * FILENAME PATTERN OR A PER-RUN CAP. Later phases add to this directory; they
 * do not scatter constants back into the modules that use them. The rule is
 * lifted from photo-publisher, where it kept five phases of tunables findable
 * in one place, and it is the first thing CLAUDE.md asks for (2026-09-08).
 */

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

/**
 * Project `mindless-mu`, ref `bfvrekckhuifncagccqx`. This app has the project
 * to itself but is still pinned to its own schema: a forgotten prefix in a
 * query then errors rather than landing in `public`, and the discipline costs
 * nothing.
 */
export const SUPABASE_PROJECT_REF = "bfvrekckhuifncagccqx" as const;
export const MU_SCHEMA = "mu" as const;

/** Private bucket. Covers mirrored from Drive land here, verified by sha256. */
export const MEDIA_BUCKET = "mu-media" as const;

// ---------------------------------------------------------------------------
// Episodes and files
// ---------------------------------------------------------------------------

/** `Ep000`, `Ep001`, … Three digits, always. */
export const EPISODE_PATTERN = /^Ep\d{3}$/;

/**
 * Filenames as the Mac pipeline writes them. Functions rather than templates
 * so a caller cannot forget the episode or misplace the suffix.
 */
export const FILE_NAMES = {
  final: (ep: string) => `MU_${ep}_FINAL_916.mp4`,
  /** The HEAD bake: cover tile as the first 3 frames. Facebook reels post from this (doc 12, 2026-09-06). */
  finalTikTok: (ep: string) => `MU_${ep}_FINAL_916_tt.mp4`,
  /** The TAIL card variant: TikTok posts from this with `video_cover_timestamp_ms` from its sidecar (doc 12, 2026-09-10). */
  finalTikTokTail: (ep: string) => `MU_${ep}_FINAL_916_tt_tail.mp4`,
  finalTikTokTailSidecar: (ep: string) => `MU_${ep}_FINAL_916_tt_tail.json`,
  coverIg: (ep: string) => `cover_${ep}.png`,
  /** The YouTube thumbnail. YouTube caps custom thumbnails at 2 MB. */
  coverYt: (ep: string) => `cover_${ep}.jpg`,
  coverFb: (ep: string) => `cover_fb_${ep}.png`,
} as const;

/** `media.kind` values, matching the CHECK constraint (widened 2026-10-17). */
export type MediaKind =
  | "final"
  | "final_tt"
  | "final_tt_tail"
  | "cover_ig"
  | "cover_yt"
  | "cover_fb";

/** Which Drive folder each media kind lives in, and its content type. */
export const MEDIA_KINDS: Record<
  MediaKind,
  { folder: keyof typeof DRIVE_FOLDERS; name: (ep: string) => string; contentType: string; retained: boolean }
> = {
  final: { folder: "finals", name: FILE_NAMES.final, contentType: "video/mp4", retained: false },
  final_tt: { folder: "finals", name: FILE_NAMES.finalTikTok, contentType: "video/mp4", retained: false },
  final_tt_tail: { folder: "finals", name: FILE_NAMES.finalTikTokTail, contentType: "video/mp4", retained: false },
  cover_ig: { folder: "coversIg", name: FILE_NAMES.coverIg, contentType: "image/png", retained: true },
  cover_yt: { folder: "coversYt", name: FILE_NAMES.coverYt, contentType: "image/jpeg", retained: true },
  cover_fb: { folder: "coversIg", name: FILE_NAMES.coverFb, contentType: "image/png", retained: true },
};

/**
 * `platform_posts.kind` values, matching the CHECK constraint (widened to
 * `story` in the 2026-09-09 migration). Zernio carries it as
 * `post.metadata.kind`, set by the Mac pipeline when it schedules: `video` is
 * the Short, `text` the Facebook text-lane post, `story` an Instagram or
 * Facebook story. A value not in this list is ignored and the row keeps
 * `video`, so a typo in metadata cannot fail an upsert on a published post.
 */
export const POST_KINDS = ["video", "text", "story"] as const;
export type PostKind = (typeof POST_KINDS)[number];

// ---------------------------------------------------------------------------
// Google Drive
// ---------------------------------------------------------------------------

/**
 * Folder PATHS under `DRIVE_ROOT_FOLDER_ID`, resolved by name segment by
 * segment at run time. Names rather than ids so the folders can be rebuilt in
 * Drive without a redeploy — the same reasoning photo-publisher used for its
 * inbox/processed/failed trio.
 *
 * Phase 1 reads only `coversYt`. The others are named now so the import and
 * backfill scripts, and Phase 2, have one place to look.
 */
export const DRIVE_FOLDERS = {
  coversYt: ["Covers", "yt"],
  coversIg: ["Covers"],
  finals: ["Finals"],
} as const satisfies Record<string, readonly string[]>;

// ---------------------------------------------------------------------------
// The publishing calendar (decisions of record, doc 12)
// ---------------------------------------------------------------------------

/**
 * When each kind of Publishing item posts, in `PUBLISH_TIMEZONE`. Video = the
 * daily 9:16 episode on all four platforms (18:00 ET since launch 2026-08-24);
 * Text = the Facebook text-lane post (09:00 ET since 2026-09-06). Stories ride
 * 10 minutes after the video. The pre-flight check (health) and, from Phase 3,
 * the publish executor both read these; nothing else hardcodes a slot.
 */
export const PUBLISH_TIMEZONE = "America/New_York" as const;
export const PUBLISH_SLOTS = {
  video: { hour: 18, minute: 0 },
  text: { hour: 9, minute: 0 },
  storyDelayMinutes: 10,
} as const;

/**
 * A Queued item whose slot is this close and still has no post ids is a
 * problem a human can still fix — so it is said out loud once (24 h cooldown)
 * rather than discovered as a missed slot. Spec 16 §4.1.
 */
export const PREFLIGHT_WINDOW_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * A `runs` row with no `finished_at` younger than this holds the lock. Older
 * than this and the invocation that opened it is assumed dead (Vercel's hard
 * ceiling for the sweep is 300 s), so the next tick may proceed.
 */
export const RUN_LOCK_WINDOW_MS = 10 * 60 * 1000;

/** Storage object path for a mirrored cover. */
export function coverStoragePath(kind: "cover_yt", ep: string): string {
  return mediaStoragePath(kind, ep);
}

/**
 * Storage object path for any retained kind. Finals are never retained
 * (`MEDIA_KINDS[kind].retained`), so asking for their path is a bug.
 */
export function mediaStoragePath(kind: MediaKind, ep: string): string {
  switch (kind) {
    case "cover_yt":
      return `covers/yt/${FILE_NAMES.coverYt(ep)}`;
    case "cover_ig":
      return `covers/${FILE_NAMES.coverIg(ep)}`;
    case "cover_fb":
      return `covers/${FILE_NAMES.coverFb(ep)}`;
    default:
      throw new Error(`${kind} is not retained in storage; it has no path.`);
  }
}

/** Event `area` values — how `/status` groups the log. */
export type EventArea =
  | "webhook"
  | "poll"
  | "finish"
  | "verify"
  | "grid"
  | "cover"
  | "health"
  | "import"
  | "auth"
  /** Writes to the Monday boards that reflect automatic actions (spec 16 §6). */
  | "board"
  /** The publish executor: hand-offs to Zernio, cancels, the needs-files gate (spec 16 §4). */
  | "publish";
