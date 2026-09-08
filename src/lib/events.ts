import type { EventArea } from "@/config/factory";
import { createServiceClient, type MuClient } from "@/lib/supabase";
import type { EventLevel, EventRow } from "@/types/db";

/**
 * The one place anything writes to `mu.events`.
 *
 * `console.*` IS NOT A SURFACE. Nobody operating MU reads Vercel logs — Pausha
 * never opens a terminal and Christopher should not have to. Every outcome the
 * sweep, the webhook, the health probe or a script produces is a row here, and
 * `/status` shows the last fifty. A new failure mode means a new `logEvent`
 * call with a clear message, never a `console.error` (rule carried from
 * photo-publisher, 2026-09-08).
 *
 * One writer so the shape cannot drift: level, area, message, optional detail,
 * the episode when known, the run when inside one.
 */
export async function logEvent(
  supabase: MuClient | null,
  entry: {
    level: EventLevel;
    area: EventArea;
    message: string;
    detail?: Record<string, unknown> | null;
    ep?: string | null;
    runId?: string | null;
  },
): Promise<void> {
  const client = supabase ?? createServiceClient();
  try {
    await client.from("events").insert({
      level: entry.level,
      area: entry.area,
      message: entry.message.slice(0, 4000),
      detail: (entry.detail ?? null) as never,
      ep: entry.ep ?? null,
      run_id: entry.runId ?? null,
    });
  } catch {
    // A log row that cannot be written must never fail the work it describes.
    // The heartbeat and the health probe are the second line for a dead database.
  }
}

export async function recentEvents(
  limit: number,
  supabase?: MuClient,
): Promise<EventRow[]> {
  const client = supabase ?? createServiceClient();
  const { data } = await client
    .from("events")
    .select("*")
    .order("at", { ascending: false })
    .limit(limit);
  return (data ?? []) as EventRow[];
}
