import { ALERT_CONDITIONS } from "@/config/alerts";
import { PREFLIGHT_WINDOW_MS, PUBLISH_SLOTS } from "@/config/factory";
import { MONDAY } from "@/config/monday";
import { raiseAlert, resolveAlert } from "@/lib/alerts";
import { reflect } from "@/lib/board-reflect";
import type { PublishingItem } from "@/lib/monday";
import { slotInstant } from "@/lib/slots";
import type { MuClient } from "@/lib/supabase";

/**
 * Pre-flight: say a day ahead what the slot would otherwise say the day after.
 *
 * Today a week is queued by hand; from Phase 3 the executor hands it off. In
 * both worlds the same failure exists — an item Pausha flipped to Queued that
 * never reached Zernio (W5, 2026-09-21: found at 18:10, queued late). The
 * daily check only alarms once the slot has passed. This runs hourly and
 * raises `publish.blocked:<Ep>` once (24 h cooldown) for any Queued item whose
 * slot is inside the next 24 h and that has no post id on any platform, and
 * sets the item's Factory column to `Needs files` so the calendar shows it.
 * The alert clears itself when ids appear, the item leaves Queued, or the
 * slot passes (the reconcile phase owns "it never posted").
 */

export interface PreflightResult {
  checked: number;
  blocked: string[];
}

export async function runPreflight(
  supabase: MuClient,
  items: PublishingItem[],
  now = new Date(),
): Promise<PreflightResult> {
  const blocked: string[] = [];
  let checked = 0;

  for (const item of items) {
    if (item.statusIndex !== MONDAY.publishingStatus.queued) continue;
    if (!item.date || !item.ep) continue;
    checked += 1;

    const isText = item.typeIndex === MONDAY.publishingType.text;
    const slot = slotInstant(item.date, isText ? PUBLISH_SLOTS.text : PUBLISH_SLOTS.video);
    const untilSlot = slot.getTime() - now.getTime();
    const hasIds = Boolean(item.ttPostId || item.igPostId || item.ytPostId || item.fbPostId);
    const subject = isText ? `${item.ep}-text` : item.ep;

    if (hasIds || untilSlot < 0 || untilSlot > PREFLIGHT_WINDOW_MS) {
      await resolveAlert({
        supabase,
        condition: ALERT_CONDITIONS.publishBlocked,
        subject,
        message: hasIds
          ? `${item.name}: post ids are on the item — it is queued in Zernio.`
          : `${item.name}: no longer inside the pre-flight window.`,
      });
      continue;
    }

    blocked.push(item.name);
    const hours = Math.max(1, Math.round(untilSlot / 3_600_000));
    const coverNote =
      !isText && item.coverStatusIndex !== MONDAY.coverStatus.approved
        ? " Its cover is not Approved either."
        : "";
    await raiseAlert({
      supabase,
      condition: ALERT_CONDITIONS.publishBlocked,
      subject,
      mondayItemId: item.id,
      message:
        `${item.name} is Queued and posts in about ${hours} h, but no post id is on the item — ` +
        `it has not been handed to Zernio.${coverNote} Queue it, or move its date.`,
      payload: { itemId: item.id, date: item.date, isText },
    });
    await reflect(supabase, item, "needsFiles", {
      ep: item.ep,
      why: `Queued, due in ${hours} h, not handed off`,
    });
  }

  return { checked, blocked };
}
