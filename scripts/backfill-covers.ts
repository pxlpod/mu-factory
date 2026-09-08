/**
 * Mirrors every `cover_<Ep>.jpg` in Drive `Covers/yt` into the `mu-media`
 * bucket and the `media` table, verified by read-back.
 *
 *   npx tsx scripts/backfill-covers.ts
 *
 * Same code path as the sweep (`ensureCoverYt`), so a cover this script
 * mirrors is exactly the cover the finisher would send. A JPEG over YouTube's
 * 2 MB cap is reported and NOT stored — never re-encoded. Idempotent: a cover
 * already mirrored with a matching checksum is left alone.
 */

import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

async function main() {
  const { createDriveClient, listFiles, resolveFolders } = await import("../src/lib/drive");
  const { ensureCoverYt, CoverTooLargeError } = await import("../src/lib/media");
  const { createServiceClient } = await import("../src/lib/supabase");
  const { logEvent } = await import("../src/lib/events");

  const supabase = createServiceClient();
  const drive = createDriveClient();
  const folders = await resolveFolders(drive);

  const files = await listFiles(drive, folders.coversYt, 1000);
  const eps = files
    .map((f) => /^cover_(Ep\d{3})\.jpg$/i.exec(f.name)?.[1])
    .filter((ep): ep is string => Boolean(ep));

  console.log(`${files.length} file(s) in Covers/yt, ${eps.length} look like cover_<Ep>.jpg`);

  let mirrored = 0;
  let alreadyThere = 0;
  const tooLarge: string[] = [];
  const failed: string[] = [];

  for (const ep of eps) {
    try {
      const result = await ensureCoverYt(supabase, drive, folders, ep);
      if (result.status !== "ready") {
        failed.push(`${ep}: not found on second look`);
        continue;
      }
      if (result.fresh) {
        mirrored += 1;
        console.log(`  mirrored  ${ep}  ${result.bytes.length.toLocaleString()} bytes  ${result.sha256.slice(0, 12)}…`);
      } else {
        alreadyThere += 1;
      }
    } catch (error) {
      if (error instanceof CoverTooLargeError) {
        tooLarge.push(`${ep}: ${error.bytes.toLocaleString()} bytes`);
      } else {
        failed.push(`${ep}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  console.log(`\nmirrored      ${mirrored}`);
  console.log(`already there ${alreadyThere}`);
  if (tooLarge.length) {
    console.log(`\nOVER 2 MB (not stored — re-export smaller):`);
    for (const line of tooLarge) console.log(`  ${line}`);
  }
  if (failed.length) {
    console.log(`\nfailed:`);
    for (const line of failed) console.log(`  ${line}`);
  }

  await logEvent(supabase, {
    level: tooLarge.length || failed.length ? "warn" : "info",
    area: "cover",
    message: `Cover backfill: ${mirrored} mirrored, ${alreadyThere} already present, ${tooLarge.length} over 2 MB, ${failed.length} failed.`,
    detail: { tooLarge, failed },
  });

  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
