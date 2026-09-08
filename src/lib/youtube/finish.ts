import { ALERT_CONDITIONS } from "@/config/alerts";
import { RUN_LOCK_WINDOW_MS } from "@/config/factory";
import { YOUTUBE } from "@/config/youtube";
import { raiseAlert, resolveAlert } from "@/lib/alerts";
import { nextAttemptAt, policy } from "@/lib/attempts";
import { dhash, hammingDistance } from "@/lib/dhash";
import { createDriveClient, describe, resolveFolders, type MuFolders } from "@/lib/drive";
import { logEvent } from "@/lib/events";
import { YoutubeDisconnectedError } from "@/lib/google/auth";
import { beat } from "@/lib/heartbeat";
import { CoverTooLargeError, ensureCoverYt } from "@/lib/media";
import { findPublishingItemId } from "@/lib/monday";
import {
  patchFinish,
  resolveDone,
  setFinishState,
  waitForHuman,
} from "@/lib/resolve-status";
import { createServiceClient, type MuClient } from "@/lib/supabase";
import {
  fetchThumbnail,
  findOverrideTrack,
  getVideo,
  insertBlankCaption,
  isNotFound,
  listCaptions,
  setThumbnail,
  setVideoLanguage,
  type VideoInfo,
} from "@/lib/youtube/client";
import { listPublishedPosts } from "@/lib/zernio/client";
import { applyPost } from "@/lib/zernio/posts";
import type { YoutubeFinishRow } from "@/types/db";

/**
 * The YouTube sweep — poll, finish, verify.
 *
 * WHAT A HUMAN USED TO DO PER VIDEO, in the order they did it: upload the
 * cover as the thumbnail, publish a blank caption track so YouTube's auto
 * captions stop double-printing over the burned-in ones. Plus two things a
 * human never did but should have: set the video language to `en`, and come
 * back later to CHECK.
 *
 * THREE PASSES, ONE TICK:
 *   1. Poll — list published YouTube posts on the MU profile (14 days) and
 *      queue any the webhook never told us about.
 *   2. Finish — for `pending` rows, oldest first, up to `maxPerRun`: cover →
 *      videos.list → language → caption → thumbnail → `verify-pending`. Every
 *      step is skipped when its `*_at` is already set, so a row that failed at
 *      step e resumes at step e.
 *   3. Verify — for `verify-pending` rows: read the captions back, download
 *      the thumbnail YouTube serves and dHash it against our cover. Both good
 *      → `done`. Not yet → wait 15 min. Eight misses → `wait-for-human`.
 *
 * MU LAW 3: A VERIFICATION MUST BE ABLE TO FAIL. Nothing in pass 2 marks
 * anything verified. Only pass 3 does, and only from what YouTube serves.
 *
 * SERIAL, WITH A PER-RUN CAP, RATHER THAN FANNED OUT — same shape as
 * photo-publisher's ingest. The cron runs every fifteen minutes, so a backlog
 * drains on its own and the quota arithmetic in config stays true.
 */

export interface SweepSummary {
  runId: string | null;
  polled: number;
  finished: number;
  verified: number;
  waiting: number;
  errors: number;
  message: string;
  error?: string;
}

export async function runYoutubeSweep(): Promise<SweepSummary> {
  const supabase = createServiceClient();
  const summary: SweepSummary = {
    runId: null,
    polled: 0,
    finished: 0,
    verified: 0,
    waiting: 0,
    errors: 0,
    message: "",
  };

  // One run at a time. Two overlapping sweeps would each call thumbnails.set
  // on the same video — harmless to YouTube, but 50 quota units and a second
  // log line for nothing, and a race on the row's attempt counter.
  const { data: inFlight } = await supabase
    .from("runs")
    .select("id")
    .eq("route", "youtube.sweep")
    .is("finished_at", null)
    .gte("started_at", new Date(Date.now() - RUN_LOCK_WINDOW_MS).toISOString())
    .limit(1);

  if (inFlight && inFlight.length > 0) {
    summary.message = "A sweep started in the last 10 minutes has not finished yet.";
    return summary;
  }

  const { data: runRow, error: runError } = await supabase
    .from("runs")
    .insert({ route: "youtube.sweep" })
    .select("id")
    .single();

  if (runError || !runRow) {
    summary.message = "Could not open a run.";
    summary.error = runError?.message ?? "no run row returned";
    return summary;
  }

  const runId = runRow.id as string;
  summary.runId = runId;

  try {
    summary.polled = await pollZernio(supabase, runId, summary);
    await finishPending(supabase, runId, summary);
    await verifyPending(supabase, runId, summary);

    summary.message =
      `${summary.polled} polled, ${summary.finished} finished, ` +
      `${summary.verified} verified, ${summary.waiting} waiting` +
      (summary.errors ? `, ${summary.errors} error(s)` : "");

    await beat("youtube.sweep", summary.errors ? "errors" : "ok", summary.message, supabase);
  } catch (error) {
    summary.error = describe(error);
    summary.message = `Sweep failed: ${summary.error}`;
    await logEvent(supabase, {
      level: "error",
      area: "finish",
      message: summary.message,
      runId,
    });
    await beat("youtube.sweep", "failed", summary.error, supabase);
  } finally {
    await supabase
      .from("runs")
      .update({ finished_at: new Date().toISOString(), summary: summary as never })
      .eq("id", runId);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// 1. Poll
// ---------------------------------------------------------------------------

/**
 * Never throws into the sweep: a Zernio outage must not stop videos that are
 * already queued from being finished. Logged and counted instead.
 */
async function pollZernio(
  supabase: MuClient,
  runId: string,
  summary: SweepSummary,
): Promise<number> {
  if (!process.env.ZERNIO_API_KEY) {
    await logEvent(supabase, {
      level: "warn",
      area: "poll",
      message: "ZERNIO_API_KEY is not set — poll fallback skipped; webhooks only.",
      runId,
    });
    return 0;
  }

  try {
    const posts = await listPublishedPosts();
    let queued = 0;

    for (const post of posts) {
      const result = await applyPost(supabase, post, "poll", runId);
      queued += result.newFinishRows;
    }

    if (queued > 0) {
      await logEvent(supabase, {
        level: "info",
        area: "poll",
        message: `Poll found ${queued} published YouTube post(s) the webhook had not delivered.`,
        detail: { seen: posts.length },
        runId,
      });
    }

    return posts.length;
  } catch (error) {
    summary.errors += 1;
    await logEvent(supabase, {
      level: "error",
      area: "poll",
      message: `Zernio poll failed: ${describe(error)}`,
      runId,
    });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 2. Finish
// ---------------------------------------------------------------------------

async function finishPending(
  supabase: MuClient,
  runId: string,
  summary: SweepSummary,
): Promise<void> {
  const now = new Date().toISOString();

  const { data } = await supabase
    .from("youtube_finish")
    .select("*")
    .eq("state", "pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
    .order("created_at", { ascending: true })
    .limit(YOUTUBE.maxPerRun);

  const rows = (data ?? []) as YoutubeFinishRow[];
  if (rows.length === 0) return;

  let drive: ReturnType<typeof createDriveClient> | null = null;
  let folders: MuFolders | null = null;

  for (const row of rows) {
    if (!row.ep || !row.video_id) {
      summary.waiting += 1;
      await waitForHuman(
        supabase,
        row.platform_post_id,
        !row.ep
          ? "No episode on this row; set ep and return the state to pending."
          : "No video id yet; the poll fills it in from Zernio once the post is published.",
      );
      continue;
    }

    // Attempt accounting. The cap is judged BEFORE the attempt so a row at
    // the cap becomes wait-for-human on this tick rather than after one more
    // failure.
    if (row.attempts >= policy("youtube_finish").maxAttempts) {
      summary.waiting += 1;
      await giveUpFinish(supabase, row, runId);
      continue;
    }

    try {
      if (!drive || !folders) {
        drive = createDriveClient();
        folders = await resolveFolders(drive);
      }

      const outcome = await finishOne(supabase, drive, folders, row, runId);
      if (outcome === "verify-pending") summary.finished += 1;
      else summary.waiting += 1;
    } catch (error) {
      if (error instanceof YoutubeDisconnectedError) {
        // One condition for the whole rail, not one per video. Every pending
        // row waits; the health probe resolves the alert once reconnected.
        await raiseAlert({
          supabase,
          condition: ALERT_CONDITIONS.youtubeDisconnected,
          message: `${error.message}`,
        });
        await waitForHuman(supabase, row.platform_post_id, error.message, {
          last_attempt_at: new Date().toISOString(),
        });
        summary.errors += 1;
        await logEvent(supabase, {
          level: "error",
          area: "finish",
          message: `${row.ep}: ${error.message}`,
          ep: row.ep,
          runId,
        });
        break;
      }

      summary.errors += 1;
      const attempts = row.attempts + 1;
      const message = describe(error);

      await logEvent(supabase, {
        level: "error",
        area: "finish",
        message: `${row.ep}: finish attempt ${attempts} failed — ${message}`,
        ep: row.ep,
        runId,
      });

      if (attempts >= policy("youtube_finish").maxAttempts) {
        await giveUpFinish(supabase, { ...row, attempts, last_error: message }, runId);
      } else {
        await patchFinish(supabase, row.platform_post_id, {
          attempts,
          last_attempt_at: new Date().toISOString(),
          next_attempt_at: nextAttemptAt("youtube_finish"),
          last_error: message,
        });
      }
    }
  }
}

type FinishOutcome = "verify-pending" | "waiting";

async function finishOne(
  supabase: MuClient,
  drive: ReturnType<typeof createDriveClient>,
  folders: MuFolders,
  row: YoutubeFinishRow,
  runId: string,
): Promise<FinishOutcome> {
  const ep = row.ep!;
  const videoId = row.video_id!;
  const startedAt = new Date().toISOString();

  await patchFinish(supabase, row.platform_post_id, {
    attempts: row.attempts + 1,
    last_attempt_at: startedAt,
    next_attempt_at: null,
  });

  // a. The cover. A missing cover is a wait, not a failure, and does not
  //    count as an attempt — Pausha may not have produced it yet.
  let cover: Awaited<ReturnType<typeof ensureCoverYt>>;
  try {
    cover = await ensureCoverYt(supabase, drive, folders, ep);
  } catch (error) {
    if (error instanceof CoverTooLargeError) {
      await waitForHuman(supabase, row.platform_post_id, error.message);
      await raiseAlert({
        supabase,
        condition: ALERT_CONDITIONS.youtubeCoverTooLarge,
        subject: ep,
        mondayItemId: await findPublishingItemId(ep),
        message: error.message,
        payload: { bytes: error.bytes, videoId },
      });
      await logEvent(supabase, {
        level: "error",
        area: "cover",
        message: `${ep}: ${error.message}`,
        ep,
        runId,
      });
      return "waiting";
    }
    throw error;
  }

  if (cover.status === "missing") {
    await patchFinish(supabase, row.platform_post_id, {
      // Not an attempt against YouTube; give the count back.
      attempts: row.attempts,
      next_attempt_at: nextAttemptAt("cover_fetch"),
      last_error: `No cover_${ep}.jpg in Drive Covers/yt yet.`,
    });
    await logEvent(supabase, {
      level: "warn",
      area: "cover",
      message: `${ep}: cover_${ep}.jpg is not in Drive Covers/yt yet. Looking again in an hour.`,
      ep,
      runId,
    });
    return "waiting";
  }

  if (cover.fresh) {
    await logEvent(supabase, {
      level: "info",
      area: "cover",
      message: `${ep}: cover mirrored from Drive (${cover.bytes.length.toLocaleString()} bytes, sha256 ${cover.sha256.slice(0, 12)}…).`,
      ep,
      runId,
    });
  }
  if (row.cover_sha256 !== cover.sha256) {
    await patchFinish(supabase, row.platform_post_id, { cover_sha256: cover.sha256 });
  }

  // b. The video must exist and be visible.
  let video: VideoInfo | null;
  try {
    video = await getVideo(videoId, supabase);
  } catch (error) {
    if (isNotFound(error)) video = null;
    else throw error;
  }

  if (!video) {
    await waitForHuman(
      supabase,
      row.platform_post_id,
      `YouTube does not return video ${videoId} for the connected channel. Either the ` +
        `id is wrong, the video was deleted, or the wrong Google account is connected.`,
    );
    await logEvent(supabase, {
      level: "error",
      area: "finish",
      message: `${ep}: video ${videoId} not found on YouTube.`,
      ep,
      runId,
    });
    return "waiting";
  }

  if (video.privacyStatus && !["public", "unlisted"].includes(video.privacyStatus)) {
    await waitForHuman(
      supabase,
      row.platform_post_id,
      `Video ${videoId} is ${video.privacyStatus}; expected public or unlisted.`,
    );
    return "waiting";
  }

  // c. Language.
  if (!row.language_set_at) {
    if (video.defaultLanguage !== YOUTUBE.videoLanguage) {
      await setVideoLanguage(video, YOUTUBE.videoLanguage, supabase);
      await logEvent(supabase, {
        level: "info",
        area: "finish",
        message: `${ep}: defaultLanguage set to ${YOUTUBE.videoLanguage} (was ${video.defaultLanguage ?? "unset"}).`,
        ep,
        runId,
      });
    }
    await patchFinish(supabase, row.platform_post_id, {
      language_set_at: new Date().toISOString(),
    });
  }

  // d. Caption track.
  if (!row.caption_set_at) {
    const tracks = await listCaptions(videoId, supabase);
    const existing = findOverrideTrack(tracks);

    if (existing) {
      await patchFinish(supabase, row.platform_post_id, {
        caption_track_id: existing.id,
        caption_set_at: new Date().toISOString(),
      });
      await logEvent(supabase, {
        level: "info",
        area: "finish",
        message: `${ep}: an ${existing.language} "${existing.name}" track already exists (${existing.trackKind}); keeping it.`,
        ep,
        runId,
      });
    } else {
      const inserted = await insertBlankCaption(videoId, supabase);
      await patchFinish(supabase, row.platform_post_id, {
        caption_track_id: inserted.id,
        caption_set_at: new Date().toISOString(),
      });
      await logEvent(supabase, {
        level: "info",
        area: "finish",
        message: `${ep}: blank caption track published (${inserted.id}).`,
        ep,
        runId,
      });
    }
  }

  // e. Thumbnail. The cover's own bytes.
  if (!row.thumbnail_set_at) {
    await setThumbnail(videoId, cover.bytes, supabase);
    await patchFinish(supabase, row.platform_post_id, {
      thumbnail_set_at: new Date().toISOString(),
    });
    await logEvent(supabase, {
      level: "info",
      area: "finish",
      message: `${ep}: thumbnail set from cover_${ep}.jpg. Verification follows.`,
      ep,
      runId,
    });
  }

  // f. Hand over to verification. Attempts reset: verify has its own count.
  await setFinishState(supabase, row.platform_post_id, "verify-pending", {
    attempts: 0,
    last_error: null,
    next_attempt_at: null,
  });

  return "verify-pending";
}

async function giveUpFinish(
  supabase: MuClient,
  row: YoutubeFinishRow,
  runId: string,
): Promise<void> {
  const ep = row.ep ?? "unknown";
  const reason =
    `Gave up after ${row.attempts} finish attempt(s). Last error: ` +
    `${row.last_error ?? "unknown"}. ${policy("youtube_finish").manualRetry}`;

  await waitForHuman(supabase, row.platform_post_id, reason);
  await raiseAlert({
    supabase,
    condition: ALERT_CONDITIONS.youtubeFinishStuck,
    subject: ep,
    mondayItemId: row.ep ? await findPublishingItemId(row.ep) : null,
    message: `${ep}: the YouTube finisher is stuck. ${reason}`,
    payload: { videoId: row.video_id },
  });
  await logEvent(supabase, {
    level: "error",
    area: "finish",
    message: `${ep}: ${reason}`,
    ep: row.ep,
    runId,
  });
}

// ---------------------------------------------------------------------------
// 3. Verify
// ---------------------------------------------------------------------------

async function verifyPending(
  supabase: MuClient,
  runId: string,
  summary: SweepSummary,
): Promise<void> {
  const now = new Date().toISOString();

  const { data } = await supabase
    .from("youtube_finish")
    .select("*")
    .eq("state", "verify-pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
    .order("created_at", { ascending: true })
    .limit(YOUTUBE.maxPerRun);

  const rows = (data ?? []) as YoutubeFinishRow[];
  if (rows.length === 0) return;

  let drive: ReturnType<typeof createDriveClient> | null = null;
  let folders: MuFolders | null = null;

  for (const row of rows) {
    if (!row.ep || !row.video_id) continue;

    try {
      if (!drive || !folders) {
        drive = createDriveClient();
        folders = await resolveFolders(drive);
      }
      const done = await verifyOne(supabase, drive, folders, row, runId);
      if (done) summary.verified += 1;
      else summary.waiting += 1;
    } catch (error) {
      if (error instanceof YoutubeDisconnectedError) {
        await raiseAlert({
          supabase,
          condition: ALERT_CONDITIONS.youtubeDisconnected,
          message: error.message,
        });
        summary.errors += 1;
        break;
      }
      summary.errors += 1;
      await logEvent(supabase, {
        level: "error",
        area: "verify",
        message: `${row.ep}: verification pass failed — ${describe(error)}`,
        ep: row.ep,
        runId,
      });
      await patchFinish(supabase, row.platform_post_id, {
        next_attempt_at: nextAttemptAt("youtube_verify"),
        last_error: describe(error),
      });
    }
  }
}

/** True when the row reached `done` on this pass. */
async function verifyOne(
  supabase: MuClient,
  drive: ReturnType<typeof createDriveClient>,
  folders: MuFolders,
  row: YoutubeFinishRow,
  runId: string,
): Promise<boolean> {
  const ep = row.ep!;
  const videoId = row.video_id!;
  const attempts = row.attempts + 1;
  const patch: Parameters<typeof patchFinish>[2] = {
    attempts,
    last_attempt_at: new Date().toISOString(),
  };
  const notes: string[] = [];

  // Caption: the standard `en` track must be there.
  let captionVerifiedAt = row.caption_verified_at;
  if (!captionVerifiedAt) {
    const tracks = await listCaptions(videoId, supabase);
    const track = findOverrideTrack(tracks);
    if (track) {
      captionVerifiedAt = new Date().toISOString();
      patch.caption_verified_at = captionVerifiedAt;
      patch.caption_track_id = track.id;
    } else {
      notes.push(`no published ${YOUTUBE.caption.language} track yet (${tracks.length} track(s): ${tracks.map((t) => `${t.language}/${t.trackKind}`).join(", ") || "none"})`);
    }
  }

  // Thumbnail: what YouTube serves vs what we sent.
  let thumbnailVerifiedAt = row.thumbnail_verified_at;
  let distance: number | null = row.thumbnail_distance;
  if (!thumbnailVerifiedAt) {
    const video = await getVideo(videoId, supabase);
    if (!video) {
      await waitForHuman(supabase, row.platform_post_id, `Video ${videoId} disappeared during verification.`, patch);
      return false;
    }

    const cover = await ensureCoverYt(supabase, drive, folders, ep);
    if (cover.status !== "ready") {
      notes.push("cover no longer available for comparison");
    } else {
      const served = await fetchThumbnail(video);
      if (!served) {
        notes.push("YouTube returned no downloadable thumbnail yet");
      } else {
        const [ours, theirs] = await Promise.all([dhash(cover.bytes), dhash(served.bytes)]);
        distance = hammingDistance(ours, theirs);
        patch.thumbnail_distance = Number.isFinite(distance) ? distance : null;

        if (distance <= YOUTUBE.thumbnailMaxDistance) {
          thumbnailVerifiedAt = new Date().toISOString();
          patch.thumbnail_verified_at = thumbnailVerifiedAt;
        } else {
          notes.push(`thumbnail (${served.key}) is ${distance} bits from the cover; threshold ${YOUTUBE.thumbnailMaxDistance}`);
        }
      }
    }
  }

  const done = await (async () => {
    await patchFinish(supabase, row.platform_post_id, patch);
    return resolveDone(supabase, {
      platform_post_id: row.platform_post_id,
      caption_verified_at: captionVerifiedAt,
      thumbnail_verified_at: thumbnailVerifiedAt,
    });
  })();

  if (done) {
    await logEvent(supabase, {
      level: "info",
      area: "verify",
      message: `${ep}: verified — caption track present, thumbnail ${distance ?? "?"} bits from the cover. Done.`,
      ep,
      runId,
    });
    await resolveAlert({
      supabase,
      condition: ALERT_CONDITIONS.youtubeVerifyFailed,
      subject: ep,
      message: `${ep}: YouTube thumbnail and captions verified.`,
    });
    // Every per-episode condition closes on a verified finish, including the
    // ones a human fixed by hand (a re-exported cover, an episode assigned).
    for (const [condition, subject] of [
      [ALERT_CONDITIONS.youtubeFinishStuck, ep],
      [ALERT_CONDITIONS.youtubeCoverTooLarge, ep],
      [ALERT_CONDITIONS.youtubeUnknownEpisode, videoId],
    ] as const) {
      await resolveAlert({
        supabase,
        condition,
        subject,
        message: `${ep}: finished and verified.`,
      });
    }
    return true;
  }

  const summaryLine = notes.join("; ") || "not yet verified";

  if (attempts >= policy("youtube_verify").maxAttempts) {
    const reason =
      `Verification did not pass after ${attempts} looks: ${summaryLine}. ` +
      policy("youtube_verify").manualRetry;
    await waitForHuman(supabase, row.platform_post_id, reason);
    await raiseAlert({
      supabase,
      condition: ALERT_CONDITIONS.youtubeVerifyFailed,
      subject: ep,
      mondayItemId: await findPublishingItemId(ep),
      message: `${ep}: ${reason}`,
      payload: { videoId, distance },
    });
    await logEvent(supabase, {
      level: "error",
      area: "verify",
      message: `${ep}: ${reason}`,
      ep,
      runId,
    });
    return false;
  }

  await patchFinish(supabase, row.platform_post_id, {
    next_attempt_at: nextAttemptAt("youtube_verify"),
    last_error: summaryLine,
  });
  await logEvent(supabase, {
    level: "info",
    area: "verify",
    message: `${ep}: look ${attempts}/${YOUTUBE.verifyAttempts} — ${summaryLine}. Again in ${Math.round(YOUTUBE.verifyRetryMs / 60000)} min.`,
    ep,
    runId,
  });
  return false;
}
