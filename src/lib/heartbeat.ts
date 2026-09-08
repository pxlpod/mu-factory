import { ALERTS } from "@/config/alerts";
import { createServiceClient, type MuClient } from "@/lib/supabase";
import type { HeartbeatRow } from "@/types/db";

/**
 * When each cron route last completed.
 *
 * A CRON THAT STOPS FIRING LEAVES NO EVIDENCE. There is no error, no failed
 * run, no row anywhere — a Short publishes, nothing finishes it, and the
 * double captions sit there looking like a Zernio problem. This table is the
 * only thing that can tell "nothing to do" apart from "nothing running".
 * Copied from photo-publisher (2026-09-08) with the column names the MU spec
 * asks for (`last_at`, `status`).
 */

export type CronRoute = "youtube.sweep" | "health";

export async function beat(
  route: CronRoute,
  status: string,
  detail?: string,
  supabase?: MuClient,
): Promise<void> {
  const client = supabase ?? createServiceClient();
  try {
    await client.from("heartbeats").upsert(
      {
        route,
        last_at: new Date().toISOString(),
        status,
        detail: detail?.slice(0, 500) ?? null,
      },
      { onConflict: "route" },
    );
  } catch {
    // A heartbeat that cannot be written must never fail the work it follows.
  }
}

export async function readHeartbeats(
  supabase?: MuClient,
): Promise<HeartbeatRow[]> {
  const client = supabase ?? createServiceClient();
  const { data } = await client.from("heartbeats").select("*");
  return (data ?? []) as HeartbeatRow[];
}

/**
 * Which routes have gone quiet.
 *
 * Only routes that have EVER run are checked. A route that has never beaten is
 * not dead — it is new, or its cron was added in a deploy that has not fired
 * yet, and alerting on it would fire once on every fresh deploy.
 */
export function deadRoutes(
  beats: HeartbeatRow[],
  expected: CronRoute[],
): Array<{ route: string; minutesAgo: number }> {
  const now = Date.now();
  const limit = ALERTS.cronDeadMinutes * 60_000;

  return beats
    .filter((b) => expected.includes(b.route as CronRoute))
    .map((b) => ({
      route: b.route,
      minutesAgo: Math.round((now - new Date(b.last_at).getTime()) / 60_000),
    }))
    .filter((b) => b.minutesAgo * 60_000 > limit);
}
