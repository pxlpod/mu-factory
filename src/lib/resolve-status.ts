import { STUDIO, type FinishState } from "@/config/youtube";
import type { MuClient } from "@/lib/supabase";
import type { YoutubeFinishRow } from "@/types/db";

/**
 * The one place a `youtube_finish` row changes state.
 *
 * SAME SHAPE AS PHOTO-PUBLISHER'S `resolve-status.ts`, SAME REASON. There,
 * two rails converged on one Monday status and only one file was allowed to
 * write `Posted`. Here, four steps (cover, language, caption, thumbnail) and
 * two read-backs converge on one `state`, and the finish and verify passes
 * must not each hold an opinion about when a row is `done`. They call this.
 *
 * The rule, in two lines:
 *   `done` requires BOTH `caption_verified_at` AND `thumbnail_verified_at`.
 *   Nothing else may write `done`. Not a 200 from `thumbnails.set`, not a
 *   caption id coming back, not an operator's optimism.
 *
 * `wait-for-human` is the honest terminal for anything this code cannot
 * decide. It always carries `last_error` so /status can say why. Leaving it
 * is a human act — by design, not by omission.
 *
 * THE SHORTS GRID SLOT (2026-09-09) IS A SECOND VERIFICATION ON THE SAME ROW
 * and does not touch `state`: `done` keeps meaning "the classic slot and the
 * caption track were read back". The grid has its own columns
 * (`grid_thumbnail_*`, `grid_attempts`, `grid_error`) and its own rule, held
 * here for the same reason: `grid_thumbnail_verified_at` is written by
 * `resolveGridVerified` alone, from a distance measured on the PUBLIC grid
 * card, and never by the code that pressed Save. /status says "done" for a
 * row only when both slots are verified.
 */

export type FinishPatch = Partial<
  Pick<
    YoutubeFinishRow,
    | "video_id"
    | "thumbnail_set_at"
    | "thumbnail_verified_at"
    | "thumbnail_distance"
    | "caption_track_id"
    | "caption_set_at"
    | "caption_verified_at"
    | "language_set_at"
    | "attempts"
    | "last_attempt_at"
    | "next_attempt_at"
    | "last_error"
    | "cover_sha256"
    | "grid_thumbnail_set_at"
    | "grid_thumbnail_distance"
    | "grid_attempts"
    | "grid_next_attempt_at"
    | "grid_error"
  >
>;

/** Writes step timestamps and counters without touching `state`. */
export async function patchFinish(
  supabase: MuClient,
  platformPostId: string,
  patch: FinishPatch,
): Promise<void> {
  const { error } = await supabase
    .from("youtube_finish")
    .update(patch)
    .eq("platform_post_id", platformPostId);
  if (error) throw new Error(`youtube_finish update failed: ${error.message}`);
}

/**
 * Moves a row to a non-terminal state (`pending`, `verify-pending`).
 *
 * A row already `done` is never re-opened here. The poll fallback discovers
 * imported rows that were finished by hand and must not send them round
 * again — that is the whole reason the import marks them done.
 */
export async function setFinishState(
  supabase: MuClient,
  platformPostId: string,
  state: Exclude<FinishState, "done" | "wait-for-human">,
  patch: FinishPatch = {},
): Promise<void> {
  const { error } = await supabase
    .from("youtube_finish")
    .update({ state, ...patch })
    .eq("platform_post_id", platformPostId)
    .neq("state", "done");
  if (error) throw new Error(`youtube_finish state update failed: ${error.message}`);
}

/** The honest stop. Always with a reason. */
export async function waitForHuman(
  supabase: MuClient,
  platformPostId: string,
  reason: string,
  patch: FinishPatch = {},
): Promise<void> {
  const { error } = await supabase
    .from("youtube_finish")
    .update({
      state: "wait-for-human",
      last_error: reason.slice(0, 2000),
      next_attempt_at: null,
      ...patch,
    })
    .eq("platform_post_id", platformPostId)
    .neq("state", "done");
  if (error) throw new Error(`youtube_finish wait-for-human failed: ${error.message}`);
}

/**
 * `done`, if and only if both read-backs have succeeded.
 *
 * Returns false and changes nothing otherwise. The caller decides what a
 * false means (stay `verify-pending`, or give up) — this function only knows
 * the rule.
 */
export async function resolveDone(
  supabase: MuClient,
  row: Pick<
    YoutubeFinishRow,
    "platform_post_id" | "caption_verified_at" | "thumbnail_verified_at"
  >,
): Promise<boolean> {
  if (!row.caption_verified_at || !row.thumbnail_verified_at) return false;

  const { error } = await supabase
    .from("youtube_finish")
    .update({ state: "done", last_error: null, next_attempt_at: null })
    .eq("platform_post_id", row.platform_post_id);
  if (error) throw new Error(`youtube_finish done failed: ${error.message}`);
  return true;
}

/**
 * `grid_thumbnail_verified_at`, if and only if the card the public Shorts grid
 * serves hashes within the threshold of our cover.
 *
 * The distance is recorded either way — a miss on /status should say how far
 * off it was. Returns false and leaves the verified column alone otherwise.
 * `grid_thumbnail_verified_at` is not in `FinishPatch`; this is the only writer.
 */
export async function resolveGridVerified(
  supabase: MuClient,
  row: Pick<YoutubeFinishRow, "platform_post_id">,
  distance: number,
): Promise<boolean> {
  const measured = Number.isFinite(distance) ? distance : null;
  const verified = measured !== null && measured <= STUDIO.gridMaxDistance;

  const { error } = await supabase
    .from("youtube_finish")
    .update(
      verified
        ? {
            grid_thumbnail_distance: measured,
            grid_thumbnail_verified_at: new Date().toISOString(),
            grid_error: null,
            grid_next_attempt_at: null,
          }
        : { grid_thumbnail_distance: measured },
    )
    .eq("platform_post_id", row.platform_post_id);
  if (error) throw new Error(`youtube_finish grid update failed: ${error.message}`);
  return verified;
}
