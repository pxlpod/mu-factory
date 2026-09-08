import { Readable } from "node:stream";

import { google, type youtube_v3 } from "googleapis";

import { YOUTUBE } from "@/config/youtube";
import {
  authorizedClient,
  isInvalidGrant,
  YoutubeDisconnectedError,
} from "@/lib/google/auth";
import type { MuClient } from "@/lib/supabase";

/**
 * YouTube Data API v3 — the five calls the finisher makes, and nothing else.
 *
 * `googleapis` IS THE ONE SDK THIS HOUSE ALLOWS, because multipart media
 * uploads and token refresh are exactly the things a hand-rolled fetch gets
 * subtly wrong. Every call goes through `call()`, which turns an
 * `invalid_grant` into `YoutubeDisconnectedError` so the sweep has one
 * exception type to catch and one alert to raise.
 *
 * NOTHING HERE UPLOADS A VIDEO. Zernio publishes; this finishes. If a
 * `videos.insert` ever appears in this file the scope of the project has
 * changed and CLAUDE.md needs a new law before the code does.
 *
 * Quota per call (documented 2026-09-08): videos.list 1, captions.list 50,
 * captions.insert 400, thumbnails.set 50, videos.update 50, channels.list 1.
 */

export class YouTubeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "YouTubeError";
  }
}

async function api(supabase?: MuClient): Promise<youtube_v3.Youtube> {
  const { client } = await authorizedClient(supabase);
  return google.youtube({ version: "v3", auth: client });
}

async function call<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof YoutubeDisconnectedError) throw error;
    if (isInvalidGrant(error)) {
      throw new YoutubeDisconnectedError(
        `YouTube refused the refresh token (invalid_grant) during ${label}. ` +
          "Open /status and press Connect Google.",
      );
    }
    throw new YouTubeError(
      `YouTube ${label} failed: ${describeGoogleError(error)}`,
      statusOf(error),
      reasonOf(error),
    );
  }
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

export async function probeChannel(
  supabase?: MuClient,
): Promise<{ id: string; title: string }> {
  const youtube = await api(supabase);
  const res = await call("channels.list", () =>
    youtube.channels.list({ part: ["id", "snippet"], mine: true }),
  );
  const channel = res.data.items?.[0];
  if (!channel?.id) {
    throw new YouTubeError("channels.list(mine) returned no channel for this token");
  }
  return { id: channel.id, title: channel.snippet?.title ?? "(untitled)" };
}

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

export interface VideoInfo {
  id: string;
  title: string;
  categoryId: string | null;
  description: string | null;
  tags: string[] | null;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  privacyStatus: string | null;
  uploadStatus: string | null;
  thumbnails: Record<string, { url?: string | null }>;
}

/** `videos.list(part=snippet,status)`. Null when YouTube does not know the id. */
export async function getVideo(
  videoId: string,
  supabase?: MuClient,
): Promise<VideoInfo | null> {
  const youtube = await api(supabase);
  const res = await call("videos.list", () =>
    youtube.videos.list({ part: ["snippet", "status"], id: [videoId] }),
  );
  const video = res.data.items?.[0];
  if (!video?.id) return null;

  return {
    id: video.id,
    title: video.snippet?.title ?? "",
    categoryId: video.snippet?.categoryId ?? null,
    description: video.snippet?.description ?? null,
    tags: video.snippet?.tags ?? null,
    defaultLanguage: video.snippet?.defaultLanguage ?? null,
    defaultAudioLanguage: video.snippet?.defaultAudioLanguage ?? null,
    privacyStatus: video.status?.privacyStatus ?? null,
    uploadStatus: video.status?.uploadStatus ?? null,
    thumbnails: (video.snippet?.thumbnails ?? {}) as Record<string, { url?: string | null }>,
  };
}

/**
 * Sets `snippet.defaultLanguage`, re-sending the rest of the snippet.
 *
 * `videos.update` REPLACES the whole snippet part: omit `title` or
 * `categoryId` and the call fails; omit `description` or `tags` and they are
 * cleared. So the existing values go back exactly as read, with only the
 * language added.
 */
export async function setVideoLanguage(
  video: VideoInfo,
  language: string,
  supabase?: MuClient,
): Promise<void> {
  const youtube = await api(supabase);
  await call("videos.update", () =>
    youtube.videos.update({
      part: ["snippet"],
      requestBody: {
        id: video.id,
        snippet: {
          title: video.title,
          categoryId: video.categoryId ?? undefined,
          description: video.description ?? undefined,
          tags: video.tags ?? undefined,
          defaultLanguage: language,
          defaultAudioLanguage: video.defaultAudioLanguage ?? undefined,
        },
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Captions
// ---------------------------------------------------------------------------

export interface CaptionTrack {
  id: string;
  language: string;
  name: string;
  /** `standard`, `asr` (YouTube's auto track) or `forced`. */
  trackKind: string;
  isDraft: boolean;
}

export async function listCaptions(
  videoId: string,
  supabase?: MuClient,
): Promise<CaptionTrack[]> {
  const youtube = await api(supabase);
  const res = await call("captions.list", () =>
    youtube.captions.list({ part: ["snippet"], videoId }),
  );
  return (res.data.items ?? [])
    .filter((c) => c.id)
    .map((c) => ({
      id: c.id!,
      language: c.snippet?.language ?? "",
      name: c.snippet?.name ?? "",
      trackKind: c.snippet?.trackKind ?? "",
      isDraft: Boolean(c.snippet?.isDraft),
    }));
}

/**
 * The override track: a human-published `en` track whose only cue is blank.
 *
 * `trackKind !== "asr"` is the test for "already done by hand" — YouTube's own
 * auto track is `asr`, and anything else in `en` was published by a person or
 * by this code.
 */
export function findOverrideTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  return (
    tracks.find(
      (t) =>
        t.trackKind.toLowerCase() !== "asr" &&
        t.language.toLowerCase().startsWith(YOUTUBE.caption.language) &&
        !t.isDraft,
    ) ?? null
  );
}

/**
 * `captions.insert` with the blank SRT body from config.
 *
 * Media shape per googleapis: `{ mimeType, body }`, with `body` a Readable.
 * The snippet is `{ videoId, language, name, isDraft: false }` — published
 * immediately, because a draft track does not override the ASR one.
 */
export async function insertBlankCaption(
  videoId: string,
  supabase?: MuClient,
): Promise<{ id: string }> {
  const youtube = await api(supabase);
  const res = await call("captions.insert", () =>
    youtube.captions.insert({
      part: ["snippet"],
      requestBody: {
        snippet: {
          videoId,
          language: YOUTUBE.caption.language,
          name: YOUTUBE.caption.name,
          isDraft: false,
        },
      },
      media: {
        mimeType: YOUTUBE.caption.mimeType,
        body: Readable.from([Buffer.from(YOUTUBE.caption.blankSrt, "utf8")]),
      },
    }),
  );
  if (!res.data.id) throw new YouTubeError("captions.insert returned no track id");
  return { id: res.data.id };
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

/** `thumbnails.set` with the cover's own bytes. Never re-encoded here or anywhere. */
export async function setThumbnail(
  videoId: string,
  jpeg: Buffer,
  supabase?: MuClient,
): Promise<void> {
  const youtube = await api(supabase);
  await call("thumbnails.set", () =>
    youtube.thumbnails.set({
      videoId,
      media: { mimeType: "image/jpeg", body: Readable.from([jpeg]) },
    }),
  );
}

/**
 * Downloads the thumbnail YouTube currently SERVES, for verification.
 *
 * Read from the URL in `snippet.thumbnails`, not guessed from `i.ytimg.com`:
 * the guessable URL can lag behind or serve a cached default while the
 * snippet already points at the new asset, and verification has to look at
 * what viewers see.
 */
export async function fetchThumbnail(
  video: VideoInfo,
): Promise<{ bytes: Buffer; key: string; url: string } | null> {
  for (const key of YOUTUBE.verifyThumbnailKeys) {
    const url = video.thumbnails[key]?.url;
    if (!url) continue;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(YOUTUBE.thumbnailFetchTimeoutMs),
        cache: "no-store",
      });
      if (!res.ok) continue;
      return { bytes: Buffer.from(await res.arrayBuffer()), key, url };
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

function describeGoogleError(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const err = error as {
    message?: string;
    response?: { data?: { error?: { message?: string; errors?: Array<{ reason?: string; message?: string }> } | string } };
  };
  const data = err.response?.data;
  if (data && typeof data === "object" && data.error && typeof data.error === "object") {
    const inner = data.error;
    const reasons = (inner.errors ?? []).map((e) => e.reason).filter(Boolean).join(",");
    return `${inner.message ?? err.message ?? "unknown"}${reasons ? ` [${reasons}]` : ""}`;
  }
  return err.message ?? String(error);
}

function statusOf(error: unknown): number | undefined {
  const err = error as { code?: number | string; response?: { status?: number } };
  const code = err?.response?.status ?? err?.code;
  return typeof code === "number" ? code : undefined;
}

function reasonOf(error: unknown): string | undefined {
  const err = error as {
    response?: { data?: { error?: { errors?: Array<{ reason?: string }> } } };
  };
  return err?.response?.data?.error?.errors?.[0]?.reason ?? undefined;
}

/** "The video does not exist / is not yours" — a wait-for-human, not a retry. */
export function isNotFound(error: unknown): boolean {
  if (!(error instanceof YouTubeError)) return false;
  return (
    error.status === 404 ||
    /notFound|videoNotFound|forbidden/i.test(error.reason ?? "") ||
    /not found/i.test(error.message)
  );
}
