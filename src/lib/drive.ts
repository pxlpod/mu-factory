import { google, type drive_v3 } from "googleapis";

import { DRIVE_FOLDERS } from "@/config/factory";

/**
 * Google Drive access — where the Mac pipeline drops covers and finals.
 *
 * A SERVICE ACCOUNT, NOT OAUTH. Copied from photo-publisher (2026-09-08). It
 * has its own identity, it is granted access to the MU root folder by hand,
 * and it holds nothing that expires — so there is no refresh path to get
 * wrong and no re-consent screen six months from now. YouTube is the one
 * Google surface that cannot work this way (a service account has no channel),
 * and that lives in `src/lib/google/auth.ts`, deliberately apart.
 *
 * Phase 1 READS ONLY. Nothing here moves, renames or deletes a Drive file.
 */

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  md5Checksum: string | null;
  modifiedTime: string | null;
}

export class DriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveError";
  }
}

function credentials(): { client_email: string; private_key: string } {
  const encoded = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!encoded) {
    throw new DriveError("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  }

  let json: string;
  try {
    // Stored base64 so the key survives a paste into the Vercel env var field,
    // which mangles the literal newlines in a raw PEM.
    json = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    throw new DriveError("GOOGLE_SERVICE_ACCOUNT_JSON is not valid base64");
  }

  let parsed: { client_email?: string; private_key?: string };
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new DriveError(
      "GOOGLE_SERVICE_ACCOUNT_JSON did not decode to JSON. Re-run: " +
        "base64 -i <the downloaded key>.json",
    );
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new DriveError(
      "Service account key is missing client_email or private_key",
    );
  }

  return {
    client_email: parsed.client_email,
    private_key: parsed.private_key.replace(/\\n/g, "\n"),
  };
}

export function serviceAccountEmail(): string {
  return credentials().client_email;
}

export function rootFolderId(): string {
  const id = process.env.DRIVE_ROOT_FOLDER_ID;
  if (!id) throw new DriveError("DRIVE_ROOT_FOLDER_ID is not set");
  return id;
}

export function createDriveClient(): drive_v3.Drive {
  const { client_email, private_key } = credentials();
  const auth = new google.auth.JWT({
    email: client_email,
    key: private_key,
    scopes: [DRIVE_SCOPE],
  });
  return google.drive({ version: "v3", auth });
}

/**
 * Resolves a folder PATH by name, one segment at a time, under a parent.
 *
 * `["Covers", "yt"]` → the id of `yt` inside `Covers` inside the root. By name
 * rather than by more env vars so the folders can be rebuilt in Drive without
 * a redeploy. Case-insensitive, because Finder is.
 */
export async function resolveFolderPath(
  drive: drive_v3.Drive,
  parentId: string,
  path: readonly string[],
): Promise<string> {
  let current = parentId;
  for (const segment of path) {
    const res = await drive.files.list({
      q:
        `'${current}' in parents and trashed = false and ` +
        `mimeType = 'application/vnd.google-apps.folder'`,
      fields: "files(id, name)",
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const match = (res.data.files ?? []).find(
      (f) => (f.name ?? "").toLowerCase() === segment.toLowerCase(),
    );
    if (!match?.id) {
      throw new DriveError(
        `Drive folder "${segment}" not found under ${current === parentId ? "the root" : `"${path[path.indexOf(segment) - 1]}"`}. ` +
          `Create it, and check the root folder is shared with ${credentials().client_email}.`,
      );
    }
    current = match.id;
  }
  return current;
}

export interface MuFolders {
  root: string;
  coversYt: string;
  coversIg: string;
  finals: string;
}

/**
 * The root folder itself: reachable, a folder, and visible to the service
 * account — which it is only when someone shared it. Returns the folder's
 * name so /status can show which folder the id points at.
 *
 * WHY THIS EXISTS (2026-10-17): on 2026-10-03 Drive for desktop on Pausha's Mac
 * re-linked and rebuilt `MU Factory` as a NEW folder with a new id, owned by
 * her alone. `DRIVE_ROOT_FOLDER_ID` kept pointing at the old id for two weeks
 * and every finish ended in wait-for-human. Resolving subfolders by name does
 * not protect the root; this probe does, by failing loudly in the hourly check.
 */
export async function probeRoot(
  drive: drive_v3.Drive,
): Promise<{ id: string; name: string }> {
  const id = rootFolderId();
  try {
    const res = await drive.files.get({
      fileId: id,
      fields: "id, name, mimeType, trashed",
      supportsAllDrives: true,
    });
    if (res.data.trashed) {
      throw new DriveError(`Drive root folder ${id} is in the trash.`);
    }
    if (res.data.mimeType !== "application/vnd.google-apps.folder") {
      throw new DriveError(`Drive root ${id} is not a folder (${res.data.mimeType}).`);
    }
    return { id, name: res.data.name ?? "(unnamed)" };
  } catch (error) {
    if (error instanceof DriveError) throw error;
    const status = (error as { code?: number; response?: { status?: number } }).code
      ?? (error as { response?: { status?: number } }).response?.status;
    if (status === 404 || status === 403) {
      throw new DriveError(
        `Drive root folder ${id} is not visible to ${credentials().client_email} ` +
          `(HTTP ${status}). Either the folder was deleted or rebuilt with a new id ` +
          `(update DRIVE_ROOT_FOLDER_ID and redeploy), or it is not shared with the ` +
          `service account (Share → add that address as Editor).`,
      );
    }
    throw error;
  }
}

/**
 * The three folders the app reads, resolved once per invocation.
 *
 * All three since 2026-10-17 rather than only `Covers/yt`: the executor
 * (Phase 3) needs `Covers` and `Finals`, and the hourly probe should say a
 * missing folder before a hand-off trips over it.
 */
export async function resolveFolders(drive: drive_v3.Drive): Promise<MuFolders> {
  const root = rootFolderId();
  const [coversYt, coversIg, finals] = await Promise.all([
    resolveFolderPath(drive, root, DRIVE_FOLDERS.coversYt),
    resolveFolderPath(drive, root, DRIVE_FOLDERS.coversIg),
    resolveFolderPath(drive, root, DRIVE_FOLDERS.finals),
  ]);
  return { root, coversYt, coversIg, finals };
}

/** Non-folder files directly inside a folder, newest last. Dotfiles ignored. */
export async function listFiles(
  drive: drive_v3.Drive,
  folderId: string,
  limit = 200,
): Promise<DriveFile[]> {
  const res = await drive.files.list({
    q:
      `'${folderId}' in parents and trashed = false and ` +
      `mimeType != 'application/vnd.google-apps.folder'`,
    fields: "files(id, name, mimeType, size, md5Checksum, modifiedTime)",
    orderBy: "createdTime",
    pageSize: Math.max(1, Math.min(limit, 1000)),
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  return (res.data.files ?? [])
    .map(toDriveFile)
    .filter((f) => !f.name.startsWith("."));
}

/**
 * One file by exact name inside a folder, or null.
 *
 * The most recently modified wins when Drive holds two — a re-exported cover
 * uploaded beside the old one is the newer file, and that is the one Pausha
 * means.
 */
export async function findFileByName(
  drive: drive_v3.Drive,
  folderId: string,
  name: string,
): Promise<DriveFile | null> {
  const escaped = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and name = '${escaped}'`,
    fields: "files(id, name, mimeType, size, md5Checksum, modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  const file = res.data.files?.[0];
  return file ? toDriveFile(file) : null;
}

/** Downloads the whole file into memory. Covers are small; finals never come through here. */
export async function downloadFile(
  drive: drive_v3.Drive,
  fileId: string,
): Promise<Buffer> {
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" },
  );
  return Buffer.from(res.data as ArrayBuffer);
}

function toDriveFile(f: drive_v3.Schema$File): DriveFile {
  return {
    id: f.id!,
    name: f.name ?? "(unnamed)",
    mimeType: f.mimeType ?? "application/octet-stream",
    size: f.size ? Number(f.size) : null,
    md5Checksum: f.md5Checksum ?? null,
    modifiedTime: f.modifiedTime ?? null,
  };
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
