import { ALERTS } from "@/config/alerts";
import { createServiceClient, type MuClient } from "@/lib/supabase";

/**
 * The quiet maintenance nobody thinks about until it hurts.
 *
 * LOG TABLES ONLY. `events` and `webhook_events` are logs and are pruned past
 * the retention in config. `episodes`, `platform_posts`, `youtube_finish`,
 * `media` and `credentials` are the record of what exists, what was published
 * and what was done to it, and are never touched here. A pruned event costs a
 * diagnostic; a pruned post record costs the poll its memory and would
 * re-queue a video that was finished by hand.
 *
 * Rides the hourly health tick rather than getting a cron of its own: hourly,
 * idempotent, usually a no-op — a third cron for work that is usually nothing
 * is a third thing that can silently stop.
 */

export interface HousekeepingSummary {
  pruned: Record<string, number>;
  message: string;
}

export async function runHousekeeping(
  supabase?: MuClient,
): Promise<HousekeepingSummary> {
  const client = supabase ?? createServiceClient();
  const pruned: Record<string, number> = {};

  const targets: Array<[string, string, number]> = [
    ["events", "at", ALERTS.retentionDays.events],
    ["webhook_events", "received_at", ALERTS.retentionDays.webhookEvents],
  ];

  for (const [table, column, days] of targets) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    try {
      const { data } = await client.from(table).delete().lt(column, cutoff).select("id");
      pruned[table] = (data ?? []).length;
    } catch {
      // Housekeeping must never fail a health tick.
      pruned[table] = 0;
    }
  }

  const total = Object.values(pruned).reduce((a, b) => a + b, 0);
  return { pruned, message: `${total} log row(s) pruned` };
}
