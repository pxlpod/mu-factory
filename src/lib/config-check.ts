import { MEDIA_BUCKET, MU_SCHEMA } from "@/config/factory";
import { MONDAY, alertFallbackItemId } from "@/config/monday";
import { ZERNIO } from "@/config/zernio";
import {
  createDriveClient,
  describe,
  resolveFolders,
  serviceAccountEmail,
} from "@/lib/drive";
import { loadYoutubeCredentials } from "@/lib/google/credentials";
import { describeStudioSession } from "@/lib/studio";
import { checkBoard } from "@/lib/monday";
import { createServiceClient } from "@/lib/supabase";
import { probeProfile } from "@/lib/zernio/client";

/**
 * The status page's config check.
 *
 * EXISTS BECAUSE NOBODY HERE READS VERCEL LOGS. Every failure this system has
 * is quiet: a Drive folder renamed, a Monday column deleted, a schema not
 * exposed to PostgREST, a Google consent screen left in Testing. None of them
 * throw anywhere a person would see; all of them look identical from YouTube,
 * which is "the captions are still doubled". One red line per cause turns a
 * mystery into a task. Copied from photo-publisher (2026-09-08).
 *
 * `requiredEnv()` is the single list of what must be set; the health probe
 * and this page both read it, so they cannot disagree.
 */

export interface CheckLine {
  label: string;
  ok: boolean;
  detail: string;
}

export function requiredEnv(): string[] {
  return [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "MONDAY_API_TOKEN",
    "MONDAY_ALERT_ITEM_ID",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
    "DRIVE_ROOT_FOLDER_ID",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "APP_URL",
    "ZERNIO_API_KEY",
    "ZERNIO_WEBHOOK_SECRET",
    "CRON_SECRET",
    "APP_PASSWORD",
  ];
}

export async function runConfigCheck(): Promise<CheckLine[]> {
  const lines: CheckLine[] = [];

  lines.push(...envLines());
  lines.push(await supabaseLine());
  lines.push(await storageLine());
  lines.push(...(await driveLines()));
  lines.push(...(await mondayLines()));
  lines.push(await youtubeLine());
  lines.push(await studioLine());
  lines.push(await zernioLine());

  return lines;
}

function envLines(): CheckLine[] {
  const required = requiredEnv();
  const missing = required.filter((name) => !process.env[name]);

  return [
    {
      label: "Environment variables",
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `All ${required.length} set.`
          : `Missing: ${missing.join(", ")}`,
    },
  ];
}

async function supabaseLine(): Promise<CheckLine> {
  const label = `Supabase schema \`${MU_SCHEMA}\``;
  try {
    const supabase = createServiceClient();
    const { error } = await supabase
      .from("episodes")
      .select("ep", { count: "exact", head: true });

    if (error) {
      // PGRST106 is the specific, and very common, failure: the tables exist
      // but PostgREST is not serving the schema, so every query 404s.
      const isSchemaNotExposed = /PGRST106|schema must be one of/i.test(
        `${error.code ?? ""} ${error.message}`,
      );
      return {
        label,
        ok: false,
        detail: isSchemaNotExposed
          ? `Schema not exposed to the API. Supabase dashboard → Project Settings ` +
            `→ API → Exposed schemas → add \`${MU_SCHEMA}\`.`
          : `${error.message} (has the migration been run?)`,
      };
    }

    return { label, ok: true, detail: "Reachable; migration applied." };
  } catch (error) {
    return { label, ok: false, detail: describe(error) };
  }
}

async function storageLine(): Promise<CheckLine> {
  const label = `Storage bucket \`${MEDIA_BUCKET}\``;
  try {
    const supabase = createServiceClient();
    const { error } = await supabase.storage.from(MEDIA_BUCKET).list("", { limit: 1 });
    return {
      label,
      ok: !error,
      detail: error ? error.message : "Present and readable by the service role.",
    };
  } catch (error) {
    return { label, ok: false, detail: describe(error) };
  }
}

async function driveLines(): Promise<CheckLine[]> {
  let email = "(key unreadable)";
  try {
    email = serviceAccountEmail();
  } catch (error) {
    return [{ label: "Drive service account", ok: false, detail: describe(error) }];
  }

  try {
    const drive = createDriveClient();
    const folders = await resolveFolders(drive);
    return [
      { label: "Drive service account", ok: true, detail: email },
      {
        label: "Drive folders",
        ok: true,
        detail: `root ${folders.root.slice(0, 8)}…, Covers/yt ${folders.coversYt.slice(0, 8)}…`,
      },
    ];
  } catch (error) {
    return [
      { label: "Drive service account", ok: true, detail: email },
      {
        label: "Drive folders",
        ok: false,
        detail: `${describe(error)} (is the MU root folder shared with ${email}?)`,
      },
    ];
  }
}

async function mondayLines(): Promise<CheckLine[]> {
  const check = await checkBoard();

  const board: CheckLine = {
    label: `Monday Publishing board ${MONDAY.boards.publishing}`,
    ok: check.error === null && check.boardName !== null,
    detail: check.error ?? check.boardName ?? "not found",
  };

  const columns: CheckLine = {
    label: "Monday Publishing columns",
    ok: check.ok,
    detail: check.ok
      ? `All ${Object.keys(MONDAY.publishingColumns).length} columns present.`
      : [
          check.missingColumns.length
            ? `Missing columns: ${check.missingColumns.join(", ")}`
            : null,
          check.error,
        ]
          .filter(Boolean)
          .join(" · "),
  };

  const fallback = alertFallbackItemId();
  const alerts: CheckLine = {
    label: "Monday alert target",
    ok: Boolean(fallback),
    detail: fallback
      ? `Alerts with no episode go to item ${fallback}; episode alerts go to the Publishing item.`
      : `${MONDAY.alertFallbackItemEnv} is not set — alerts without an episode have nowhere to go.`,
  };

  return [board, columns, alerts];
}

/**
 * Whether YouTube is connected, and as which channel.
 *
 * The channel matters more than a boolean: the token authorises editing
 * whichever channel authorised it, and connecting the wrong Google account is
 * a mistake that only shows up when every finish fails with "video not found".
 * The live probe (channels.list) is the health check's job; this line reads
 * the stored record so the page renders without spending quota.
 */
async function youtubeLine(): Promise<CheckLine> {
  try {
    const stored = await loadYoutubeCredentials();
    return stored
      ? {
          label: "YouTube",
          ok: true,
          detail: `Connected as ${stored.channel_title ?? "(unknown channel)"} (${stored.channel_id ?? "?"})${stored.connected_at ? `, since ${stored.connected_at.slice(0, 10)}` : ""}.`,
        }
      : {
          label: "YouTube",
          ok: false,
          detail: "Not connected. Press Connect Google below.",
        };
  } catch (error) {
    return { label: "YouTube", ok: false, detail: describe(error) };
  }
}

/**
 * The YouTube Studio session that sets the Shorts-grid thumbnail.
 *
 * Read from the stored record — never by opening Studio, which is the grid
 * pass's job and the only honest test. What this line can say is whether a
 * session is stored at all, when the Mac exported it, when a run last wrote
 * the rotated cookies back, and when the earliest cookie lapses. An expired
 * session shows up as the `studio.session_expired` alert above, not here.
 */
async function studioLine(): Promise<CheckLine> {
  const label = "YouTube Studio session";
  try {
    const session = await describeStudioSession();
    if (!session) {
      return {
        label,
        ok: false,
        detail:
          `Not stored. Shorts-grid thumbnails cannot be set until Christopher runs ` +
          `studio_bot.mjs login && export on the Mac.`,
      };
    }
    return {
      label,
      ok: true,
      detail:
        `${session.cookies} cookies` +
        (session.exported_at ? `, exported ${session.exported_at.slice(0, 16)}Z` : "") +
        (session.refreshed_at ? `, refreshed ${session.refreshed_at.slice(0, 16)}Z` : ", never refreshed by a run") +
        (session.earliest_expiry ? `, earliest cookie expiry ${session.earliest_expiry.slice(0, 10)}` : "") +
        ".",
    };
  } catch (error) {
    return { label, ok: false, detail: describe(error) };
  }
}

/**
 * Zernio, resolved by id and checked by name.
 *
 * The failure this catches is a config typo that would read a client's
 * profile: the id in config must belong to the profile named `Default`.
 */
async function zernioLine(): Promise<CheckLine> {
  const label = `Zernio profile \`${ZERNIO.profileName}\``;
  if (!process.env.ZERNIO_API_KEY) {
    return { label, ok: false, detail: "ZERNIO_API_KEY is not set." };
  }

  try {
    const profile = await probeProfile();
    return { label, ok: true, detail: `${profile.name} (${profile.id}).` };
  } catch (error) {
    return { label, ok: false, detail: describe(error) };
  }
}
