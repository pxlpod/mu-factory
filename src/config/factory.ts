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
  finalTikTok: (ep: string) => `MU_${ep}_FINAL_916_tt.mp4`,
  coverIg: (ep: string) => `cover_${ep}.png`,
  /** The YouTube thumbnail. YouTube caps custom thumbnails at 2 MB. */
  coverYt: (ep: string) => `cover_${ep}.jpg`,
  coverFb: (ep: string) => `cover_fb_${ep}.png`,
} as const;

/** `media.kind` values, matching the CHECK constraint in the first migration. */
export type MediaKind = "final" | "final_tt" | "cover_ig" | "cover_yt" | "cover_fb";

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
  // Only one kind is mirrored in Phase 1; the signature is deliberately narrow
  // so a future kind has to extend it here rather than invent a path elsewhere.
  return `covers/yt/${FILE_NAMES.coverYt(ep)}`;
}

/** Event `area` values — how `/status` groups the log. */
export type EventArea =
  | "webhook"
  | "poll"
  | "finish"
  | "verify"
  | "cover"
  | "health"
  | "import"
  | "auth";
