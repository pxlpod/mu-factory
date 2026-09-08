import { createHash } from "node:crypto";

import type { drive_v3 } from "googleapis";

import { FILE_NAMES, coverStoragePath } from "@/config/factory";
import { YOUTUBE } from "@/config/youtube";
import { downloadFile, findFileByName, type MuFolders } from "@/lib/drive";
import { MEDIA_BUCKET, type MuClient } from "@/lib/supabase";
import type { MediaRow } from "@/types/db";

/**
 * Mirroring covers from Drive into Storage, and handing them out byte for byte.
 *
 * MU LAW 2: NEVER RE-ENCODE SILENTLY. The JPEG Pausha exported is the JPEG
 * YouTube gets. If it is over YouTube's 2 MB cap the answer is a
 * wait-for-human and an alert, not a quiet quality drop — a thumbnail that
 * differs from the one she approved is a thumbnail nobody chose. There is no
 * sharp call in this file and there must never be one.
 *
 * VERIFIED BY READ-BACK, as photo-publisher stores masters: upload, download
 * again, compare sha256, and only then write the `media` row. A truncated
 * upload would otherwise surface as a corrupt thumbnail on a public video
 * weeks later.
 */

export class CoverTooLargeError extends Error {
  constructor(
    readonly ep: string,
    readonly bytes: number,
  ) {
    super(
      `${FILE_NAMES.coverYt(ep)} is ${bytes.toLocaleString()} bytes, over YouTube's ` +
        `${YOUTUBE.thumbnailMaxBytes.toLocaleString()}-byte cap. It will not be ` +
        `re-encoded here: export a smaller JPEG into Drive Covers/yt and the next ` +
        `sweep picks it up.`,
    );
    this.name = "CoverTooLargeError";
  }
}

export type CoverResult =
  | { status: "ready"; bytes: Buffer; sha256: string; media: MediaRow; fresh: boolean }
  | { status: "missing" };

/**
 * The YouTube cover for an episode.
 *
 * Order: an existing `media` row (download from Storage, re-hash, trust it);
 * else Drive `Covers/yt/cover_<Ep>.jpg` (download, hash, size-check, store,
 * verify, record). `missing` means Drive has no such file yet — the caller
 * backs off; nothing is wrong.
 */
export async function ensureCoverYt(
  supabase: MuClient,
  drive: drive_v3.Drive,
  folders: MuFolders,
  ep: string,
): Promise<CoverResult> {
  const { data: existing } = await supabase
    .from("media")
    .select("*")
    .eq("ep", ep)
    .eq("kind", "cover_yt")
    .maybeSingle();

  const row = existing as MediaRow | null;

  if (row?.storage_path && row.sha256) {
    const { data: blob, error } = await supabase.storage
      .from(MEDIA_BUCKET)
      .download(row.storage_path);

    if (!error && blob) {
      const bytes = Buffer.from(await blob.arrayBuffer());
      const sha256 = hash(bytes);
      if (sha256 === row.sha256) {
        if (bytes.length > YOUTUBE.thumbnailMaxBytes) {
          throw new CoverTooLargeError(ep, bytes.length);
        }
        return { status: "ready", bytes, sha256, media: row, fresh: false };
      }
      // The stored object no longer matches its own record. Fall through and
      // mirror again from Drive rather than send bytes nobody vouches for.
    }
  }

  const file = await findFileByName(drive, folders.coversYt, FILE_NAMES.coverYt(ep));
  if (!file) return { status: "missing" };

  const bytes = await downloadFile(drive, file.id);
  const sha256 = hash(bytes);

  if (bytes.length > YOUTUBE.thumbnailMaxBytes) {
    // Record what we saw so /status can show the size, but do not store it:
    // a stored over-cap cover would be one careless code path from being sent.
    await supabase.from("media").upsert(
      {
        ep,
        kind: "cover_yt",
        drive_file_id: file.id,
        drive_md5: file.md5Checksum,
        storage_path: null,
        sha256,
        bytes: bytes.length,
        mirrored_at: null,
      },
      { onConflict: "ep,kind" },
    );
    throw new CoverTooLargeError(ep, bytes.length);
  }

  const path = coverStoragePath("cover_yt", ep);
  await storeVerified(supabase, path, bytes, sha256);

  const { data: saved, error: saveError } = await supabase
    .from("media")
    .upsert(
      {
        ep,
        kind: "cover_yt",
        drive_file_id: file.id,
        drive_md5: file.md5Checksum,
        storage_path: path,
        sha256,
        bytes: bytes.length,
        mirrored_at: new Date().toISOString(),
      },
      { onConflict: "ep,kind" },
    )
    .select("*")
    .single();

  if (saveError || !saved) {
    throw new Error(`media row could not be written: ${saveError?.message ?? "no row"}`);
  }

  return { status: "ready", bytes, sha256, media: saved as MediaRow, fresh: true };
}

/**
 * Upload, read back, compare. Removes the object on mismatch so a bad copy
 * cannot be found later by anything that trusts the path.
 */
export async function storeVerified(
  supabase: MuClient,
  path: string,
  bytes: Buffer,
  sha256: string,
  contentType = "image/jpeg",
): Promise<void> {
  const { error } = await supabase.storage
    .from(MEDIA_BUCKET)
    .upload(path, new Uint8Array(bytes), { contentType, upsert: true });

  if (error) throw new Error(`storage upload failed: ${error.message}`);

  const { data: readBack, error: downloadError } = await supabase.storage
    .from(MEDIA_BUCKET)
    .download(path);

  if (downloadError || !readBack) {
    throw new Error(
      `stored object could not be read back: ${downloadError?.message ?? "no data"}`,
    );
  }

  const storedHash = hash(Buffer.from(await readBack.arrayBuffer()));
  if (storedHash !== sha256) {
    await supabase.storage.from(MEDIA_BUCKET).remove([path]);
    throw new Error(
      `stored object does not match the source (sha256 ${storedHash} vs ${sha256}); removed`,
    );
  }
}

export function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
