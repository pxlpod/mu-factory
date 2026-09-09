import { ALERT_CONDITIONS } from "@/config/alerts";
import { EPISODE_PATTERN, type PostKind } from "@/config/factory";
import {
  MU_ACCOUNT_PLATFORM,
  ZERNIO,
  isMuAccount,
  type ZernioPlatform,
} from "@/config/zernio";
import { raiseAlert } from "@/lib/alerts";
import { logEvent } from "@/lib/events";
import { findPublishingItemId } from "@/lib/monday";
import type { MuClient } from "@/lib/supabase";
import type { ZernioPost } from "@/lib/zernio/client";
import type { PlatformPostRow, PostSource, YoutubeFinishRow } from "@/types/db";

/**
 * Applying what Zernio says to `platform_posts` and `youtube_finish`.
 *
 * ONE CODE PATH FOR WEBHOOK AND POLL. photo-publisher's lesson: the result
 * of a post arrives two ways — a delivery, or a poll that reconciles the
 * delivery that never came — and if each way applies it differently they
 * disagree on a real post within a week. Both call `applyPost` with a
 * `source`, and the only difference in the rows is that column.
 *
 * MU LAW 1 AGAIN. `applyPost` refuses a post whose legs include an account
 * that is not one of MU's four. It does not filter to the MU legs and carry
 * on: a post spanning MU and a client profile is not a thing that should
 * exist, and acting on half of it would hide that.
 *
 * IDEMPOTENT. `platform_posts` is upserted on `(platform, zernio_post_id)`,
 * `youtube_finish` is inserted only when absent and never re-opened from
 * `done`. Replays, retries and overlapping ticks converge on the same rows.
 */

export interface ApplyResult {
  applied: boolean;
  reason: string;
  ep: string | null;
  /** YouTube legs that now have a finish row (new or existing). */
  finishRows: number;
  newFinishRows: number;
}

/**
 * Resolves the episode for a post: `metadata.episode` if valid, else any
 * existing `platform_posts` row for this Zernio post id, else null.
 */
export async function resolveEpisode(
  supabase: MuClient,
  post: ZernioPost,
): Promise<string | null> {
  if (post.episode && EPISODE_PATTERN.test(post.episode)) return post.episode;

  const { data } = await supabase
    .from("platform_posts")
    .select("ep")
    .eq("zernio_post_id", post.id)
    .not("ep", "is", null)
    .limit(1);

  const row = (data ?? [])[0] as Pick<PlatformPostRow, "ep"> | undefined;
  return row?.ep ?? null;
}

export async function applyPost(
  supabase: MuClient,
  post: ZernioPost,
  source: Exclude<PostSource, "import">,
  runId: string | null = null,
): Promise<ApplyResult> {
  /**
   * A leg with no account id at all is refused from a webhook (fail closed —
   * we cannot prove it is MU's). From the poll it is assumed to be MU's
   * account for that platform, because the list call was scoped to the MU
   * profile by `profileId`; the assumption is recorded on the row's `raw`.
   */
  for (const leg of post.platforms) {
    if (!leg.accountId && source === "poll" && leg.platform in ZERNIO.accountIds) {
      leg.accountId = ZERNIO.accountIds[leg.platform as ZernioPlatform];
      leg.raw = { ...leg.raw, accountIdAssumedFromProfile: true };
    }
  }

  const foreign = post.platforms.filter((leg) => !isMuAccount(leg.accountId));
  if (foreign.length > 0) {
    return {
      applied: false,
      reason: `not MU: account ${foreign.map((l) => l.accountId ?? "?").join(", ")}`,
      ep: null,
      finishRows: 0,
      newFinishRows: 0,
    };
  }

  const ep = await resolveEpisode(supabase, post);
  let finishRows = 0;
  let newFinishRows = 0;

  for (const leg of post.platforms) {
    const platform = MU_ACCOUNT_PLATFORM[leg.accountId ?? ""] as ZernioPlatform | undefined;
    if (!platform) continue;

    const row = await upsertPlatformPost(supabase, {
      ep,
      platform,
      kind: post.kind ?? undefined,
      zernioPostId: post.id,
      zernioAccountId: leg.accountId,
      platformPostId: leg.platformPostId,
      publishedUrl: leg.publishedUrl,
      status: leg.status ?? post.status,
      scheduledFor: post.scheduledFor,
      publishedAt: leg.publishedAt ?? post.publishedAt,
      source,
      raw: leg.raw,
    });

    // A published YouTube leg with a video id is the finisher's trigger.
    if (platform === "youtube" && leg.status === "published" && leg.platformPostId) {
      const outcome = await ensureFinishRow(supabase, {
        platformPostId: row.id,
        ep,
        videoId: leg.platformPostId,
      });
      finishRows += 1;
      if (outcome.created) newFinishRows += 1;

      if (outcome.created && !ep) {
        /**
         * Unknown episode: still queue it (so it is visible), but as
         * wait-for-human — the cover cannot be found without an episode, and
         * guessing one would put the wrong thumbnail on a public video.
         */
        await supabase
          .from("youtube_finish")
          .update({
            state: "wait-for-human",
            last_error:
              "No episode: post.metadata.episode is missing and no imported row " +
              "matches this Zernio post id. Set ep on the platform_posts row and " +
              "the youtube_finish row, then set state back to pending.",
          })
          .eq("platform_post_id", row.id);

        await raiseAlert({
          supabase,
          condition: ALERT_CONDITIONS.youtubeUnknownEpisode,
          subject: leg.platformPostId,
          message:
            `A YouTube Short (video ${leg.platformPostId}, Zernio post ${post.id}) ` +
            `published with no episode attached. It will not be finished until ` +
            `someone says which Ep it is.`,
          payload: { videoId: leg.platformPostId, zernioPostId: post.id },
        });

        await logEvent(supabase, {
          level: "warn",
          area: source,
          message: `YouTube video ${leg.platformPostId} published with no episode; waiting for a human.`,
          detail: { zernioPostId: post.id },
          runId,
        });
      } else if (outcome.created) {
        await logEvent(supabase, {
          level: "info",
          area: source,
          message: `${ep}: YouTube video ${leg.platformPostId} queued for finishing.`,
          detail: { zernioPostId: post.id, videoId: leg.platformPostId },
          ep,
          runId,
        });
      }
    }
  }

  return { applied: true, reason: "applied", ep, finishRows, newFinishRows };
}

/**
 * Raises `zernio.post_failed:<post id>` for a failed post or platform leg,
 * aimed at the episode's Publishing item when the episode is known.
 */
export async function alertPostFailed(
  supabase: MuClient,
  post: ZernioPost,
  event: string,
  detail: string | null,
): Promise<void> {
  const ep = await resolveEpisode(supabase, post);
  const itemId = ep ? await findPublishingItemId(ep) : null;
  const failedLegs = post.platforms
    .filter((leg) => leg.status === "failed" || leg.error)
    .map((leg) => `${leg.platform}${leg.error ? ` (${leg.error})` : ""}`);

  await raiseAlert({
    supabase,
    condition: ALERT_CONDITIONS.zernioPostFailed,
    subject: post.id,
    mondayItemId: itemId,
    message:
      `Zernio reported ${event} for ${ep ?? "an unknown episode"} (post ${post.id})` +
      (failedLegs.length ? `: ${failedLegs.join(", ")}` : "") +
      (detail ? `. ${detail}` : "") +
      ". Check the post in Zernio.",
    payload: { zernioPostId: post.id, ep },
  });

  await logEvent(supabase, {
    level: "error",
    area: "webhook",
    message: `${ep ?? "unknown episode"}: Zernio ${event} for post ${post.id}.`,
    detail: { failedLegs, detail },
    ep,
  });
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * Upsert on `(platform, zernio_post_id)`. Never blanks a value that is already
 * known: an `ep` resolved earlier survives a payload without metadata, and a
 * `published_url` from the webhook survives a poll page that omits it.
 */
export async function upsertPlatformPost(
  supabase: MuClient,
  input: {
    ep: string | null;
    platform: ZernioPlatform;
    /** From `post.metadata.kind`. Absent → keep what the row has, else `video`. */
    kind?: PostKind;
    zernioPostId: string;
    zernioAccountId: string | null;
    platformPostId: string | null;
    publishedUrl: string | null;
    status: string | null;
    scheduledFor: string | null;
    publishedAt: string | null;
    source: PostSource;
    raw: unknown;
  },
): Promise<PlatformPostRow> {
  const { data: existingData } = await supabase
    .from("platform_posts")
    .select("*")
    .eq("platform", input.platform)
    .eq("zernio_post_id", input.zernioPostId)
    .maybeSingle();

  const existing = existingData as PlatformPostRow | null;

  const ep = input.ep ?? existing?.ep ?? null;
  if (ep) await ensureEpisode(supabase, ep);

  const merged = {
    ep,
    platform: input.platform,
    kind: input.kind ?? existing?.kind ?? "video",
    zernio_post_id: input.zernioPostId,
    zernio_account_id: input.zernioAccountId ?? existing?.zernio_account_id ?? null,
    platform_post_id: input.platformPostId ?? existing?.platform_post_id ?? null,
    published_url: input.publishedUrl ?? existing?.published_url ?? null,
    status: input.status ?? existing?.status ?? null,
    scheduled_for: input.scheduledFor ?? existing?.scheduled_for ?? null,
    published_at: input.publishedAt ?? existing?.published_at ?? null,
    // The source records who FIRST told us; a webhook confirming an import
    // does not rewrite history.
    source: existing?.source ?? input.source,
    raw: (input.raw ?? existing?.raw ?? null) as never,
  };

  const { data, error } = await supabase
    .from("platform_posts")
    .upsert(merged, { onConflict: "platform,zernio_post_id" })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`platform_posts upsert failed: ${error?.message ?? "no row"}`);
  }
  return data as PlatformPostRow;
}

/**
 * Makes sure an `episodes` row exists for `ep`, creating a bare one if not.
 *
 * `platform_posts.ep` references `episodes`, and a webhook can name an
 * episode (via `metadata.episode`) before the CSV import has seen it. A bare
 * row keyed on the Ep is the honest record — "this episode exists and has a
 * post" — and the next import fills in the rest without conflict.
 */
export async function ensureEpisode(supabase: MuClient, ep: string): Promise<void> {
  if (!EPISODE_PATTERN.test(ep)) throw new Error(`Not an episode id: ${ep}`);
  const { error } = await supabase
    .from("episodes")
    .upsert({ ep }, { onConflict: "ep", ignoreDuplicates: true });
  if (error) throw new Error(`episodes upsert failed: ${error.message}`);
}

/**
 * Inserts a `pending` finish row when none exists. When one exists, fills a
 * missing `video_id` or `ep` and leaves `state` exactly as it was — a `done`
 * row from the import stays done.
 */
export async function ensureFinishRow(
  supabase: MuClient,
  input: { platformPostId: string; ep: string | null; videoId: string | null },
): Promise<{ created: boolean; row: YoutubeFinishRow }> {
  const { data: existingData } = await supabase
    .from("youtube_finish")
    .select("*")
    .eq("platform_post_id", input.platformPostId)
    .maybeSingle();

  const existing = existingData as YoutubeFinishRow | null;

  if (existing) {
    const patch: Partial<YoutubeFinishRow> = {};
    if (!existing.video_id && input.videoId) patch.video_id = input.videoId;
    if (!existing.ep && input.ep) patch.ep = input.ep;
    if (Object.keys(patch).length > 0) {
      await supabase
        .from("youtube_finish")
        .update(patch)
        .eq("platform_post_id", input.platformPostId);
    }
    return { created: false, row: { ...existing, ...patch } };
  }

  const { data, error } = await supabase
    .from("youtube_finish")
    .insert({
      platform_post_id: input.platformPostId,
      ep: input.ep,
      video_id: input.videoId,
      state: "pending",
    })
    .select("*")
    .single();

  if (error || !data) {
    // A concurrent insert won the race; read it back.
    const { data: raced } = await supabase
      .from("youtube_finish")
      .select("*")
      .eq("platform_post_id", input.platformPostId)
      .maybeSingle();
    if (raced) return { created: false, row: raced as YoutubeFinishRow };
    throw new Error(`youtube_finish insert failed: ${error?.message ?? "no row"}`);
  }

  return { created: true, row: data as YoutubeFinishRow };
}
