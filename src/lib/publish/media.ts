import type { drive_v3 } from "googleapis";

import { FILE_NAMES, MEDIA_KINDS, mediaStoragePath, type MediaKind } from "@/config/factory";
import { PUBLISH } from "@/config/publish";
import { downloadFile, findFileByName, type DriveFile, type MuFolders } from "@/lib/drive";
import { hash, storeVerified } from "@/lib/media";
import { MEDIA_BUCKET, type MuClient } from "@/lib/supabase";
import { uploadMedia } from "@/lib/zernio/client";
import type { MediaRow } from "@/types/db";

/**
 * The executor's media: every file a hand-off needs, from Drive, to Zernio.
 *
 * MU LAW 2 STILL: nothing here decodes or re-encodes. Bytes are read from
 * Drive, hashed, and handed on. Covers are kept in the bucket (as the
 * finisher already does for `cover_yt`); finals are NOT retained — a 180 MB
 * file × two variants × every episode is a second archive nobody asked for,
 * and Drive already is one. A final's `media` row records what was seen
 * (sha256, bytes, Drive id) with `retained = false`.
 *
 * ONE UPLOAD PER FILE PER EPISODE. The FINAL serves Instagram and YouTube;
 * the IG cover serves the thumbnail and two stories. `ensureZernioUpload`
 * reuses an upload younger than the hand-off window and redoes an older one
 * (Zernio temp media dies after 7 days — doc 12, 2026-08-27).
 */

export type MediaResult =
  | { status: "ready"; bytes: Buffer; sha256: string; media: MediaRow; file: DriveFile }
  | { status: "missing" };

export function folderFor(folders: MuFolders, kind: MediaKind): string {
  return folders[MEDIA_KINDS[kind].folder];
}

/** Does the file exist in Drive? Cheap: one list call, no download. */
export async function mediaPresent(
  drive: drive_v3.Drive,
  folders: MuFolders,
  ep: string,
  kind: MediaKind,
): Promise<boolean> {
  const spec = MEDIA_KINDS[kind];
  const file = await findFileByName(drive, folderFor(folders, kind), spec.name(ep));
  if (!file) return false;
  if (kind === "final_tt_tail") {
    // The tail variant is useless without its sidecar (cover_ms).
    const sidecar = await findFileByName(drive, folders.finals, FILE_NAMES.finalTikTokTailSidecar(ep));
    return Boolean(sidecar);
  }
  return true;
}

/**
 * The bytes for one media kind, with its `media` row up to date.
 *
 * Retained kinds: an existing verified copy in the bucket is used as is (same
 * rule as the finisher's cover); otherwise Drive → hash → store → read back →
 * row. Non-retained kinds: Drive → hash → row (`retained false`) every time;
 * the bytes live only for this invocation.
 */
export async function ensureMedia(
  supabase: MuClient,
  drive: drive_v3.Drive,
  folders: MuFolders,
  ep: string,
  kind: MediaKind,
): Promise<MediaResult> {
  const spec = MEDIA_KINDS[kind];
  const { data: existingData } = await supabase
    .from("media")
    .select("*")
    .eq("ep", ep)
    .eq("kind", kind)
    .maybeSingle();
  const existing = existingData as MediaRow | null;

  const file = await findFileByName(drive, folderFor(folders, kind), spec.name(ep));
  if (!file) return { status: "missing" };

  // A retained copy that matches the Drive file we see now is good as is.
  if (spec.retained && existing?.storage_path && existing.sha256 && existing.drive_md5 === file.md5Checksum) {
    const { data: blob, error } = await supabase.storage.from(MEDIA_BUCKET).download(existing.storage_path);
    if (!error && blob) {
      const bytes = Buffer.from(await blob.arrayBuffer());
      if (hash(bytes) === existing.sha256) {
        return { status: "ready", bytes, sha256: existing.sha256, media: existing, file };
      }
    }
  }

  const bytes = await downloadFile(drive, file.id);
  const sha256 = hash(bytes);
  let storagePath: string | null = null;
  if (spec.retained) {
    storagePath = mediaStoragePath(kind, ep);
    await storeVerified(supabase, storagePath, bytes, sha256, spec.contentType);
  }

  let meta: Record<string, unknown> | null = existing?.meta ?? null;
  if (kind === "final_tt_tail") {
    const sidecar = await findFileByName(drive, folders.finals, FILE_NAMES.finalTikTokTailSidecar(ep));
    if (!sidecar) return { status: "missing" };
    const parsed = JSON.parse((await downloadFile(drive, sidecar.id)).toString("utf8")) as Record<string, unknown>;
    if (typeof parsed.cover_ms !== "number") {
      throw new Error(`${FILE_NAMES.finalTikTokTailSidecar(ep)} has no numeric cover_ms`);
    }
    meta = parsed;
  }

  // A changed source file invalidates the Zernio upload of the old bytes.
  const sourceChanged = existing?.sha256 && existing.sha256 !== sha256;

  const { data: saved, error } = await supabase
    .from("media")
    .upsert(
      {
        ep,
        kind,
        drive_file_id: file.id,
        drive_md5: file.md5Checksum,
        storage_path: storagePath,
        sha256,
        bytes: bytes.length,
        mirrored_at: new Date().toISOString(),
        retained: spec.retained,
        meta: meta as never,
        ...(sourceChanged ? { zernio_key: null, zernio_url: null, zernio_uploaded_at: null } : {}),
      },
      { onConflict: "ep,kind" },
    )
    .select("*")
    .single();
  if (error || !saved) throw new Error(`media row could not be written: ${error?.message ?? "no row"}`);

  return { status: "ready", bytes, sha256, media: saved as MediaRow, file };
}

/**
 * The Zernio public URL for a media row, uploading if there is no upload
 * younger than the hand-off window. Records key, url and time on the row.
 */
export async function ensureZernioUpload(
  supabase: MuClient,
  ready: Extract<MediaResult, { status: "ready" }>,
): Promise<{ url: string; key: string; fresh: boolean; media: MediaRow }> {
  const { media, bytes } = ready;
  const freshEnough =
    media.zernio_url &&
    media.zernio_uploaded_at &&
    Date.now() - new Date(media.zernio_uploaded_at).getTime() <
      PUBLISH.handoffWindowDays * 24 * 60 * 60 * 1000;
  if (freshEnough) {
    return { url: media.zernio_url!, key: media.zernio_key ?? media.zernio_url!, fresh: false, media };
  }

  const spec = MEDIA_KINDS[media.kind];
  const uploaded = await uploadMedia({
    bytes,
    filename: spec.name(media.ep),
    contentType: spec.contentType,
    uploadTimeoutMs: PUBLISH.uploadTimeoutMs,
  });

  const { data: saved, error } = await supabase
    .from("media")
    .update({
      zernio_key: uploaded.key,
      zernio_url: uploaded.publicUrl,
      zernio_uploaded_at: new Date().toISOString(),
    })
    .eq("id", media.id)
    .select("*")
    .single();
  if (error || !saved) throw new Error(`media upload could not be recorded: ${error?.message ?? "no row"}`);

  return { url: uploaded.publicUrl, key: uploaded.key, fresh: true, media: saved as MediaRow };
}
