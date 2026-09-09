import type { Browser, BrowserContext, Page } from "playwright-core";

import { ALERT_CONDITIONS } from "@/config/alerts";
import { FILE_NAMES, RUN_LOCK_WINDOW_MS } from "@/config/factory";
import { STUDIO } from "@/config/youtube";
import { raiseAlert, resolveAlert } from "@/lib/alerts";
import { nextAttemptAt, policy } from "@/lib/attempts";
import { dhash, hammingDistance } from "@/lib/dhash";
import { createDriveClient, describe, resolveFolders, type MuFolders } from "@/lib/drive";
import { logEvent } from "@/lib/events";
import { beat } from "@/lib/heartbeat";
import { ensureCoverYt } from "@/lib/media";
import { findPublishingItemId } from "@/lib/monday";
import { patchFinish, resolveGridVerified } from "@/lib/resolve-status";
import {
  assertSignedIn,
  launchBrowser,
  loadStudioSession,
  openStudioContext,
  openViewerContext,
  persistRefreshedSession,
  StudioError,
  StudioSessionExpiredError,
  type StudioSession,
} from "@/lib/studio";
import { createServiceClient, type MuClient } from "@/lib/supabase";
import type { YoutubeFinishRow } from "@/types/db";

/**
 * The Shorts-grid pass — set the Studio-only thumbnail slot, then prove it.
 *
 * WHAT THIS IS FOR. After the sweep has finished and verified a Short, the
 * watch page shows `cover_<Ep>.jpg` but the channel's Shorts tab still shows
 * whatever frame YouTube picked, because that card reads a second image only
 * YouTube Studio can set (proven 2026-09-09 02:50Z). Until now a Mac did it.
 *
 * ONE ROW, ONE ATTEMPT:
 *   1. Look at the PUBLIC grid first. If the card already hashes to the cover
 *      — a human set it, or an earlier upload propagated late — record it and
 *      touch nothing in Studio.
 *   2. Open Studio's edit page under the exported session, drop the cover's
 *      own bytes into the thumbnail uploader, press Save, wait for the save
 *      to complete and settle. This is the only write.
 *   3. Poll the public grid for up to two minutes as an anonymous viewer,
 *      download the card, centre-crop to 9:16, dHash, compare. ≤ 14 bits
 *      → `grid_thumbnail_verified_at`. Nothing else writes that column.
 *
 * MU LAW 3: A VERIFICATION MUST BE ABLE TO FAIL. Pressing Save marks
 * `grid_thumbnail_set_at` and nothing more. Three attempts without a matching
 * card → the row waits for a human and Monday hears about it.
 *
 * A STALE SESSION IS ITS OWN CONDITION. Studio answering with a redirect to
 * accounts.google.com stops the run before any row is touched, raises
 * `studio.session_expired` with the one instruction that fixes it, and does
 * not consume anyone's attempt — nothing about the video is wrong.
 *
 * ITS OWN CRON, NOT A FOURTH PASS OF THE SWEEP. A browser launch plus a Studio
 * page plus two minutes of polling is most of the 300 s the sweep already
 * budgets for eight finishes and eight verifies; a slow Studio would starve
 * the caption and classic-thumbnail work, and a dead Studio session would take
 * the whole sweep down with it. Separate route, separate run lock, separate
 * heartbeat — the health probe watches both.
 */

export interface GridSummary {
  runId: string | null;
  /** Rows the pass looked at. */
  checked: number;
  /** Rows where Studio's Save was pressed this run. */
  uploaded: number;
  /** Rows that reached `grid_thumbnail_verified_at` this run. */
  verified: number;
  /** Rows tried and not yet verified (retry scheduled or waiting for a human). */
  waiting: number;
  errors: number;
  message: string;
  error?: string;
}

export async function runGridPass(): Promise<GridSummary> {
  const supabase = createServiceClient();
  const summary: GridSummary = {
    runId: null,
    checked: 0,
    uploaded: 0,
    verified: 0,
    waiting: 0,
    errors: 0,
    message: "",
  };

  // One run at a time: two browsers pressing Save on the same video is two
  // uploads racing, and two writers of the same cookie jar.
  const { data: inFlight } = await supabase
    .from("runs")
    .select("id")
    .eq("route", "youtube.grid")
    .is("finished_at", null)
    .gte("started_at", new Date(Date.now() - RUN_LOCK_WINDOW_MS).toISOString())
    .limit(1);

  if (inFlight && inFlight.length > 0) {
    summary.message = "A grid pass started in the last 10 minutes has not finished yet.";
    return summary;
  }

  const { data: runRow, error: runError } = await supabase
    .from("runs")
    .insert({ route: "youtube.grid" })
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
    await gridPending(supabase, runId, summary);

    summary.message =
      `${summary.checked} checked, ${summary.uploaded} uploaded, ` +
      `${summary.verified} verified, ${summary.waiting} waiting` +
      (summary.errors ? `, ${summary.errors} error(s)` : "");

    await beat("youtube.grid", summary.errors ? "errors" : "ok", summary.message, supabase);
  } catch (error) {
    summary.error = describe(error);
    summary.message = `Grid pass failed: ${summary.error}`;
    await logEvent(supabase, {
      level: "error",
      area: "grid",
      message: summary.message,
      runId,
    });
    await beat("youtube.grid", "failed", summary.error, supabase);
  } finally {
    await supabase
      .from("runs")
      .update({ finished_at: new Date().toISOString(), summary: summary as never })
      .eq("id", runId);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

async function gridPending(
  supabase: MuClient,
  runId: string,
  summary: GridSummary,
): Promise<void> {
  const startedAt = Date.now();
  const now = new Date().toISOString();

  // Only rows the sweep has finished AND verified on the classic slot: by then
  // the cover is mirrored and under the cap, and the video is known to exist.
  // Rows at the attempt cap are left alone — they alerted when they got there.
  const { data } = await supabase
    .from("youtube_finish")
    .select("*")
    .eq("state", "done")
    .not("video_id", "is", null)
    .not("ep", "is", null)
    .is("grid_thumbnail_verified_at", null)
    .lt("grid_attempts", policy("youtube_grid").maxAttempts)
    .or(`grid_next_attempt_at.is.null,grid_next_attempt_at.lte.${now}`)
    .order("created_at", { ascending: true })
    .limit(STUDIO.maxPerRun);

  const rows = (data ?? []) as YoutubeFinishRow[];
  if (rows.length === 0) return;

  // No browser until there is a row for it and a session to sign in with.
  const session = await loadStudioSession(supabase);
  if (!session) {
    await raiseAlert({
      supabase,
      condition: ALERT_CONDITIONS.studioSessionExpired,
      message:
        `No YouTube Studio session is stored (mu.credentials "${STUDIO.credentialKey}"), so ` +
        `${rows.length} Short(s) cannot get a Shorts-grid thumbnail. Re-run ` +
        `studio_bot.mjs login && export on the Mac.`,
    });
    await logEvent(supabase, {
      level: "error",
      area: "grid",
      message: `No Studio session stored; ${rows.length} row(s) waiting for one.`,
      runId,
    });
    summary.errors += 1;
    summary.waiting += rows.length;
    return;
  }

  let browser: Browser | null = null;
  let studio: BrowserContext | null = null;
  let viewer: BrowserContext | null = null;
  let signedInOnce = false;
  let drive: ReturnType<typeof createDriveClient> | null = null;
  let folders: MuFolders | null = null;

  try {
    browser = await launchBrowser();
    studio = await openStudioContext(browser, session);
    viewer = await openViewerContext(browser, session);
    const studioPage = await studio.newPage();
    const viewerPage = await viewer.newPage();

    for (const row of rows) {
      const remaining = STUDIO.runBudgetMs - (Date.now() - startedAt);
      if (remaining < STUDIO.perRowBudgetMs) {
        await logEvent(supabase, {
          level: "info",
          area: "grid",
          message:
            `Run budget spent after ${summary.checked} row(s); ${rows.length - summary.checked} ` +
            `left for the next pass.`,
          runId,
        });
        break;
      }

      summary.checked += 1;
      const ep = row.ep!;
      const attempt = row.grid_attempts + 1;

      try {
        if (!drive || !folders) {
          drive = createDriveClient();
          folders = await resolveFolders(drive);
        }

        const outcome = await gridOne(
          supabase,
          { studioPage, viewerPage, drive, folders, session },
          row,
          attempt,
          runId,
        );
        if (outcome.signedIn) signedInOnce = true;
        if (outcome.uploaded) summary.uploaded += 1;
        if (outcome.verified) summary.verified += 1;
        else summary.waiting += 1;
      } catch (error) {
        if (error instanceof StudioSessionExpiredError) {
          // One condition for the rail, not one per video, and no attempt
          // consumed: the video is fine, the session is not.
          await raiseAlert({
            supabase,
            condition: ALERT_CONDITIONS.studioSessionExpired,
            message: error.message,
          });
          await logEvent(supabase, {
            level: "error",
            area: "grid",
            message: `${ep}: ${error.message}`,
            ep,
            runId,
          });
          await patchFinish(supabase, row.platform_post_id, {
            grid_error: error.message,
            grid_next_attempt_at: nextAttemptAt("youtube_grid"),
          });
          summary.errors += 1;
          summary.waiting += 1;
          break;
        }

        summary.errors += 1;
        summary.waiting += 1;
        await failAttempt(supabase, row, attempt, describe(error), runId);
      }
    }
  } finally {
    // The jar only goes back if Studio accepted it this run; a run that ended
    // on the sign-in page must not overwrite the last good export.
    if (studio && signedInOnce) {
      try {
        await persistRefreshedSession(studio, session, supabase);
      } catch (error) {
        await logEvent(supabase, {
          level: "warn",
          area: "grid",
          message: `Studio session cookies were not written back: ${describe(error)}`,
          runId,
        });
      }
    }
    await viewer?.close().catch(() => undefined);
    await studio?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

interface GridTools {
  studioPage: Page;
  viewerPage: Page;
  drive: ReturnType<typeof createDriveClient>;
  folders: MuFolders;
  session: StudioSession;
}

interface GridOutcome {
  signedIn: boolean;
  uploaded: boolean;
  verified: boolean;
}

async function gridOne(
  supabase: MuClient,
  tools: GridTools,
  row: YoutubeFinishRow,
  attempt: number,
  runId: string,
): Promise<GridOutcome> {
  const ep = row.ep!;
  const videoId = row.video_id!;
  const outcome: GridOutcome = { signedIn: false, uploaded: false, verified: false };

  const cover = await ensureCoverYt(supabase, tools.drive, tools.folders, ep);
  if (cover.status !== "ready") {
    await failAttempt(
      supabase,
      row,
      attempt,
      `cover_${ep}.jpg is no longer available in storage or Drive; nothing to upload.`,
      runId,
    );
    return outcome;
  }
  const ours = await dhash(cover.bytes);

  // 1. Already right? Then say so and leave Studio alone.
  const before = await readGridCard(tools.viewerPage, videoId);
  if (before.found) {
    const distance = hammingDistance(ours, await dhash(before.bytes));
    if (await resolveGridVerified(supabase, row, distance)) {
      await recordVerified(supabase, ep, videoId, distance, "already matched before this run", runId);
      outcome.verified = true;
      return outcome;
    }
  }

  // 2. Studio: upload and save. Throws StudioSessionExpiredError on a redirect.
  await uploadGridThumbnail(tools.studioPage, videoId, ep, cover.bytes);
  outcome.signedIn = true;
  outcome.uploaded = true;
  await resolveAlert({
    supabase,
    condition: ALERT_CONDITIONS.studioSessionExpired,
    message: "The YouTube Studio session signs in again.",
  });
  await patchFinish(supabase, row.platform_post_id, {
    grid_thumbnail_set_at: new Date().toISOString(),
  });
  await logEvent(supabase, {
    level: "info",
    area: "grid",
    message: `${ep}: cover_${ep}.jpg uploaded to the Shorts-grid slot in Studio (attempt ${attempt}). Watching the public grid.`,
    ep,
    runId,
  });

  // 3. Prove it on the public grid.
  const deadline = Date.now() + STUDIO.verifyWindowMs;
  let distance = Number.POSITIVE_INFINITY;
  let note = before.found ? "" : before.reason;

  for (;;) {
    const card = await readGridCard(tools.viewerPage, videoId);
    if (card.found) {
      distance = hammingDistance(ours, await dhash(card.bytes));
      note = `${card.url.replace(/\?.*$/, "")} is ${distance} bits from the cover`;
      if (await resolveGridVerified(supabase, row, distance)) {
        await recordVerified(supabase, ep, videoId, distance, "after upload", runId);
        outcome.verified = true;
        return outcome;
      }
    } else {
      note = card.reason;
    }

    if (Date.now() + STUDIO.verifyPollMs > deadline) break;
    await tools.viewerPage.waitForTimeout(STUDIO.verifyPollMs);
  }

  await failAttempt(
    supabase,
    row,
    attempt,
    `the public Shorts grid did not show the cover within ${Math.round(STUDIO.verifyWindowMs / 1000)} s ` +
      `of saving (${note}; threshold ${STUDIO.gridMaxDistance})`,
    runId,
  );
  return outcome;
}

// ---------------------------------------------------------------------------
// Studio
// ---------------------------------------------------------------------------

/**
 * The one write. Open the edit page, drop the bytes into the hidden file input,
 * wait for Studio to accept them (Save enables), press Save, wait for the
 * round-trip (Save disables), then let Studio finish (settle).
 */
export async function uploadGridThumbnail(
  page: Page,
  videoId: string,
  ep: string,
  bytes: Buffer,
): Promise<void> {
  await page.goto(STUDIO.editUrl(videoId), { waitUntil: "domcontentloaded" });
  assertSignedIn(page);

  const input = page.locator(STUDIO.selectors.fileInput);
  try {
    await input.waitFor({ state: "attached", timeout: STUDIO.navigationTimeoutMs });
  } catch {
    assertSignedIn(page);
    const title = await page.title().catch(() => "");
    const unsupported = await page
      .getByText(/unsupported browser/i)
      .first()
      .isVisible()
      .catch(() => false);
    throw new StudioError(
      unsupported
        ? `Studio refused the browser as unsupported. The stored session's user agent is being ` +
          `sent; export the session again from a current Chrome.`
        : `Studio's thumbnail uploader (${STUDIO.selectors.fileInput}) did not appear on ` +
          `${page.url()} ("${title}"). Studio may have changed its page, or the video is not ` +
          `on the signed-in channel.`,
    );
  }

  await input.setInputFiles({
    name: FILE_NAMES.coverYt(ep),
    mimeType: "image/jpeg",
    buffer: bytes,
  });

  const save = STUDIO.selectors.saveButton;
  await waitForDisabled(page, save, false, STUDIO.saveEnableTimeoutMs).catch(() => {
    throw new StudioError(
      `Studio did not enable Save within ${STUDIO.saveEnableTimeoutMs / 1000} s of the upload; ` +
        `the file may have been refused.`,
    );
  });
  await page.locator(save).click();
  await waitForDisabled(page, save, true, STUDIO.saveCompleteTimeoutMs).catch(() => {
    throw new StudioError(
      `Save did not complete within ${STUDIO.saveCompleteTimeoutMs / 1000} s; Studio may have ` +
        `shown a dialog.`,
    );
  });
  await page.waitForTimeout(STUDIO.saveSettleMs);
}

function waitForDisabled(
  page: Page,
  selector: string,
  disabled: boolean,
  timeout: number,
): Promise<unknown> {
  return page.waitForFunction(
    ([sel, want]) => {
      const el = document.querySelector(sel as string);
      if (!el) return false;
      const has = el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
      return has === (want as boolean);
    },
    [selector, disabled] as const,
    { timeout, polling: 250 },
  );
}

// ---------------------------------------------------------------------------
// The public grid
// ---------------------------------------------------------------------------

export type GridCard =
  | { found: true; bytes: Buffer; url: string }
  | { found: false; reason: string };

/**
 * What a viewer sees on the channel's Shorts tab for this video: the card's
 * `<img>` as the browser actually resolved it (`currentSrc`), downloaded.
 *
 * Fresh navigation every look, because the page caches the card image for its
 * lifetime and a reload is the only way to see a change.
 */
export async function readGridCard(page: Page, videoId: string): Promise<GridCard> {
  try {
    await page.goto(STUDIO.shortsGridUrl, { waitUntil: "domcontentloaded" });
  } catch (error) {
    return { found: false, reason: `the Shorts grid did not load: ${describe(error)}` };
  }

  const link = page.locator(STUDIO.selectors.shortCard(videoId)).first();
  try {
    await link.waitFor({ state: "attached", timeout: 20_000 });
    await link.scrollIntoViewIfNeeded();
  } catch {
    return {
      found: false,
      reason: `no card for ${videoId} on the first page of ${STUDIO.shortsGridUrl}`,
    };
  }

  let src: string | null = null;
  try {
    const handle = await page.waitForFunction(
      (sel) => {
        const a = document.querySelector(sel as string);
        if (!a) return null;
        const img =
          a.querySelector("img") ??
          a.closest("ytm-shorts-lockup-view-model-v2, ytm-shorts-lockup-view-model, ytd-rich-item-renderer, ytd-reel-item-renderer")?.querySelector("img") ??
          a.parentElement?.querySelector("img");
        const current = img instanceof HTMLImageElement ? img.currentSrc || img.src : "";
        return current && /^https?:/.test(current) ? current : null;
      },
      STUDIO.selectors.shortCard(videoId),
      { timeout: 15_000, polling: 250 },
    );
    src = (await handle.jsonValue()) as string | null;
  } catch {
    return { found: false, reason: `the card for ${videoId} has no loaded image yet` };
  }
  if (!src) return { found: false, reason: `the card for ${videoId} has no image` };

  try {
    const res = await fetch(src, {
      signal: AbortSignal.timeout(STUDIO.imageFetchTimeoutMs),
      cache: "no-store",
    });
    if (!res.ok) return { found: false, reason: `card image ${res.status} from ${src}` };
    return { found: true, bytes: Buffer.from(await res.arrayBuffer()), url: src };
  } catch (error) {
    return { found: false, reason: `card image could not be downloaded: ${describe(error)}` };
  }
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

async function recordVerified(
  supabase: MuClient,
  ep: string,
  videoId: string,
  distance: number,
  how: string,
  runId: string,
): Promise<void> {
  await logEvent(supabase, {
    level: "info",
    area: "grid",
    message: `${ep}: Shorts-grid thumbnail verified — the public card is ${distance} bits from the cover (${how}).`,
    ep,
    runId,
    detail: { videoId, distance },
  });
  await resolveAlert({
    supabase,
    condition: ALERT_CONDITIONS.youtubeGridStuck,
    subject: ep,
    message: `${ep}: Shorts-grid thumbnail verified on the public grid.`,
  });
}

/**
 * One more failed attempt. Under the cap: a retry in fifteen minutes and a
 * line on /status. At the cap: the row waits for a human and Monday is told.
 */
async function failAttempt(
  supabase: MuClient,
  row: YoutubeFinishRow,
  attempt: number,
  reason: string,
  runId: string,
): Promise<void> {
  const ep = row.ep ?? "unknown";
  const cap = policy("youtube_grid").maxAttempts;
  const atCap = attempt >= cap;

  await patchFinish(supabase, row.platform_post_id, {
    grid_attempts: attempt,
    grid_error: reason.slice(0, 2000),
    grid_next_attempt_at: atCap ? null : nextAttemptAt("youtube_grid"),
  });

  if (atCap) {
    const message =
      `${ep}: the Shorts-grid thumbnail is not verified after ${attempt} attempt(s). ` +
      `Last: ${reason}. ${policy("youtube_grid").manualRetry}`;
    await raiseAlert({
      supabase,
      condition: ALERT_CONDITIONS.youtubeGridStuck,
      subject: ep,
      mondayItemId: row.ep ? await findPublishingItemId(row.ep) : null,
      message,
      payload: { videoId: row.video_id },
    });
    await logEvent(supabase, {
      level: "error",
      area: "grid",
      message,
      ep: row.ep,
      runId,
    });
    return;
  }

  await logEvent(supabase, {
    level: "warn",
    area: "grid",
    message: `${ep}: grid attempt ${attempt}/${cap} — ${reason}. Again in ${Math.round(STUDIO.gridRetryMs / 60000)} min.`,
    ep: row.ep,
    runId,
  });
}
