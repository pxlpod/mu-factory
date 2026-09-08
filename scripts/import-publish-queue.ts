/**
 * Imports the Mac's `Publish-Queue.csv` into `mu.episodes` and
 * `mu.platform_posts`, and optionally marks already-finished YouTube posts done.
 *
 *   npx tsx scripts/import-publish-queue.ts ~/path/Publish-Queue.csv
 *   npx tsx scripts/import-publish-queue.ts ~/path/Publish-Queue.csv --youtube-done-through 2026-09-01
 *
 * ONE-TIME, RUN BY CHRISTOPHER, NEVER BY PAUSHA. It exists because the
 * episodes published before this app existed have no `metadata.episode` on
 * their Zernio posts; the CSV is the only thing that maps a Zernio post id to
 * an Ep. After the import, the sweep's poll fills in YouTube video ids from
 * Zernio and the webhook takes over for new posts.
 *
 * `--youtube-done-through YYYY-MM-DD` marks the `youtube_finish` row for every
 * YouTube post with post_date on or before that date as `done` — a human
 * already uploaded the thumbnail and the caption track in YouTube Studio.
 * Both verified timestamps are set to the import time (the database refuses
 * a `done` row without them), and the sweep never re-opens a `done` row.
 *
 * IDEMPOTENT. Upserts keyed on `ep` and `(platform, zernio_post_id)`; running
 * it twice with the same file changes nothing the second time. An existing
 * finish row's state is never changed by a re-import — a `done` stays done,
 * and a row the sweep has moved on is left where the sweep put it.
 *
 * Columns (CRLF, quoted fields): ep, slug, lane, series, look, question,
 * duration_s, file, post_date, post_time_local, timezone, status,
 * tiktok_post_id, instagram_post_id, youtube_post_id, facebook_post_id,
 * text_post_date, facebook_text_post_id, notes.
 */

import { readFileSync } from "node:fs";

import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

interface CsvRow {
  ep: string;
  slug: string;
  lane: string;
  series: string;
  look: string;
  question: string;
  duration_s: string;
  file: string;
  post_date: string;
  post_time_local: string;
  timezone: string;
  status: string;
  tiktok_post_id: string;
  instagram_post_id: string;
  youtube_post_id: string;
  facebook_post_id: string;
  text_post_date: string;
  facebook_text_post_id: string;
  notes: string;
}

/**
 * RFC 4180-ish parser: quoted fields, doubled quotes, CRLF or LF. No
 * dependency — the file is small and the shape is known.
 */
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((v) => v !== "")) rows.push(row);
  }

  const [header, ...body] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.replace(/^﻿/, "").trim());
  return body.map((values) =>
    Object.fromEntries(keys.map((k, i) => [k, (values[i] ?? "").trim()])),
  );
}

function blank(value: string): string | null {
  return value === "" ? null : value;
}

async function main() {
  const [, , csvPath, ...flags] = process.argv;
  if (!csvPath) {
    throw new Error("Usage: npx tsx scripts/import-publish-queue.ts <csv> [--youtube-done-through YYYY-MM-DD]");
  }

  const doneFlag = flags.indexOf("--youtube-done-through");
  const doneThrough = doneFlag >= 0 ? flags[doneFlag + 1] : null;
  if (doneFlag >= 0 && !/^\d{4}-\d{2}-\d{2}$/.test(doneThrough ?? "")) {
    throw new Error("--youtube-done-through needs a YYYY-MM-DD date");
  }

  const { EPISODE_PATTERN } = await import("../src/config/factory");
  const { ZERNIO } = await import("../src/config/zernio");
  const { createServiceClient } = await import("../src/lib/supabase");
  const { logEvent } = await import("../src/lib/events");
  const { upsertPlatformPost, ensureFinishRow } = await import("../src/lib/zernio/posts");

  const supabase = createServiceClient();
  const rows = parseCsv(readFileSync(csvPath, "utf8")) as unknown as CsvRow[];
  console.log(`read ${rows.length} row(s) from ${csvPath}`);

  let episodes = 0;
  let posts = 0;
  let finishes = 0;
  let markedDone = 0;
  const skipped: string[] = [];

  for (const row of rows) {
    const ep = row.ep?.trim();
    if (!ep || !EPISODE_PATTERN.test(ep)) {
      skipped.push(`"${row.ep}" is not an episode id`);
      continue;
    }

    const { error } = await supabase.from("episodes").upsert(
      {
        ep,
        slug: blank(row.slug),
        lane: blank(row.lane),
        series: blank(row.series),
        look: blank(row.look),
        question: blank(row.question),
        duration_s: row.duration_s && !Number.isNaN(Number(row.duration_s)) ? Number(row.duration_s) : null,
        final_file: blank(row.file),
        post_date: blank(row.post_date),
        post_time_local: blank(row.post_time_local),
        timezone: blank(row.timezone),
        queue_status: blank(row.status),
      },
      { onConflict: "ep" },
    );
    if (error) throw new Error(`${ep}: episodes upsert failed: ${error.message}`);
    episodes += 1;

    const legs: Array<{
      platform: "tiktok" | "instagram" | "youtube" | "facebook";
      kind: "video" | "text";
      id: string | null;
    }> = [
      { platform: "tiktok", kind: "video", id: blank(row.tiktok_post_id) },
      { platform: "instagram", kind: "video", id: blank(row.instagram_post_id) },
      { platform: "youtube", kind: "video", id: blank(row.youtube_post_id) },
      { platform: "facebook", kind: "video", id: blank(row.facebook_post_id) },
      { platform: "facebook", kind: "text", id: blank(row.facebook_text_post_id) },
    ];

    for (const leg of legs) {
      if (!leg.id) continue;

      const saved = await upsertPlatformPost(supabase, {
        ep,
        platform: leg.platform,
        kind: leg.kind,
        zernioPostId: leg.id,
        zernioAccountId: ZERNIO.accountIds[leg.platform],
        platformPostId: null,
        publishedUrl: null,
        status: null,
        scheduledFor: null,
        publishedAt: null,
        source: "import",
        raw: { import: row },
      });
      posts += 1;

      if (leg.platform === "youtube") {
        const { created } = await ensureFinishRow(supabase, {
          platformPostId: saved.id,
          ep,
          videoId: null,
        });
        if (created) finishes += 1;

        if (doneThrough && row.post_date && row.post_date <= doneThrough) {
          const now = new Date().toISOString();
          const { data } = await supabase
            .from("youtube_finish")
            .update({
              state: "done",
              thumbnail_verified_at: now,
              caption_verified_at: now,
              thumbnail_set_at: now,
              caption_set_at: now,
              last_error: null,
              next_attempt_at: null,
            })
            .eq("platform_post_id", saved.id)
            .eq("state", "pending")
            .is("last_attempt_at", null)
            .select("platform_post_id");
          if (data && data.length > 0) markedDone += 1;
        }
      }
    }
  }

  await logEvent(supabase, {
    level: "info",
    area: "import",
    message:
      `Publish-Queue.csv imported: ${episodes} episode(s), ${posts} post row(s), ` +
      `${finishes} new finish row(s)` +
      (doneThrough ? `, ${markedDone} marked done through ${doneThrough}` : ""),
    detail: { skipped },
  });

  console.log(`episodes upserted   ${episodes}`);
  console.log(`post rows upserted  ${posts}`);
  console.log(`finish rows created ${finishes}`);
  if (doneThrough) console.log(`marked done         ${markedDone} (post_date <= ${doneThrough})`);
  if (skipped.length) {
    console.log(`\nskipped ${skipped.length} row(s):`);
    for (const s of skipped) console.log(`  ${s}`);
  }
}

main().catch((error) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
