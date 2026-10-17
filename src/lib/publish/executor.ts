import { ALERT_CONDITIONS } from "@/config/alerts";
import { MEDIA_KINDS, PUBLISH_SLOTS, RUN_LOCK_WINDOW_MS, type MediaKind } from "@/config/factory";
import { MONDAY } from "@/config/monday";
import { PUBLISH, type LegSpec } from "@/config/publish";
import { raiseAlert, resolveAlert } from "@/lib/alerts";
import { nextAttemptAt, policy } from "@/lib/attempts";
import { reflect } from "@/lib/board-reflect";
import { createDriveClient, describe, resolveFolders, type MuFolders } from "@/lib/drive";
import { logEvent } from "@/lib/events";
import { beat } from "@/lib/heartbeat";
import {
  listPublishingItems,
  postIdColumn,
  setCoverStatus,
  setCoverTile,
  setTextColumn,
  type PublishingItem,
} from "@/lib/monday";
import { isTextItem, legsFor, planLeg, type PlannedLeg } from "@/lib/publish/legs";
import { ensureMedia, ensureZernioUpload, mediaPresent, type MediaResult } from "@/lib/publish/media";
import { slotInstant } from "@/lib/slots";
import { createServiceClient, type MuClient } from "@/lib/supabase";
import { cancelPost, createScheduledPost } from "@/lib/zernio/client";
import { ensureEpisode } from "@/lib/zernio/posts";
import type { EpisodeRow, PlatformPostRow } from "@/types/db";

/**
 * The publish executor — what `mu_post.py` did on Pausha's Mac, as a cron.
 *
 * ONE TICK, IN ORDER:
 *   1. Reconcile — every leg this app handed off that has not published yet
 *      is checked against the board. Status left Queued, or the copy or date
 *      changed → the Zernio post is withdrawn and the leg goes back to
 *      pending (re-made on a later tick if still applicable). photo-publisher's
 *      cancel-and-re-handoff; `mu_covers_attach.py`'s create-then-delete,
 *      inverted, which is safe because nothing is live yet.
 *   2. Covers to the board — items without a Cover tile get theirs from Drive
 *      (retires `mu_covers_upload.py`).
 *   3. Missed slots — a Queued item whose slot passed with nothing handed off
 *      is never back-posted (doc 12 law); it is said out loud once.
 *   4. Hand off — the oldest Queued item inside the window whose files and
 *      cover approval are in place: every leg uploaded, created, recorded,
 *      written to the board. One episode per tick (decision 3, 2026-10-17).
 *
 * THE BOARD IS READ ONCE PER TICK AND NEVER CACHED ACROSS TICKS. Intent lives
 * on the board (Status, Date, copy, Cover status); fact lives here
 * (`platform_posts`). A disagreement is reconciled in favour of the board's
 * intent unless a post has already published — then it is fact.
 *
 * NEVER BACK-POST. A slot in the past is a human's problem to re-date, not a
 * reason to post now.
 *
 * `dryRun` plans everything and touches nothing at Zernio, Monday or the
 * post/media tables. Its only traces are the run row, the heartbeat, and one
 * Events line whenever the plan changes (`logDryPlan`). That is how the first
 * week is proven before the Mac script retires.
 */

export interface TickSummary {
  runId: string | null;
  dryRun: boolean;
  reconciled: number;
  cancelled: number;
  coversAttached: number;
  slotsMissed: string[];
  needsFiles: Array<{ item: string; missing: string[] }>;
  handedOff: Array<{ item: string; legs: string[] }>;
  legsFailed: number;
  plan: string[];
  errors: number;
  message: string;
  error?: string;
}

type ActiveRow = Pick<
  PlatformPostRow,
  | "id"
  | "ep"
  | "platform"
  | "kind"
  | "status"
  | "zernio_post_id"
  | "monday_item_id"
  | "slot_at"
  | "copy_hash"
  | "attempts"
  | "next_attempt_at"
  | "media_id"
  | "cancelled_at"
  | "published_at"
>;

const ACTIVE_COLUMNS =
  "id, ep, platform, kind, status, zernio_post_id, monday_item_id, slot_at, copy_hash, attempts, next_attempt_at, media_id, cancelled_at, published_at";

export async function runPublishTick(opts: { dryRun?: boolean } = {}): Promise<TickSummary> {
  const dryRun = Boolean(opts.dryRun);
  const supabase = createServiceClient();
  const startedAt = Date.now();
  const summary: TickSummary = {
    runId: null,
    dryRun,
    reconciled: 0,
    cancelled: 0,
    coversAttached: 0,
    slotsMissed: [],
    needsFiles: [],
    handedOff: [],
    legsFailed: 0,
    plan: [],
    errors: 0,
    message: "",
  };

  const { data: inFlight } = await supabase
    .from("runs")
    .select("id")
    .eq("route", "publish.tick")
    .is("finished_at", null)
    .gte("started_at", new Date(Date.now() - RUN_LOCK_WINDOW_MS).toISOString())
    .limit(1);
  if (inFlight && inFlight.length > 0) {
    summary.message = "A publish tick started in the last 10 minutes has not finished yet.";
    return summary;
  }

  const { data: runRow, error: runError } = await supabase
    .from("runs")
    .insert({ route: "publish.tick", summary: { dryRun } as never })
    .select("id")
    .single();
  if (runError || !runRow) {
    summary.message = "Could not open a run.";
    summary.error = runError?.message ?? "no run row returned";
    return summary;
  }
  const runId = runRow.id as string;
  summary.runId = runId;

  const budgetLeft = () => PUBLISH.runBudgetMs - (Date.now() - startedAt);

  try {
    const items = await listPublishingItems();
    const drive = createDriveClient();
    const folders = await resolveFolders(drive);
    const ctx: Ctx = { supabase, drive, folders, items, runId, dryRun, summary, budgetLeft };

    await reconcile(ctx);
    await attachCovers(ctx);
    await noteMissedSlots(ctx);
    await handOffNext(ctx);

    summary.message =
      (dryRun ? "DRY RUN — " : "") +
      `${summary.reconciled} reconciled (${summary.cancelled} cancelled), ` +
      `${summary.coversAttached} cover(s) attached, ` +
      `${summary.handedOff.length} handed off` +
      (summary.needsFiles.length ? `, ${summary.needsFiles.length} waiting for files` : "") +
      (summary.slotsMissed.length ? `, ${summary.slotsMissed.length} slot(s) missed` : "") +
      (summary.legsFailed ? `, ${summary.legsFailed} leg(s) failed` : "") +
      (summary.errors ? `, ${summary.errors} error(s)` : "");

    // The heartbeat records that the ROUTE ran, dry or not: a dry tick that
    // left no beat would read as a dead cron within 45 minutes.
    await beat("publish.tick", summary.errors || summary.legsFailed ? "errors" : "ok", summary.message, supabase);
    if (dryRun) await logDryPlan(supabase, runId, summary);
  } catch (error) {
    summary.error = describe(error);
    summary.message = `Publish tick failed: ${summary.error}`;
    await logEvent(supabase, { level: "error", area: "publish", message: summary.message, runId });
    await beat("publish.tick", "failed", summary.error, supabase);
  } finally {
    await supabase
      .from("runs")
      .update({ finished_at: new Date().toISOString(), summary: summary as never })
      .eq("id", runId);
  }

  return summary;
}

/**
 * A dry tick's one visible trace. The plan goes to Events ONLY when it
 * differs from the previous tick's — six ticks an hour saying the same thing
 * would bury the fifty-line Events view — so a quiet week reads as a handful
 * of lines, each the moment a live executor would have acted.
 */
async function logDryPlan(supabase: MuClient, runId: string, summary: TickSummary): Promise<void> {
  const { data: previous } = await supabase
    .from("runs")
    .select("summary")
    .eq("route", "publish.tick")
    .not("finished_at", "is", null)
    .neq("id", runId)
    .order("started_at", { ascending: false })
    .limit(1);
  const previousPlan = ((previous?.[0]?.summary as { plan?: string[] } | null)?.plan ?? []).join("\n");
  const plan = summary.plan.join("\n");
  if (plan === previousPlan) return;

  const body = summary.plan.length ? summary.plan.join(" · ") : "nothing to do";
  await logEvent(supabase, {
    level: "info",
    area: "publish",
    message: `DRY RUN — a live tick would now: ${body.slice(0, 1500)}${body.length > 1500 ? " …" : ""}`,
    runId,
  });
}

interface Ctx {
  supabase: MuClient;
  drive: ReturnType<typeof createDriveClient>;
  folders: MuFolders;
  items: PublishingItem[];
  runId: string;
  dryRun: boolean;
  summary: TickSummary;
  budgetLeft: () => number;
}

function itemLabel(item: PublishingItem): string {
  return item.name || `${item.ep}${isTextItem(item) ? " (text)" : ""}`;
}

function itemSlot(item: PublishingItem): Date {
  return slotInstant(item.date, isTextItem(item) ? PUBLISH_SLOTS.text : PUBLISH_SLOTS.video);
}

function isQueued(item: PublishingItem): boolean {
  return item.statusIndex === MONDAY.publishingStatus.queued;
}

/** Rows this app created that are not cancelled, by Monday item. */
async function activeExecutorRows(supabase: MuClient): Promise<ActiveRow[]> {
  const { data, error } = await supabase
    .from("platform_posts")
    .select(ACTIVE_COLUMNS)
    .eq("source", "executor")
    .is("cancelled_at", null);
  if (error) throw new Error(`platform_posts read failed: ${error.message}`);
  return (data ?? []) as ActiveRow[];
}

/** Any non-cancelled row for (ep, platform, kind), executor's or not. */
async function activeLegRows(supabase: MuClient, ep: string): Promise<ActiveRow[]> {
  const { data, error } = await supabase
    .from("platform_posts")
    .select(ACTIVE_COLUMNS)
    .eq("ep", ep)
    .is("cancelled_at", null);
  if (error) throw new Error(`platform_posts read failed: ${error.message}`);
  return (data ?? []) as ActiveRow[];
}

async function episodeFor(supabase: MuClient, ep: string): Promise<Pick<EpisodeRow, "question">> {
  const { data } = await supabase.from("episodes").select("question").eq("ep", ep).maybeSingle();
  return (data as Pick<EpisodeRow, "question"> | null) ?? { question: null };
}

// ---------------------------------------------------------------------------
// 1. Reconcile
// ---------------------------------------------------------------------------

async function reconcile(ctx: Ctx): Promise<void> {
  const { supabase, items, runId, dryRun, summary } = ctx;
  const rows = (await activeExecutorRows(supabase)).filter(
    (row) => row.zernio_post_id && row.status === "scheduled" && !row.published_at,
  );
  if (rows.length === 0) return;

  const byId = new Map(items.map((item) => [item.id, item]));
  for (const row of rows) {
    summary.reconciled += 1;
    const item = row.monday_item_id ? byId.get(row.monday_item_id) : undefined;
    const ep = row.ep ?? "?";
    const label = `${row.platform}/${row.kind}`;

    let reason: string | null = null;
    if (!item) reason = "its Publishing item is gone";
    // Published is the reconcile phase's own flip after the fact; never a reason to withdraw.
    else if (item.statusIndex === MONDAY.publishingStatus.published) continue;
    else if (!isQueued(item)) reason = "the item is no longer Queued";
    else {
      const spec = legsFor(item).find((l) => l.platform === row.platform && l.kind === row.kind);
      if (!spec) reason = "the item's type no longer has this leg";
      else {
        const episode = await episodeFor(supabase, item.ep);
        // Media-derived values are not in the hash, so placeholders are fine here.
        const planned = planLeg(item, spec, episode, 0, "placeholder");
        if (planned.ok && row.copy_hash && planned.leg.copyHash !== row.copy_hash) {
          reason = "the copy or date on the item changed since the hand-off";
        }
      }
    }
    if (!reason) continue;

    // A post whose slot has passed may already be publishing; leave it to the
    // webhook/poll to settle rather than race Zernio for it.
    if (row.slot_at && new Date(row.slot_at).getTime() < Date.now()) continue;

    summary.cancelled += 1;
    summary.plan.push(`cancel ${ep} ${label} at Zernio (${reason})`);
    if (dryRun) continue;

    try {
      await cancelPost(row.zernio_post_id!);
      const backToPending = Boolean(item && isQueued(item));
      await supabase
        .from("platform_posts")
        .update({
          cancelled_at: new Date().toISOString(),
          status: "cancelled",
          last_error: `Cancelled: ${reason}.`,
        })
        .eq("id", row.id);
      if (item && (row.kind === "video" || row.kind === "text")) {
        await setTextColumn(item.id, postIdColumn(row.platform), "");
      }
      await logEvent(supabase, {
        level: "warn",
        area: "publish",
        message: `${ep}: ${label} post ${row.zernio_post_id} withdrawn from Zernio — ${reason}.${backToPending ? " It will be re-made on a later tick." : ""}`,
        ep: row.ep,
        runId,
      });
      if (item && backToPending) {
        await reflect(supabase, item, "waiting", { ep: item.ep, runId, why: `${label} withdrawn: ${reason}` });
      }
    } catch (error) {
      summary.errors += 1;
      await logEvent(supabase, {
        level: "error",
        area: "publish",
        message: `${ep}: could not withdraw ${label} post ${row.zernio_post_id}: ${describe(error)}`,
        ep: row.ep,
        runId,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Covers to the board (§4.6)
// ---------------------------------------------------------------------------

async function attachCovers(ctx: Ctx): Promise<void> {
  const { supabase, drive, folders, items, runId, dryRun, summary } = ctx;
  const wanting = items
    .filter((item) => item.ep && !item.hasCoverTile)
    .filter((item) =>
      ([MONDAY.publishingStatus.review, MONDAY.publishingStatus.queued, MONDAY.publishingStatus.draft] as number[]).includes(
        item.statusIndex ?? -1,
      ),
    )
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, PUBLISH.coversPerTick);

  for (const item of wanting) {
    if (ctx.budgetLeft() < PUBLISH.perLegBudgetMs) break;
    const kind: MediaKind = isTextItem(item) ? "cover_fb" : "cover_ig";
    const spec = MEDIA_KINDS[kind];
    try {
      const present = await mediaPresent(drive, folders, item.ep, kind);
      if (!present) continue;
      summary.plan.push(`attach ${spec.name(item.ep)} to "${itemLabel(item)}"`);
      if (dryRun) {
        summary.coversAttached += 1;
        continue;
      }
      const media = await ensureMedia(supabase, drive, folders, item.ep, kind);
      if (media.status !== "ready") continue;
      const result = await setCoverTile(item.id, spec.name(item.ep), media.bytes, spec.contentType);
      if (!result.ok) throw new Error(result.error);
      if (!isTextItem(item) && item.coverStatusIndex === null) {
        await setCoverStatus(item.id, MONDAY.coverStatus.awaitingReview);
      }
      summary.coversAttached += 1;
      await logEvent(supabase, {
        level: "info",
        area: "publish",
        message: `${item.ep}: ${spec.name(item.ep)} attached to "${itemLabel(item)}" (asset ${result.assetId}).`,
        ep: item.ep,
        runId,
      });
    } catch (error) {
      summary.errors += 1;
      await logEvent(supabase, {
        level: "error",
        area: "publish",
        message: `${item.ep}: could not attach the cover to "${itemLabel(item)}": ${describe(error)}`,
        ep: item.ep,
        runId,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Missed slots
// ---------------------------------------------------------------------------

async function noteMissedSlots(ctx: Ctx): Promise<void> {
  const { supabase, items, runId, dryRun, summary } = ctx;
  const now = Date.now();
  for (const item of items) {
    if (!isQueued(item) || !item.date || !item.ep) continue;
    const hasIds = Boolean(item.ttPostId || item.igPostId || item.ytPostId || item.fbPostId);
    const slotPassed = itemSlot(item).getTime() < now;
    const subject = isTextItem(item) ? `${item.ep}-text` : item.ep;
    if (!slotPassed || hasIds) {
      await resolveAlert({
        supabase,
        condition: ALERT_CONDITIONS.publishSlotMissed,
        subject,
        message: `${itemLabel(item)}: ${hasIds ? "post ids are on the item" : "re-dated"}.`,
      });
      continue;
    }
    // Only slots missed in the last 7 days are this phase's concern; older
    // Queued items with no ids are history (the CSV era) and alarm nowhere.
    if (now - itemSlot(item).getTime() > 7 * 24 * 3_600_000) continue;

    summary.slotsMissed.push(itemLabel(item));
    if (dryRun) continue;
    await raiseAlert({
      supabase,
      condition: ALERT_CONDITIONS.publishSlotMissed,
      subject,
      mondayItemId: item.id,
      message:
        `${itemLabel(item)} was Queued but its slot (${item.date}) passed with nothing handed to Zernio. ` +
        `Nothing is back-posted: move its Date to a future day and it will be handed off then.`,
      payload: { itemId: item.id, date: item.date },
    });
    await reflect(supabase, item, "needsYou", { ep: item.ep, runId, why: "slot missed, never handed off" });
  }
}

// ---------------------------------------------------------------------------
// 4. Hand off the next episode
// ---------------------------------------------------------------------------

async function handOffNext(ctx: Ctx): Promise<void> {
  const { supabase, drive, folders, items, runId, dryRun, summary } = ctx;
  const now = Date.now();
  const windowMs = PUBLISH.handoffWindowDays * 24 * 3_600_000;

  const candidates = items
    .filter((item) => isQueued(item) && item.date && item.ep)
    .filter((item) => {
      const slot = itemSlot(item).getTime();
      return slot > now && slot - now <= windowMs;
    })
    .sort((a, b) => a.date.localeCompare(b.date) || (isTextItem(a) ? 1 : -1));

  let handedOff = 0;
  for (const item of candidates) {
    if (handedOff >= PUBLISH.episodesPerTick) break;
    if (ctx.budgetLeft() < PUBLISH.perLegBudgetMs * 2) break;

    // Queued by something else (the Mac's mu_post.py until it retires, or a
    // re-send by hand): the board already carries post ids and Zernio holds
    // the posts, which this app will only learn about when they publish.
    // Handing off again would post twice. Reflect, and leave it alone.
    if (item.ttPostId || item.igPostId || item.ytPostId || item.fbPostId) {
      summary.plan.push(`skip "${itemLabel(item)}": post ids already on the item (queued outside the executor)`);
      if (!dryRun) {
        await reflect(supabase, item, "queuedInZernio", { ep: item.ep, runId, why: "post ids on the item" });
      }
      continue;
    }

    const rows = await activeLegRows(supabase, item.ep);
    const todo = legsFor(item).filter((spec) => {
      const row = rows.find((r) => r.platform === spec.platform && r.kind === spec.kind);
      if (!row) return true;
      if (row.status === "pending") {
        return !row.next_attempt_at || new Date(row.next_attempt_at).getTime() <= now;
      }
      return false; // scheduled, published, wait-for-human: not ours to touch here
    });
    if (todo.length === 0) {
      // Fully handed off (or waiting on a human). Make sure the board says so.
      const allScheduled = legsFor(item).every((spec) =>
        rows.some((r) => r.platform === spec.platform && r.kind === spec.kind && ["scheduled", "published"].includes(r.status ?? "")),
      );
      if (allScheduled && !dryRun) {
        await reflect(supabase, item, "queuedInZernio", { ep: item.ep, runId, why: "all legs at Zernio" });
      }
      continue;
    }

    // The gate: cover approval (video items) and every file in Drive.
    const missing: string[] = [];
    if (!isTextItem(item) && item.coverStatusIndex !== MONDAY.coverStatus.approved) {
      missing.push("Cover status is not Approved");
    }
    const kinds = new Set<MediaKind>();
    for (const spec of legsFor(item)) {
      kinds.add(spec.media);
      for (const k of spec.alsoRequires) kinds.add(k);
    }
    for (const kind of kinds) {
      if (!(await mediaPresent(drive, folders, item.ep, kind))) {
        missing.push(`${MEDIA_KINDS[kind].name(item.ep)} not in Drive`);
      }
    }
    if (missing.length) {
      summary.needsFiles.push({ item: itemLabel(item), missing });
      summary.plan.push(`wait: "${itemLabel(item)}" needs ${missing.join("; ")}`);
      if (!dryRun) {
        await reflect(supabase, item, "needsFiles", { ep: item.ep, runId, why: missing.join("; ") });
        await logEvent(supabase, {
          level: "warn",
          area: "publish",
          message: `${item.ep}: "${itemLabel(item)}" is Queued but cannot be handed off yet — ${missing.join("; ")}.`,
          ep: item.ep,
          runId,
        });
        // Pausha reads Monday, not /status: say it there too (24 h cooldown).
        await raiseAlert({
          supabase,
          condition: ALERT_CONDITIONS.publishNeedsFiles,
          subject: isTextItem(item) ? `${item.ep}-text` : item.ep,
          mondayItemId: item.id,
          message:
            `${itemLabel(item)} is Queued for ${item.date} but cannot be handed to Zernio yet: ${missing.join("; ")}. ` +
            `Once that is fixed nothing else is needed — the next tick picks it up.`,
          payload: { itemId: item.id, date: item.date, missing },
        });
      }
      continue;
    }

    const legsDone = await handOffEpisode(ctx, item, todo, rows);
    if (legsDone.length) {
      handedOff += 1;
      summary.handedOff.push({ item: itemLabel(item), legs: legsDone });
    }
  }
}

/** Every leg of one item. Returns the legs that reached Zernio this tick. */
async function handOffEpisode(
  ctx: Ctx,
  item: PublishingItem,
  todo: readonly LegSpec[],
  rows: ActiveRow[],
): Promise<string[]> {
  const { supabase, drive, folders, runId, dryRun, summary } = ctx;
  const ep = item.ep;
  const done: string[] = [];
  const episode = await episodeFor(supabase, ep);
  const mediaCache = new Map<MediaKind, Extract<MediaResult, { status: "ready" }>>();
  const urlCache = new Map<MediaKind, string>();

  const mediaFor = async (kind: MediaKind) => {
    if (!mediaCache.has(kind)) {
      const result = await ensureMedia(supabase, drive, folders, ep, kind);
      if (result.status !== "ready") throw new Error(`${MEDIA_KINDS[kind].name(ep)} vanished from Drive`);
      mediaCache.set(kind, result);
    }
    return mediaCache.get(kind)!;
  };
  const urlFor = async (kind: MediaKind) => {
    if (!urlCache.has(kind)) {
      const uploaded = await ensureZernioUpload(supabase, await mediaFor(kind));
      urlCache.set(kind, uploaded.url);
      if (uploaded.fresh) {
        await logEvent(supabase, {
          level: "info",
          area: "publish",
          message: `${ep}: ${MEDIA_KINDS[kind].name(ep)} uploaded to Zernio (${uploaded.media.bytes?.toLocaleString()} bytes, sha256 ${uploaded.media.sha256?.slice(0, 12)}…).`,
          ep,
          runId,
        });
      }
    }
    return urlCache.get(kind)!;
  };

  if (!dryRun) await ensureEpisode(supabase, ep);

  for (const spec of todo) {
    if (ctx.budgetLeft() < PUBLISH.perLegBudgetMs) {
      summary.plan.push(`stop: budget — ${ep} ${spec.platform}/${spec.kind} next tick`);
      break;
    }
    const label = `${spec.platform}/${spec.kind}`;
    const existing = rows.find((r) => r.platform === spec.platform && r.kind === spec.kind) ?? null;

    if (dryRun) {
      summary.plan.push(`hand off ${ep} ${label} from ${MEDIA_KINDS[spec.media].name(ep)} for ${item.date}`);
      done.push(label);
      continue;
    }

    try {
      const tailCoverMs =
        spec.platform === "tiktok" ? Number((await mediaFor("final_tt_tail")).media.meta?.cover_ms) : null;
      const coverIgUrl = spec.platform === "instagram" && spec.kind === "video" ? await urlFor("cover_ig") : null;
      const planned = planLeg(item, spec, episode, tailCoverMs, coverIgUrl);
      if (!planned.ok) throw new Error(planned.reason);

      const mediaUrl = await urlFor(spec.media);
      const media = await mediaFor(spec.media);
      const { postId } = await createScheduledPost({ ...planned.leg.draft, mediaUrl });

      await recordHandoff(supabase, { existing, item, planned: planned.leg, postId, mediaId: media.media.id });

      if (spec.kind === "video" || spec.kind === "text") {
        const write = await setTextColumn(item.id, postIdColumn(spec.platform), postId);
        if (!write.ok) {
          await raiseAlert({
            supabase,
            condition: ALERT_CONDITIONS.mondayWriteFailed,
            subject: ep,
            mondayItemId: item.id,
            message: `${ep}: ${label} post ${postId} is at Zernio but the post id could not be written to the board (${write.error}).`,
          });
        }
      }

      done.push(label);
      await logEvent(supabase, {
        level: "info",
        area: "publish",
        message: `${ep}: ${label} scheduled at Zernio (${postId}) for ${planned.leg.draft.scheduledFor} ${PUBLISH.timezone}.`,
        ep,
        runId,
      });
    } catch (error) {
      summary.legsFailed += 1;
      const message = describe(error);
      const attempts = (existing?.attempts ?? 0) + 1;
      const cap = policy("zernio_handoff").maxAttempts;
      await recordFailure(supabase, { existing, item, spec, attempts, message, atCap: attempts >= cap });
      await logEvent(supabase, {
        level: "error",
        area: "publish",
        message: `${ep}: ${label} hand-off attempt ${attempts} failed — ${message}`,
        ep,
        runId,
      });
      if (attempts >= cap) {
        await raiseAlert({
          supabase,
          condition: ALERT_CONDITIONS.publishHandoffFailed,
          subject: `${ep}:${label}`,
          mondayItemId: item.id,
          message: `${ep}: ${label} could not be handed to Zernio after ${attempts} attempts. Last error: ${message}. ${policy("zernio_handoff").manualRetry}`,
          payload: { itemId: item.id, platform: spec.platform, kind: spec.kind },
        });
        await reflect(supabase, item, "needsYou", { ep, runId, why: `${label} hand-off failed ${attempts}×` });
      }
    }
  }

  if (dryRun) return done;

  // Where does the item stand now?
  const after = await activeLegRows(supabase, ep);
  const allScheduled = legsFor(item).every((spec) =>
    after.some((r) => r.platform === spec.platform && r.kind === spec.kind && ["scheduled", "published"].includes(r.status ?? "")),
  );
  if (allScheduled) {
    await reflect(supabase, item, "queuedInZernio", { ep, runId, why: `${legsFor(item).length} legs at Zernio` });
    const subject = isTextItem(item) ? `${ep}-text` : ep;
    for (const condition of [ALERT_CONDITIONS.publishBlocked, ALERT_CONDITIONS.publishNeedsFiles]) {
      await resolveAlert({ supabase, condition, subject, message: `${itemLabel(item)}: handed to Zernio.` });
    }
  }
  return done;
}

async function recordHandoff(
  supabase: MuClient,
  input: { existing: ActiveRow | null; item: PublishingItem; planned: PlannedLeg; postId: string; mediaId: string },
): Promise<void> {
  const { existing, item, planned, postId, mediaId } = input;
  const values = {
    ep: item.ep,
    platform: planned.spec.platform,
    kind: planned.spec.kind,
    zernio_post_id: postId,
    zernio_account_id: planned.draft.accountId,
    status: "scheduled",
    scheduled_for: planned.slotAt.toISOString(),
    source: "executor" as const,
    monday_item_id: item.id,
    slot_at: planned.slotAt.toISOString(),
    media_id: mediaId,
    handed_off_at: new Date().toISOString(),
    cancelled_at: null,
    next_attempt_at: null,
    last_error: null,
    copy_hash: planned.copyHash,
  };
  const query = existing
    ? supabase.from("platform_posts").update(values).eq("id", existing.id)
    : supabase.from("platform_posts").insert({ ...values, attempts: 0 });
  const { error } = await query;
  if (error) throw new Error(`platform_posts write failed after Zernio accepted post ${postId}: ${error.message}`);
}

async function recordFailure(
  supabase: MuClient,
  input: {
    existing: ActiveRow | null;
    item: PublishingItem;
    spec: LegSpec;
    attempts: number;
    message: string;
    atCap: boolean;
  },
): Promise<void> {
  const { existing, item, spec, attempts, message, atCap } = input;
  const values = {
    ep: item.ep,
    platform: spec.platform,
    kind: spec.kind,
    status: atCap ? "wait-for-human" : "pending",
    source: "executor" as const,
    monday_item_id: item.id,
    attempts,
    next_attempt_at: atCap ? null : nextAttemptAt("zernio_handoff"),
    last_error: message.slice(0, 2000),
  };
  const query = existing
    ? supabase.from("platform_posts").update(values).eq("id", existing.id)
    : supabase.from("platform_posts").insert(values);
  const { error } = await query;
  if (error) throw new Error(`platform_posts failure record failed: ${error.message}`);
}
