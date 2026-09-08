"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * Calls the same route the cron calls, so pressing it proves the cron.
 *
 * It reports the run's own summary line rather than just refreshing, because
 * the most common answer is "nothing pending" and a page that silently
 * redraws itself does not say that. Copied from photo-publisher and made
 * generic over label + route (2026-09-08).
 */
export function RunNowButton({
  label,
  busyLabel,
  url,
  primary = false,
}: {
  label: string;
  busyLabel: string;
  url: string;
  primary?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch(url, { method: "POST" });
      const body = (await res.json()) as {
        message?: string;
        error?: string;
        ok?: boolean;
        results?: Array<{ name: string; ok: boolean; detail: string }>;
      };
      if (body.error) setResult(`Error: ${body.error}`);
      else if (body.message) setResult(body.message);
      else if (body.results) {
        const bad = body.results.filter((r) => !r.ok);
        setResult(
          bad.length === 0
            ? "Health: all green"
            : `Health: ${bad.map((r) => `${r.name} — ${r.detail}`).join("; ")}`,
        );
      } else setResult("Done.");
    } catch (error) {
      setResult(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
      startTransition(() => router.refresh());
    }
  }

  const busy = running || pending;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className={
          primary
            ? "rounded bg-[var(--text)] px-3 py-1.5 text-[var(--bg)] disabled:opacity-50"
            : "rounded border border-[var(--border)] px-3 py-1.5 disabled:opacity-40"
        }
      >
        {busy ? busyLabel : label}
      </button>
      {result ? (
        <span className="max-w-xl break-words text-[var(--muted)]">{result}</span>
      ) : null}
    </div>
  );
}
