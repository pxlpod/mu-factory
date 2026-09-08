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
}

/** The folders Phase 1 needs, resolved once per invocation. */
export async function resolveFolders(drive: drive_v3.Drive): Promise<MuFolders> {
  const root = rootFolderId();
  const coversYt = await resolveFolderPath(drive, root, DRIVE_FOLDERS.coversYt);
  return { root, coversYt };
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
