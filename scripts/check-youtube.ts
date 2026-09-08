/**
 * YouTube connection check — quota-free probes only.
 *
 * Prints what is stored in `mu.credentials` for provider `youtube`, then makes
 * ONE `channels.list(mine)` call (1 quota unit) to prove the refresh token
 * still works and to show which channel it belongs to. Optionally takes a
 * video id and reads its snippet/status and caption list (1 + 50 units) to
 * show exactly what the sweep would see — no writes.
 *
 *   npx tsx scripts/check-youtube.ts
 *   npx tsx scripts/check-youtube.ts <videoId>
 *
 * Never uploads, never sets, never inserts.
 */

import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

async function main() {
  const [, , videoId] = process.argv;

  const { loadYoutubeCredentials } = await import("../src/lib/google/credentials");
  const { redirectUri } = await import("../src/lib/google/auth");
  const { probeChannel, getVideo, listCaptions, findOverrideTrack } =
    await import("../src/lib/youtube/client");
  const { YOUTUBE } = await import("../src/config/youtube");

  console.log(`redirect URI     ${redirectUri()}`);
  console.log(`scope            ${YOUTUBE.scope}`);

  const stored = await loadYoutubeCredentials();
  if (!stored) {
    console.log("\nNot connected. Open /status and press Connect Google.");
    return;
  }
  console.log(`stored channel   ${stored.channel_title ?? "?"} (${stored.channel_id ?? "?"})`);
  console.log(`connected at     ${stored.connected_at ?? "?"}`);
  console.log(`access expiry    ${stored.expiry_date ? new Date(stored.expiry_date).toISOString() : "?"}`);

  const channel = await probeChannel();
  console.log(`live channel     ${channel.title} (${channel.id})  ← token works`);

  if (!videoId) return;

  const video = await getVideo(videoId);
  if (!video) {
    console.log(`\nvideo ${videoId}: NOT FOUND for this channel`);
    return;
  }
  console.log(`\nvideo            ${video.id}  "${video.title}"`);
  console.log(`privacy          ${video.privacyStatus ?? "?"}  upload ${video.uploadStatus ?? "?"}`);
  console.log(`defaultLanguage  ${video.defaultLanguage ?? "(unset)"}  audio ${video.defaultAudioLanguage ?? "(unset)"}`);
  console.log(`thumbnails       ${Object.keys(video.thumbnails).join(", ") || "none"}`);

  const tracks = await listCaptions(videoId);
  console.log(`captions         ${tracks.length}`);
  for (const t of tracks) {
    console.log(`  ${t.id}  ${t.language}  ${t.trackKind}  "${t.name}"${t.isDraft ? "  draft" : ""}`);
  }
  const override = findOverrideTrack(tracks);
  console.log(override ? `override track   present (${override.id})` : "override track   MISSING — the sweep would insert one");
}

main().catch((error) => {
  console.error(`\nFAILED: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
