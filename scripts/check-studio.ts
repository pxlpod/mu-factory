/**
 * Studio session check — is the stored session still signed in?
 *
 * Reads `mu.credentials` "studio_session", opens studio.youtube.com in a
 * headless browser under the exported user agent, and reports where it
 * landed. Opens nothing else and writes nothing — the cookies are NOT written
 * back, so this cannot overwrite a good export. Set CHROMIUM_EXECUTABLE_PATH
 * to a local Chrome; without it the serverless Chromium build inflates into
 * the temp directory, which also works.
 *
 *   npx tsx scripts/check-studio.ts
 *
 * Christopher's tool. Pausha never runs it.
 */

import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

async function main() {
  const { STUDIO } = await import("../src/config/youtube");
  const {
    assertSignedIn,
    describeStudioSession,
    launchBrowser,
    loadStudioSession,
    openStudioContext,
    StudioSessionExpiredError,
  } = await import("../src/lib/studio");

  const summary = await describeStudioSession();
  if (!summary) {
    console.log(`No "${STUDIO.credentialKey}" row in mu.credentials. Run studio_bot.mjs login && export.`);
    process.exitCode = 1;
    return;
  }
  console.log(`cookies          ${summary.cookies}`);
  console.log(`exported at      ${summary.exported_at ?? "?"}`);
  console.log(`refreshed at     ${summary.refreshed_at ?? "never (no hosted run yet)"}`);
  console.log(`earliest expiry  ${summary.earliest_expiry ?? "none recorded"}`);

  const session = (await loadStudioSession())!;
  const browser = await launchBrowser();
  try {
    const context = await openStudioContext(browser, session);
    const page = await context.newPage();
    await page.goto("https://studio.youtube.com/", { waitUntil: "domcontentloaded" });
    assertSignedIn(page);
    console.log(`\nSigned in. Studio landed on ${page.url()} ("${await page.title()}").`);
  } catch (error) {
    if (error instanceof StudioSessionExpiredError) {
      console.log(`\n${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
