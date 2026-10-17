import { ALERT_CONDITIONS } from "@/config/alerts";
import { MONDAY, type FactoryLabel } from "@/config/monday";
import { raiseAlert, resolveAlert } from "@/lib/alerts";
import { logEvent } from "@/lib/events";
import {
  listPublishingItems,
  setFactory,
  videoItemFor,
  type PublishingItem,
} from "@/lib/monday";
import type { MuClient } from "@/lib/supabase";
import type { YoutubeFinishRow } from "@/types/db";

/**
 * Board reflection — every automatic action gets a board write.
 *
 * PAUSHA, 2026-10-17: "Make sure that all actions that happen automatically
 * are still reflected in Monday boards. The published videos want to read as
 * published, so I can see what's happening." For five weeks the finisher's
 * state lived only on /status and in Monday notifications, and nobody read
 * either. This module is the fix: the `Factory` column on the Publishing
 * board is written by the machine and read by a human.
 *
 * Phase 1 reflects one thing — a verified YouTube finish → `YT finished`. The
 * executor (Phase 3) and the reconcile phase (Phase 4) add the other rows of
 * spec 16 §6 through the same two functions, so the rule stays in one place:
 *
 *   `Live` outranks `YT finished` (a published episode whose finish verified
 *   is Live; the finish is a detail). Nothing here lowers a Live item.
 *
 * Nothing in this file throws into its caller: a board write that fails is
 * logged and alerted, and the next tick or the hourly backfill tries again.
 */

function labelOf(index: number | null): FactoryLabel | null {
  if (index === null) return null;
  const entry = (Object.entries(MONDAY.factory) as Array<[FactoryLabel, number]>).find(
    ([, i]) => i === index,
  );
  return entry?.[0] ?? null;
}

/**
 * Writes `label` to the item's Factory column unless the item already shows
 * something that outranks it. Returns what happened, for the caller's log.
 */
export async function reflect(
  supabase: MuClient,
  item: PublishingItem,
  label: FactoryLabel,
  opts: { ep: string; runId?: string | null; why: string },
): Promise<"written" | "kept" | "failed"> {
  const current = labelOf(item.factoryIndex);
  if (current === label) return "kept";
  if (current === "live" && label !== "live" && label !== "needsYou") return "kept";

  const result = await setFactory(item.id, label);
  if (result.ok) {
    await logEvent(supabase, {
      level: "info",
      area: "board",
      message: `${opts.ep}: Factory → ${label} on "${item.name}" (${opts.why}).`,
      ep: opts.ep,
      runId: opts.runId ?? null,
    });
    await resolveAlert({
      supabase,
      condition: ALERT_CONDITIONS.mondayWriteFailed,
      subject: opts.ep,
      message: `${opts.ep}: the board accepts writes again.`,
    });
    return "written";
  }

  await logEvent(supabase, {
    level: "error",
    area: "board",
    message: `${opts.ep}: could not write Factory → ${label} on "${item.name}": ${result.error}`,
    ep: opts.ep,
    runId: opts.runId ?? null,
  });
  await raiseAlert({
    supabase,
    condition: ALERT_CONDITIONS.mondayWriteFailed,
    subject: opts.ep,
    mondayItemId: item.id,
    message: `${opts.ep}: mu-factory could not update the Factory column (${result.error}). The work itself is done; the board is behind.`,
  });
  return "failed";
}

/**
 * A verified YouTube finish, on the episode's Video item. Called by the
 * verify pass the moment a row reaches `done`.
 */
export async function reflectFinishOnBoard(
  supabase: MuClient,
  ep: string,
  runId: string | null,
): Promise<void> {
  try {
    const items = await listPublishingItems();
    const item = videoItemFor(items, ep);
    if (!item) {
      await logEvent(supabase, {
        level: "warn",
        area: "board",
        message: `${ep}: finish verified but no Publishing item carries EP ${ep}; nothing to reflect.`,
        ep,
        runId,
      });
      return;
    }
    await reflect(supabase, item, "ytFinished", {
      ep,
      runId,
      why: "YouTube thumbnail + caption verified",
    });
  } catch (error) {
    await logEvent(supabase, {
      level: "error",
      area: "board",
      message: `${ep}: board reflection failed — ${error instanceof Error ? error.message : String(error)}`,
      ep,
      runId,
    });
  }
}

/**
 * Hourly backfill: every `done` finish row whose item does not yet say so.
 *
 * Covers the 30-odd episodes finished before the column existed, and any tick
 * where the write failed. Reads the board once; writes only where the column
 * is behind. Returns counts for the health summary.
 */
export async function backfillFinishedOnBoard(
  supabase: MuClient,
  items: PublishingItem[],
): Promise<{ written: number; failed: number }> {
  const { data } = await supabase
    .from("youtube_finish")
    .select("ep, state")
    .eq("state", "done")
    .not("ep", "is", null);
  const rows = (data ?? []) as Array<Pick<YoutubeFinishRow, "ep" | "state">>;

  let written = 0;
  let failed = 0;
  for (const row of rows) {
    const ep = row.ep!;
    const item = videoItemFor(items, ep);
    if (!item) continue;
    const current = labelOf(item.factoryIndex);
    if (current === "ytFinished" || current === "live") continue;
    const outcome = await reflect(supabase, item, "ytFinished", {
      ep,
      why: "backfill: finish row is done",
    });
    if (outcome === "written") written += 1;
    if (outcome === "failed") failed += 1;
  }
  return { written, failed };
}
