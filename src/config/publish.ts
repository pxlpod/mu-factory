import type { MediaKind } from "@/config/factory";
import type { ZernioPlatform } from "@/config/zernio";

/**
 * The publish executor — every decision of record from the weekly loop,
 * lifted out of `Tools/mu_post.py` (the logic of record until 2026-10-17) and
 * `12_Publishing-Runbook.md`, so the Mac script can retire without a law
 * going with it. Spec: `16_Factory-Migration-Spec.md` §4.
 *
 * WHAT A HAND-OFF IS. A Queued Video item on the Publishing board becomes six
 * Zernio posts (TikTok, Instagram, YouTube, Facebook reel, Instagram story,
 * Facebook story); a Queued Text item becomes one (the Facebook text post).
 * Each post is one `platform_posts` row. Each file is uploaded to Zernio once
 * per episode and shared by the legs that use it.
 */

export const PUBLISH = {
  /**
   * Zernio keeps uploaded media in temporary storage for 7 days and moves it
   * to permanent only when the post publishes. A post handed off further out
   * would arrive at its slot pointing at nothing (photo-publisher, 2026-09-07;
   * doc 12 "temp media expires in ~7 days"). So an item is handed off only
   * once its slot is within this many days, and an upload older than this is
   * redone before a new post is created against it.
   */
  handoffWindowDays: 6,

  /**
   * Episodes handed off per tick. One episode is up to three video uploads of
   * 100–180 MB plus two images inside one invocation; the cron runs every ten
   * minutes, so a week drains in about an hour (decision 3, 2026-10-17:
   * Standard function, one per tick, upgrade only if runs get cut short).
   */
  episodesPerTick: 1,

  /** Cover tiles attached to board items per tick (the §4.6 side-job). */
  coversPerTick: 5,

  /** Wall-clock ceilings. */
  presignTimeoutMs: 30_000,
  uploadTimeoutMs: 240_000,
  /** Stop opening a new leg once fewer than this remain of the route's 300 s. */
  runBudgetMs: 270_000,
  perLegBudgetMs: 45_000,

  /** Consecutive failed hand-off attempts on one leg before it waits for a human. */
  handoffAttempts: 3,
  handoffRetryMs: 10 * 60 * 1000,

  /** Zernio wall clock + zone, exactly as mu_post.py sent it for 50+ posts. */
  timezone: "America/New_York",

  /**
   * Platform settings of record (doc 12, 2026-08-17; AI disclosure ON always —
   * Pausha). `video_made_with_ai` and `containsSyntheticMedia` are REQUIRED
   * and never turned off.
   */
  tiktok: {
    privacy_level: "PUBLIC_TO_EVERYONE",
    allow_comment: true,
    allow_duet: true,
    allow_stitch: true,
    content_preview_confirmed: true,
    express_consent_given: true,
    video_made_with_ai: true,
  },
  youtube: {
    visibility: "public",
    categoryId: "27",
    madeForKids: false,
    containsSyntheticMedia: true,
  },
  facebookReel: { contentType: "reel" },
  story: { contentType: "story" },

  /** YouTube and Facebook titles are capped by the platforms. */
  titleMaxChars: 100,

  /**
   * Facebook has no AI-disclosure flag, so the disclosure is a caption line
   * appended to EVERY Facebook post, idempotently (Pausha 2026-09-05: "Humans
   * are funny about it, best not to appear as though we are trying to hide
   * it"). Never typed into the board caption.
   */
  facebookDisclosure:
    "MU is a digital being. Her words are human; her voice and performance are AI-generated.",

  /** Everything the executor sends carries this, so the webhook can resolve the episode. */
  metadataSource: "mu-factory",
} as const;

/**
 * The legs of a Video item, in hand-off order, each with the file it posts
 * from. TikTok posts the TAIL-card variant with `video_cover_timestamp_ms` at
 * the card (doc 12, 2026-09-10); Facebook the HEAD bake (frame 0 is the tile,
 * 2026-09-06); Instagram and YouTube the untouched FINAL. Stories are the IG
 * cover PNG, 10 minutes after the reel (option 1, 2026-09-08).
 */
export interface LegSpec {
  platform: ZernioPlatform;
  kind: "video" | "story" | "text";
  media: MediaKind;
  mediaType: "video" | "image";
  /** Minutes after the item's slot. */
  offsetMinutes: number;
  /** Files that must exist in Drive before this leg may be handed off, beyond `media`. */
  alsoRequires: MediaKind[];
}

export const VIDEO_LEGS: readonly LegSpec[] = [
  { platform: "tiktok", kind: "video", media: "final_tt_tail", mediaType: "video", offsetMinutes: 0, alsoRequires: [] },
  { platform: "instagram", kind: "video", media: "final", mediaType: "video", offsetMinutes: 0, alsoRequires: ["cover_ig"] },
  // cover_yt is not sent by the executor — the finisher sets it after publish —
  // but the law (doc 12, 2026-09-08) is that it exists BEFORE the Short publishes.
  { platform: "youtube", kind: "video", media: "final", mediaType: "video", offsetMinutes: 0, alsoRequires: ["cover_yt"] },
  { platform: "facebook", kind: "video", media: "final_tt", mediaType: "video", offsetMinutes: 0, alsoRequires: [] },
  { platform: "instagram", kind: "story", media: "cover_ig", mediaType: "image", offsetMinutes: 10, alsoRequires: [] },
  { platform: "facebook", kind: "story", media: "cover_ig", mediaType: "image", offsetMinutes: 10, alsoRequires: [] },
] as const;

export const TEXT_LEGS: readonly LegSpec[] = [
  { platform: "facebook", kind: "text", media: "cover_fb", mediaType: "image", offsetMinutes: 0, alsoRequires: [] },
] as const;

/**
 * The executor's switch. `PUBLISH_EXECUTOR_MODE=live` hands off for real;
 * anything else (including unset) runs every tick as a DRY RUN that plans and
 * writes nothing. Deployed dry on purpose: the first week is proven on /status
 * while `mu_post.py` still queues the real posts, and the switch is flipped
 * in Vercel once a week of plans has matched what the Mac did (spec 16 §8:
 * nothing is retired until its replacement has run clean for a week).
 */
export function executorMode(): "live" | "dry" {
  return process.env.PUBLISH_EXECUTOR_MODE?.trim().toLowerCase() === "live" ? "live" : "dry";
}
