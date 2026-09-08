import { isMuAccount } from "@/config/zernio";
import { logEvent } from "@/lib/events";
import type { MuClient } from "@/lib/supabase";
import {
  asRecord,
  asString,
  findPostUrl,
  normalizePost,
  type ZernioPost,
} from "@/lib/zernio/client";
import { alertPostFailed, applyPost } from "@/lib/zernio/posts";

/**
 * What happens to a Zernio delivery after it has been recorded and answered.
 *
 * Runs inside `after()` from the webhook route. The route has already
 * verified the signature, inserted the `webhook_events` row (the dedupe) and
 * returned 200; this is the work, and its only obligations are to be
 * idempotent and to write `processed_at` + `error` back on the row so the
 * status page can show what was done with each delivery.
 *
 * FILTER FIRST. Before any row is written, every account id in the payload is
 * checked against MU's four. A delivery for a client profile is marked
 * processed with the note "not MU" and nothing else happens — MU LAW 1.
 */

export async function handleZernioEvent(
  supabase: MuClient,
  eventId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  let error: string | null = null;

  try {
    const kind = event.toLowerCase();
    const post = postFromPayload(payload);

    if (!post) {
      error = kind.startsWith("post.") ? "no post id in payload" : null;
    } else {
      const accountIds = [
        ...post.platforms.map((leg) => leg.accountId),
        asString(asRecord(payload.account)._id) ?? asString(asRecord(payload.account).id),
        asString(asRecord(payload.platform).accountId),
      ].filter((id): id is string => Boolean(id));

      const foreign = accountIds.filter((id) => !isMuAccount(id));

      if (foreign.length > 0) {
        error = `not MU: account ${[...new Set(foreign)].join(", ")}`;
      } else if (
        kind === "post.platform.published" ||
        kind === "post.published" ||
        kind === "post.tiktok.url_resolved"
      ) {
        const result = await applyPost(supabase, post, "webhook");
        error = result.applied ? null : result.reason;
      } else if (kind === "post.failed" || kind === "post.platform.failed") {
        await applyPost(supabase, post, "webhook");
        await alertPostFailed(
          supabase,
          post,
          kind,
          asString(asRecord(payload.platform).error) ??
            asString(asRecord(payload.platform).errorMessage) ??
            asString(payload.error),
        );
      } else {
        // post.scheduled, webhook.test and the rest: recorded, not acted on.
        error = null;
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
    await logEvent(supabase, {
      level: "error",
      area: "webhook",
      message: `Handling ${event} (${eventId}) failed: ${error}`,
    });
  }

  await supabase
    .from("webhook_events")
    .update({ processed_at: new Date().toISOString(), error })
    .eq("provider", "zernio")
    .eq("event_id", eventId);
}

/**
 * The post, with the per-platform block folded in.
 *
 * `post.platform.published` carries a top-level `platform` block for the leg
 * that just published as well as `post.platforms[]`. When the array is
 * present it is authoritative; when it is missing, the block becomes the one
 * leg — so a slimmer payload shape still finishes the video.
 */
function postFromPayload(payload: Record<string, unknown>): ZernioPost | null {
  const rawPost = asRecord(payload.post);
  const block = asRecord(payload.platform);

  const post = normalizePost(rawPost);
  if (!post) return null;

  const blockAccount = asString(block.accountId);
  if (post.platforms.length === 0 && blockAccount) {
    post.platforms.push({
      platform: (asString(block.platform) ?? asString(block.name) ?? "").toLowerCase(),
      status: asString(block.status)?.toLowerCase() ?? "published",
      accountId: blockAccount,
      platformPostId: asString(block.platformPostId),
      publishedUrl: findPostUrl(block),
      publishedAt: asString(block.publishedAt),
      error: asString(block.error) ?? asString(block.errorMessage),
      raw: block,
    });
  } else if (blockAccount) {
    // The block is fresher than the array copy for the leg it describes.
    const leg = post.platforms.find((l) => l.accountId === blockAccount);
    if (leg) {
      leg.platformPostId = asString(block.platformPostId) ?? leg.platformPostId;
      leg.publishedUrl = findPostUrl(block) ?? leg.publishedUrl;
      leg.status = asString(block.status)?.toLowerCase() ?? leg.status;
    }
  }

  return post;
}
