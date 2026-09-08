import { ALERTS, type AlertCondition } from "@/config/alerts";
import { mondayConfigured, notify } from "@/lib/monday";
import { createServiceClient, type MuClient } from "@/lib/supabase";
import type { AlertRow } from "@/types/db";

/**
 * Raising and clearing alert conditions.
 *
 * ONE ALERT PER CONDITION UNTIL IT CHANGES. Every caller here is inside a loop
 * that runs every fifteen minutes, so the naive version of this file would
 * send the same notification 96 times a day. The rule is enforced in one
 * place — `raiseAlert` — rather than trusted to each caller, because a caller
 * that forgets is not a bug anyone notices until the notifications are muted.
 *
 * A condition is:
 *   raised   → row created, Monday notification sent, cooldown starts
 *   still on → row touched, nothing sent until the cooldown lapses
 *   cleared  → one "resolved" notification, row closed
 *
 * A resolved condition that recurs is a new raise, because the interesting
 * fact is that it came back.
 *
 * THE CHANNEL IS MONDAY. `create_notification` aimed at the episode's
 * Publishing item when the caller knows it, else at the fallback item from
 * config. Copied from photo-publisher; the channel is Monday, nothing else (2026-09-08).
 */

export async function raiseAlert(opts: {
  supabase?: MuClient;
  condition: AlertCondition;
  /** What distinguishes this instance: an episode, a video id, a route. */
  subject?: string;
  message: string;
  /** The Publishing item to notify on. Null → the fallback item. */
  mondayItemId?: string | null;
  payload?: Record<string, unknown>;
}): Promise<{ sent: boolean; suppressed: boolean; reason: string }> {
  const supabase = opts.supabase ?? createServiceClient();
  const key = conditionKey(opts.condition, opts.subject);

  const { data } = await supabase
    .from("alerts")
    .select("*")
    .eq("condition_key", key)
    .maybeSingle();

  const existing = data as AlertRow | null;
  const now = new Date();
  const cooldownMs = ALERTS.cooldownHours * 60 * 60 * 1000;

  // Open, recently sent: touch it and stay quiet.
  if (existing && !existing.resolved_at) {
    const sentAgo = existing.last_notified_at
      ? now.getTime() - new Date(existing.last_notified_at).getTime()
      : Number.POSITIVE_INFINITY;

    await supabase
      .from("alerts")
      .update({
        last_seen_at: now.toISOString(),
        count: existing.count + 1,
        message: opts.message,
        payload: { ...(opts.payload ?? {}), mondayItemId: opts.mondayItemId ?? null } as never,
      })
      .eq("id", existing.id);

    if (sentAgo < cooldownMs) {
      return {
        sent: false,
        suppressed: true,
        reason: `already alerted ${Math.round(sentAgo / 60000)} minutes ago`,
      };
    }
  }

  const result = mondayConfigured()
    ? await notify(`⚠️ ${opts.message}`, opts.mondayItemId)
    : { sent: false, error: "Monday is not configured" };

  await supabase.from("alerts").upsert(
    {
      condition_key: key,
      condition: opts.condition,
      subject: opts.subject ?? null,
      last_seen_at: now.toISOString(),
      // Only stamp last_notified_at on a real send, so a Monday outage does not
      // start a 24-hour silence on a condition nobody was told about.
      ...(result.sent ? { last_notified_at: now.toISOString() } : {}),
      resolved_at: null,
      count: existing ? existing.count + 1 : 1,
      message: opts.message,
      payload: {
        ...(opts.payload ?? {}),
        mondayItemId: opts.mondayItemId ?? null,
        lastSendError: result.sent ? null : (result.error ?? "not sent"),
      } as never,
      ...(existing ? {} : { raised_at: now.toISOString() }),
    },
    { onConflict: "condition_key" },
  );

  return {
    sent: result.sent,
    suppressed: false,
    reason: result.sent ? "sent" : (result.error ?? "not sent"),
  };
}

/**
 * Closes a condition, and says so once.
 *
 * The resolved message matters as much as the alert: without it, a condition
 * that fixed itself leaves the reader believing something is still broken,
 * and the next real alert arrives against that background.
 */
export async function resolveAlert(opts: {
  supabase?: MuClient;
  condition: AlertCondition;
  subject?: string;
  message?: string;
  mondayItemId?: string | null;
}): Promise<{ resolved: boolean }> {
  const supabase = opts.supabase ?? createServiceClient();
  const key = conditionKey(opts.condition, opts.subject);

  const { data } = await supabase
    .from("alerts")
    .select("*")
    .eq("condition_key", key)
    .is("resolved_at", null)
    .maybeSingle();

  const open = data as AlertRow | null;
  if (!open) return { resolved: false };

  await supabase
    .from("alerts")
    .update({ resolved_at: new Date().toISOString() })
    .eq("id", open.id);

  // Only worth announcing if the raise was announced, and on the same item.
  if (open.last_notified_at && mondayConfigured()) {
    const payload = (open.payload ?? {}) as { mondayItemId?: string | null };
    await notify(
      `✅ ${opts.message ?? `Resolved: ${open.message ?? key}`}`,
      opts.mondayItemId ?? payload.mondayItemId ?? null,
    );
  }

  return { resolved: true };
}

export async function openAlerts(supabase?: MuClient): Promise<AlertRow[]> {
  const client = supabase ?? createServiceClient();
  const { data } = await client
    .from("alerts")
    .select("*")
    .is("resolved_at", null)
    .order("last_seen_at", { ascending: false })
    .limit(50);
  return (data ?? []) as AlertRow[];
}

function conditionKey(condition: AlertCondition, subject?: string): string {
  return subject ? `${condition}:${subject}` : condition;
}
