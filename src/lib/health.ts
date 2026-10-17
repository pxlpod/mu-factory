import { ALERTS, ALERT_CONDITIONS } from "@/config/alerts";
import { MONDAY } from "@/config/monday";
import { raiseAlert, resolveAlert } from "@/lib/alerts";
import { backfillFinishedOnBoard } from "@/lib/board-reflect";
import { requiredEnv } from "@/lib/config-check";
import {
  createDriveClient,
  probeRoot,
  resolveFolders,
  serviceAccountEmail,
} from "@/lib/drive";
import { logEvent } from "@/lib/events";
import { YoutubeDisconnectedError } from "@/lib/google/auth";
import { beat, deadRoutes, readHeartbeats } from "@/lib/heartbeat";
import { runHousekeeping } from "@/lib/housekeeping";
import { checkBoard, listPublishingItems, type PublishingItem } from "@/lib/monday";
import { runPreflight } from "@/lib/preflight";
import { createServiceClient } from "@/lib/supabase";
import { probeChannel } from "@/lib/youtube/client";

/**
 * The hourly probe.
 *
 * WHAT IT IS FOR is narrow and worth stating: every dependency here can stop
 * working without producing an error anywhere a human would see. A revoked
 * Google token, a Drive share removed, a Monday column deleted, a schema no
 * longer exposed to PostgREST, a cron that stopped firing — each makes the
 * system quietly do nothing, which is indistinguishable from a quiet week.
 *
 * So this runs on a schedule and complains, rather than waiting for a Short
 * to publish with double captions at the moment it mattered. Copied from
 * photo-publisher (2026-09-08) with the probes MU needs.
 */

export interface ProbeResult {
  name: string;
  ok: boolean;
  detail: string;
}

export async function runHealthCheck(): Promise<{
  ok: boolean;
  results: ProbeResult[];
  dead: Array<{ route: string; minutesAgo: number }>;
  housekeeping: Awaited<ReturnType<typeof runHousekeeping>>;
  reflection: { written: number; failed: number };
  preflight: { checked: number; blocked: string[] };
}> {
  const supabase = createServiceClient();
  const results: ProbeResult[] = [];

  results.push(
    await probe("Config", async () => {
      const missing = requiredEnv().filter((name) => !process.env[name]);
      if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
      return `all ${requiredEnv().length} variables set`;
    }),
  );

  results.push(
    await probe("Supabase", async () => {
      const { count, error } = await supabase
        .from("episodes")
        .select("ep", { count: "exact", head: true });
      if (error) throw new Error(error.message);
      return `reachable, ${count ?? 0} episode(s)`;
    }),
  );

  results.push(
    await probe("Drive", async () => {
      // Root FIRST, by id, so a rebuilt or unshared root says so in words
      // (2026-10-03 → 2026-10-17: two weeks of "Covers not found under the
      // root" when the root itself had changed). Then the three folders.
      const drive = createDriveClient();
      const root = await probeRoot(drive);
      await resolveFolders(drive);
      return `"${root.name}" (${root.id.slice(0, 8)}…) shared with ${serviceAccountEmail()}; Covers/yt, Covers, Finals resolved`;
    }),
  );

  let youtubeAuthFailed = false;
  results.push(
    await probe("YouTube", async () => {
      try {
        const channel = await probeChannel(supabase);
        return `connected as ${channel.title} (${channel.id})`;
      } catch (error) {
        if (error instanceof YoutubeDisconnectedError) youtubeAuthFailed = true;
        throw error;
      }
    }),
  );

  let publishingItems: PublishingItem[] | null = null;
  results.push(
    await probe("Monday", async () => {
      const board = await checkBoard();
      if (!board.ok) {
        throw new Error(board.error ?? `missing ${board.missingColumns.join(", ")}`);
      }
      publishingItems = await listPublishingItems();
      return `Publishing board ${MONDAY.boards.publishing} intact (${board.boardName}), ${publishingItems.length} items`;
    }),
  );

  // Board reflection + pre-flight ride on the hourly read of the board
  // (spec 16 §6 / §4.1). Both are no-ops when the board is unreadable — the
  // Monday probe above has already gone red.
  let reflection = { written: 0, failed: 0 };
  let preflight = { checked: 0, blocked: [] as string[] };
  if (publishingItems) {
    reflection = await backfillFinishedOnBoard(supabase, publishingItems);
    preflight = await runPreflight(supabase, publishingItems);
  }

  const beats = await readHeartbeats(supabase);
  // `youtube.grid` is no longer a cron (2026-10-17): the Shorts-grid tile is
  // set by the Mac's studio_bot, the one declared launchd job (spec 16 §7).
  // The route stays for a manual run from /status; its silence is not a fault.
  const dead = deadRoutes(beats, ["youtube.sweep", "publish.tick"]);

  const failures = results.filter((r) => !r.ok);
  const ok = failures.length === 0 && dead.length === 0;

  /**
   * YouTube auth is its own condition, separate from "YouTube unreachable".
   * "Google is down" needs patience; "Google no longer trusts us" needs a
   * human to press Connect. Folding them together would give the same
   * message for both, and the wrong instruction for one.
   */
  const youtube = results.find((r) => r.name === "YouTube");
  if (youtube && youtubeAuthFailed) {
    await raiseAlert({
      supabase,
      condition: ALERT_CONDITIONS.youtubeDisconnected,
      message: `${youtube.detail} Nothing will be finished on YouTube until it is reconnected.`,
    });
  } else if (youtube?.ok) {
    await resolveAlert({
      supabase,
      condition: ALERT_CONDITIONS.youtubeDisconnected,
      message: `YouTube is authorised again — ${youtube.detail}.`,
    });
  }

  // One condition per dependency, so a broken Drive does not mask a broken
  // Monday and fixing one does not clear the other.
  for (const result of results) {
    if (result.name === "YouTube" && youtubeAuthFailed) continue;

    if (result.ok) {
      await resolveAlert({
        supabase,
        condition: ALERT_CONDITIONS.configInvalid,
        subject: result.name,
        message: `${result.name} is reachable again — ${result.detail}`,
      });
    } else {
      await raiseAlert({
        supabase,
        condition: ALERT_CONDITIONS.configInvalid,
        subject: result.name,
        message: `${result.name} check failed: ${result.detail}`,
        payload: { probe: result.name },
      });
    }
  }

  const consequence: Record<"youtube.sweep" | "publish.tick", string> = {
    "youtube.sweep": "Published Shorts are not being finished.",
    "publish.tick": "Queued episodes are not being handed to Zernio.",
  };
  // The grid cron was retired 2026-10-17; close its dead-cron condition if one
  // is still open so the last message about it is a ✅, not silence.
  await resolveAlert({
    supabase,
    condition: ALERT_CONDITIONS.cronDead,
    subject: "youtube.grid",
    message: "The youtube.grid cron is retired; the Shorts-grid tile is set by the Mac's studio_bot.",
  });
  for (const route of ["youtube.sweep", "publish.tick"] as const) {
    const stopped = dead.find((d) => d.route === route);
    if (stopped) {
      await raiseAlert({
        supabase,
        condition: ALERT_CONDITIONS.cronDead,
        subject: route,
        message:
          `The ${route} cron has not run for ${stopped.minutesAgo} minutes ` +
          `(expected within ${ALERTS.cronDeadMinutes}). ${consequence[route]} ` +
          `Check Vercel → the project → Cron Jobs.`,
      });
    } else {
      await resolveAlert({
        supabase,
        condition: ALERT_CONDITIONS.cronDead,
        subject: route,
        message: `The ${route} cron is running again.`,
      });
    }
  }

  const housekeeping = await runHousekeeping(supabase);

  if (!ok) {
    await logEvent(supabase, {
      level: "warn",
      area: "health",
      message:
        `Health: ${failures.map((f) => `${f.name} — ${f.detail}`).join("; ")}` +
        (dead.length ? `; dead: ${dead.map((d) => d.route).join(", ")}` : ""),
    });
  }
  if (reflection.written || reflection.failed || preflight.blocked.length) {
    await logEvent(supabase, {
      level: reflection.failed || preflight.blocked.length ? "warn" : "info",
      area: "board",
      message:
        `Board: ${reflection.written} Factory column(s) backfilled` +
        (reflection.failed ? `, ${reflection.failed} write(s) failed` : "") +
        (preflight.blocked.length
          ? `; pre-flight: ${preflight.blocked.length} Queued item(s) due within 24 h with no post ids — ${preflight.blocked.join(", ")}`
          : `; pre-flight: ${preflight.checked} Queued item(s) checked, none blocked`),
    });
  }

  await beat(
    "health",
    ok ? "ok" : "failing",
    failures.map((f) => f.name).join(", ") || housekeeping.message,
    supabase,
  );

  return { ok, results, dead, housekeeping, reflection, preflight };
}

async function probe(
  name: string,
  fn: () => Promise<string>,
): Promise<ProbeResult> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
