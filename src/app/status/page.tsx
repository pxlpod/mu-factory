import { redirect } from "next/navigation";

import { STUDIO, YOUTUBE } from "@/config/youtube";
import { openAlerts } from "@/lib/alerts";
import { ATTEMPT_POLICIES } from "@/lib/attempts";
import { isSignedIn } from "@/lib/auth";
import { runConfigCheck, type CheckLine } from "@/lib/config-check";
import { recentEvents } from "@/lib/events";
import { loadYoutubeCredentials, type YoutubeCredentials } from "@/lib/google/credentials";
import { readHeartbeats } from "@/lib/heartbeat";
import { createServiceClient } from "@/lib/supabase";
import type {
  AlertRow,
  EventRow,
  HeartbeatRow,
  WebhookEventRow,
  YoutubeFinishRow,
} from "@/types/db";

import { RunNowButton } from "./RunNowButton";

export const dynamic = "force-dynamic";

/**
 * The only page.
 *
 * THE CONFIG CHECK RUNS FIRST AND ALONE, and the data loads are allowed to
 * fail without taking the page with them. With `SUPABASE_URL` unset, building
 * a client throws, and a page that builds one before rendering answers "a
 * server error occurred" — which says nothing about the missing variable
 * while the red line that names it sits one function call away. The page
 * has to be legible at its least configured, because that is when it is most
 * needed (photo-publisher, 2026-09-08).
 */
export default async function StatusPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await isSignedIn())) redirect("/login");

  const params = await searchParams;
  const googleError = firstString(params.google_error);
  const googleConnected = firstString(params.google_connected);

  const checks = await runConfigCheck();

  let youtube: YoutubeCredentials | null = null;
  let beats: HeartbeatRow[] = [];
  let alerts: AlertRow[] = [];
  let finishes: YoutubeFinishRow[] = [];
  let events: EventRow[] = [];
  let webhooks: WebhookEventRow[] = [];
  let dataError: string | null = null;

  try {
    const supabase = createServiceClient();
    youtube = await loadYoutubeCredentials(supabase);
    beats = await readHeartbeats(supabase);
    alerts = await openAlerts(supabase);
    events = await recentEvents(50, supabase);

    const { data: finishRows, error: finishError } = await supabase
      .from("youtube_finish")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (finishError) throw new Error(finishError.message);
    finishes = (finishRows ?? []) as YoutubeFinishRow[];

    const { data: hooks } = await supabase
      .from("webhook_events")
      .select("*")
      .order("received_at", { ascending: false })
      .limit(10);
    webhooks = (hooks ?? []) as WebhookEventRow[];
  } catch (error) {
    dataError = error instanceof Error ? error.message : String(error);
  }

  const problemCount = events.filter((e) => e.level === "error").length;
  const waiting = finishes.filter((f) => rowLabel(f).problem).length;
  const gridPending = finishes.filter((f) => rowLabel(f).text === "grid pending").length;

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-medium">MU Factory</h1>
          <p className="text-[var(--muted)]">
            YouTube finisher. The sweep runs every fifteen minutes, the Shorts-grid
            pass seven minutes after it; health hourly.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <RunNowButton
            label="Run sweep now"
            busyLabel="Sweeping…"
            url="/api/youtube/sweep"
            primary
          />
          <RunNowButton label="Run grid pass" busyLabel="In Studio…" url="/api/youtube/grid" />
          <RunNowButton label="Run health check" busyLabel="Checking…" url="/api/health" />
        </div>
      </header>

      {dataError ? (
        <p
          className="rounded-lg border p-3"
          style={{ borderColor: "var(--bad)", color: "var(--bad)" }}
        >
          Could not read the database: {dataError}
        </p>
      ) : null}

      {googleError ? (
        <p
          className="rounded-lg border p-3"
          style={{ borderColor: "var(--bad)", color: "var(--bad)" }}
        >
          Google connect failed: {googleError}
        </p>
      ) : null}
      {googleConnected ? (
        <p className="rounded-lg border border-[var(--border)] p-3 text-[var(--ok)]">
          Google connected: {googleConnected}.
        </p>
      ) : null}

      {alerts.length > 0 ? (
        <Section title={`Needs you (${alerts.length})`}>
          <ul className="divide-y divide-[var(--border)]">
            {alerts.map((alert) => (
              <li key={alert.id} className="space-y-1 p-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Tag text={alert.condition} problem />
                  <span className="text-[var(--muted)]">
                    {alert.subject ? `${alert.subject} · ` : ""}
                    since {formatTime(alert.raised_at)} · seen {alert.count}x
                    {alert.last_notified_at ? "" : " · not yet notified on Monday"}
                  </span>
                </div>
                <p className="break-words text-[var(--bad)]">{alert.message}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Configuration">
        <ul className="divide-y divide-[var(--border)]">
          {checks.map((line) => (
            <ConfigRow key={line.label} line={line} />
          ))}
        </ul>
      </Section>

      <Section title="YouTube connection">
        <div className="space-y-2 p-3">
          {youtube ? (
            <p>
              Connected as <strong>{youtube.channel_title ?? "(unknown channel)"}</strong>{" "}
              <span className="text-[var(--muted)]">
                ({youtube.channel_id ?? "?"})
                {youtube.connected_at ? ` · since ${formatTime(youtube.connected_at)}` : ""}
                {" · scope "}
                {youtube.scope?.includes(YOUTUBE.scope) ? "youtube.force-ssl" : (youtube.scope ?? "?")}
              </span>
            </p>
          ) : (
            <p className="text-[var(--bad)]">
              Not connected. Nothing can be finished on YouTube until it is.
            </p>
          )}
          <a
            href="/google/connect"
            className="inline-block rounded border border-[var(--border)] px-3 py-1.5"
          >
            {youtube ? "Reconnect Google" : "Connect Google"}
          </a>
          <p className="text-[var(--muted)]">
            Sign in as the Google account that owns <strong>{YOUTUBE.channelHandle}</strong>.
            The consent screen must be <em>published</em>, not in testing — a
            testing-mode token expires after seven days and this page will turn red.
          </p>
        </div>
      </Section>

      <Section title="Cron heartbeats">
        <div className="p-3">
          {beats.length === 0 ? (
            <p className="text-[var(--muted)]">
              No cron has reported yet. If this persists after the first deploy,
              nothing is running.
            </p>
          ) : (
            <ul className="space-y-1">
              {beats.map((b) => (
                <li key={b.route} className="flex flex-wrap gap-2">
                  <span className="w-32 font-medium">{b.route}</span>
                  <span className="text-[var(--muted)]">
                    {formatTime(b.last_at)} · {b.status}
                    {b.detail ? ` · ${b.detail}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Section>

      <Section
        title={
          `YouTube finishes (${finishes.length})` +
          (waiting ? ` — ${waiting} waiting for you` : "") +
          (gridPending ? ` — ${gridPending} grid pending` : "")
        }
      >
        {finishes.length === 0 ? (
          <p className="p-3 text-[var(--muted)]">
            Nothing queued. A row appears when Zernio reports a published YouTube
            Short, or when the import script loads the publish queue.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="text-[var(--muted)]">
                <tr>
                  <Th>Ep</Th>
                  <Th>Video</Th>
                  <Th>State</Th>
                  <Th>Attempts</Th>
                  <Th>Lang</Th>
                  <Th>Caption</Th>
                  <Th>Thumb</Th>
                  <Th>Shorts grid</Th>
                  <Th>Last error</Th>
                </tr>
              </thead>
              <tbody>
                {finishes.map((row) => (
                  <tr key={row.platform_post_id} className="border-t border-[var(--border)]">
                    <Td>{row.ep ?? <span className="text-[var(--bad)]">unknown</span>}</Td>
                    <Td>
                      {row.video_id ? (
                        <a
                          href={`https://www.youtube.com/watch?v=${row.video_id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="underline"
                        >
                          {row.video_id}
                        </a>
                      ) : (
                        <span className="text-[var(--muted)]">—</span>
                      )}
                    </Td>
                    <Td>
                      <Tag text={rowLabel(row).text} problem={rowLabel(row).problem} />
                    </Td>
                    <Td>
                      {row.attempts}
                      {row.next_attempt_at ? (
                        <span className="text-[var(--muted)]">
                          {" "}
                          · next {formatTime(row.next_attempt_at)}
                        </span>
                      ) : null}
                    </Td>
                    <Td>{flag(row.language_set_at)}</Td>
                    <Td>
                      {flag(row.caption_set_at)} set · {flag(row.caption_verified_at)} verified
                    </Td>
                    <Td>
                      {flag(row.thumbnail_set_at)} set · {flag(row.thumbnail_verified_at)} verified
                      {row.thumbnail_distance !== null ? (
                        <span className="text-[var(--muted)]"> ({row.thumbnail_distance} bits)</span>
                      ) : null}
                    </Td>
                    <Td>
                      {flag(row.grid_thumbnail_set_at)} set · {flag(row.grid_thumbnail_verified_at)} verified
                      {row.grid_thumbnail_distance !== null ? (
                        <span className="text-[var(--muted)]"> ({row.grid_thumbnail_distance} bits)</span>
                      ) : null}
                      {!row.grid_thumbnail_verified_at && row.grid_attempts > 0 ? (
                        <span className="text-[var(--muted)]">
                          {" "}
                          · {row.grid_attempts}/{STUDIO.gridAttempts}
                          {row.grid_next_attempt_at ? ` · next ${formatTime(row.grid_next_attempt_at)}` : ""}
                        </span>
                      ) : null}
                    </Td>
                    <Td>
                      {row.last_error ? (
                        <span className="break-words text-[var(--bad)]">{row.last_error}</span>
                      ) : null}
                      {!row.grid_thumbnail_verified_at && row.grid_error ? (
                        <span className="break-words text-[var(--bad)]">
                          {row.last_error ? " · " : ""}Grid: {row.grid_error}
                        </span>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="border-t border-[var(--border)] p-3">
          <h3 className="mb-1 font-medium">Retry policy</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="text-[var(--muted)]">
                <tr>
                  <Th>Operation</Th>
                  <Th>Attempts</Th>
                  <Th>Then</Th>
                  <Th>To restart it</Th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(ATTEMPT_POLICIES).map(([name, p]) => (
                  <tr key={name} className="border-t border-[var(--border)]">
                    <Td>{name}</Td>
                    <Td>{Number.isFinite(p.maxAttempts) ? p.maxAttempts : "∞"}</Td>
                    <Td>
                      {p.atCap === "backoff"
                        ? `retry every ${Math.round(p.retryMs / 60000)} min`
                        : "wait for you"}
                    </Td>
                    <Td>{p.manualRetry}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Section>

      <Section title={`Webhooks (last ${webhooks.length})`}>
        {webhooks.length === 0 ? (
          <p className="p-3 text-[var(--muted)]">
            None received. Register <code>/api/webhooks/zernio</code> at Zernio and
            send a test event.
          </p>
        ) : (
          <ul className="space-y-1 p-3">
            {webhooks.map((hook) => (
              <li key={hook.id} className="flex flex-wrap gap-2">
                <span className="font-medium">{hook.event}</span>
                <span className="text-[var(--muted)]">
                  {formatTime(hook.received_at)}
                  {hook.processed_at ? " · processed" : " · not processed"}
                </span>
                {hook.error ? (
                  <span
                    className={
                      /^not MU|^ignored/.test(hook.error)
                        ? "text-[var(--muted)]"
                        : "text-[var(--bad)]"
                    }
                  >
                    {hook.event === "rejected"
                      ? `Delivery refused — ${hook.error}. Check ZERNIO_WEBHOOK_SECRET matches the secret registered at Zernio.`
                      : hook.error}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={
          `Events (${events.length}, newest first)` +
          (problemCount ? ` — ${problemCount} needing attention` : "")
        }
      >
        {events.length === 0 ? (
          <p className="p-3 text-[var(--muted)]">No events yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {events.map((event) => (
              <li key={event.id} className="space-y-1 p-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Tag text={event.level} problem={event.level === "error"} />
                  <span className="text-[var(--muted)]">{event.area}</span>
                  {event.ep ? <span className="font-medium">{event.ep}</span> : null}
                  <span className="text-[var(--muted)]">{formatTime(event.at)}</span>
                </div>
                <p
                  className="break-words"
                  style={{
                    color:
                      event.level === "error"
                        ? "var(--bad)"
                        : event.level === "warn"
                          ? "var(--text)"
                          : "var(--muted)",
                  }}
                >
                  {event.message}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="font-medium">{title}</h2>
      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)]">
        {children}
      </div>
    </section>
  );
}

function ConfigRow({ line }: { line: CheckLine }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3">
      <span
        aria-hidden
        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ background: line.ok ? "var(--ok)" : "var(--bad)" }}
      />
      <span className="sr-only">{line.ok ? "OK" : "Problem"}</span>
      <span className="w-64 font-medium">{line.label}</span>
      <span
        className="flex-1 break-words"
        style={{ color: line.ok ? "var(--muted)" : "var(--bad)" }}
      >
        {line.detail}
      </span>
    </li>
  );
}

function Tag({ text, problem }: { text: string; problem?: boolean }) {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-xs uppercase tracking-wide"
      style={{
        border: `1px solid ${problem ? "var(--bad)" : "var(--border)"}`,
        color: problem ? "var(--bad)" : "var(--muted)",
      }}
    >
      {text}
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2 font-normal">{children}</th>;
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 align-top">{children}</td>;
}

function flag(iso: string | null): string {
  return iso ? "✓" : "·";
}

/**
 * What to call a row. "done" is reserved for a row verified on BOTH slots —
 * the classic thumbnail and caption (state = done) and the Shorts-grid card
 * (grid_thumbnail_verified_at). A row the sweep has finished but whose grid
 * card has not been read back is "grid pending", and one that has used its
 * grid attempts is waiting for a human even though its state column says done.
 */
function rowLabel(row: YoutubeFinishRow): { text: string; problem: boolean } {
  if (row.state !== "done") {
    return { text: row.state, problem: row.state === "wait-for-human" };
  }
  if (row.grid_thumbnail_verified_at) return { text: "done", problem: false };
  if (row.grid_attempts >= STUDIO.gridAttempts) {
    return { text: "grid: wait-for-human", problem: true };
  }
  return { text: "grid pending", problem: false };
}

function formatTime(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function firstString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
