/**
 * Read-only Drive check.
 *
 * Proves the three things that have to be true before the sweep can fetch a
 * cover, and says which one is wrong when it isn't: the service-account key
 * decodes, the account can see the MU root folder at all (that is the share),
 * and `Covers/yt` resolves by name under it. Lists what is there.
 *
 * Lists only. Downloads nothing, writes nothing. Adapted from photo-publisher.
 *
 *   npx tsx scripts/check-drive.ts
 */

import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

async function main() {
  const { createDriveClient, listFiles, resolveFolders, serviceAccountEmail } =
    await import("../src/lib/drive");
  const { FILE_NAMES } = await import("../src/config/factory");

  console.log(`service account  ${serviceAccountEmail()}`);

  const drive = createDriveClient();
  const folders = await resolveFolders(drive);
  console.log(`root folder      ${folders.root}`);
  console.log(`Covers/yt        ${folders.coversYt}`);

  const files = await listFiles(drive, folders.coversYt, 500);
  const pattern = new RegExp("^" + FILE_NAMES.coverYt("(Ep\\d{3})").replace(".", "\\.") + "$");
  let matching = 0;

  console.log(`\nCovers/yt holds ${files.length} file(s):`);
  for (const file of files) {
    const ok = pattern.test(file.name) && file.mimeType === "image/jpeg";
    if (ok) matching += 1;
    console.log(
      `  ${ok ? " " : "?"} ${file.name}  ${file.mimeType}  ${file.size?.toLocaleString() ?? "?"} bytes` +
        (file.size && file.size > 2 * 1024 * 1024 ? "  OVER 2 MB" : ""),
    );
  }
  console.log(`\n${matching} look like cover_<Ep>.jpg; "?" marks anything the sweep would ignore.`);
}

main().catch((error) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
