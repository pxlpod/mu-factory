import { EPISODE_PATTERN, POST_KINDS, type PostKind } from "@/config/factory";
import { ZERNIO, type ZernioPlatform } from "@/config/zernio";

/**
 * Zernio client — read-only in Phase 1.
 *
 * COPIED FROM PHOTO-PUBLISHER'S CLIENT AND CUT TO WHAT MU NEEDS: the request
 * wrapper, the published-URL finder, and the post reader. The scheduling and
 * media-upload calls stay behind in photo-publisher until Phase 2 needs them.
 *
 * MU LAW 1 IS ENFORCED HERE, NOT AT THE CALL SITES. `listPublishedPosts`
 * always sends `profileId` from config; there is no parameter to leave it
 * out. The other profiles in this Zernio workspace are client work and this
 * app must never read them, even by accident, even for a count.
 */

export class ZernioError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ZernioError";
  }
}

function apiKey(): string {
  const key = process.env.ZERNIO_API_KEY;
  if (!key) throw new ZernioError("ZERNIO_API_KEY is not set");
  return key;
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${ZERNIO.baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(ZERNIO.requestTimeoutMs),
    cache: "no-store",
  });

  const text = await res.text();

  if (!res.ok) {
    throw new ZernioError(
      `Zernio ${init.method ?? "GET"} ${path} — ${res.status}: ${text.slice(0, 300)}`,
      res.status,
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ZernioError(
      `Zernio ${path} returned unparseable JSON: ${text.slice(0, 200)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Post shape
// ---------------------------------------------------------------------------

/**
 * One platform leg of a post, as both the webhook payload and the list
 * endpoint present it: `post.platforms[]{platform,status,accountId,
 * platformPostId,publishedUrl}` (webhook shape confirmed by the MU spec,
 * 2026-09-08; the list endpoint is assumed to match — see UNVERIFIED in the
 * scaffold report).
 */
export interface ZernioPlatformLeg {
  platform: string;
  status: string | null;
  accountId: string | null;
  platformPostId: string | null;
  publishedUrl: string | null;
  publishedAt: string | null;
  error: string | null;
  raw: Record<string, unknown>;
}

export interface ZernioPost {
  id: string;
  /** `metadata.episode` when present and well-formed, else null. */
  episode: string | null;
  /** `metadata.kind` when present and one of `POST_KINDS`, else null. */
  kind: PostKind | null;
  scheduledFor: string | null;
  publishedAt: string | null;
  status: string | null;
  platforms: ZernioPlatformLeg[];
  raw: Record<string, unknown>;
}

/**
 * Normalises a post object from either source into `ZernioPost`.
 *
 * Tolerant on purpose: `_id`/`id`, `platforms` present or absent, `metadata`
 * an object or missing. The webhook stores the whole payload, so anything this
 * misses can be found later; what it must not do is throw on a shape it has
 * not seen and leave a published Short unfinished.
 */
export function normalizePost(source: unknown): ZernioPost | null {
  const post = asRecord(source);
  const id = asString(post._id) ?? asString(post.id);
  if (!id) return null;

  const metadata = asRecord(post.metadata);
  const episodeRaw = asString(metadata.episode);
  const episode = episodeRaw && EPISODE_PATTERN.test(episodeRaw) ? episodeRaw : null;
  const kindRaw = asString(metadata.kind)?.toLowerCase();
  const kind = (POST_KINDS as readonly string[]).includes(kindRaw ?? "")
    ? (kindRaw as PostKind)
    : null;

  const platforms = (Array.isArray(post.platforms) ? post.platforms : [])
    .map((entry) => asRecord(entry))
    .map((leg): ZernioPlatformLeg => ({
      platform: (asString(leg.platform) ?? "").toLowerCase(),
      status: asString(leg.status)?.toLowerCase() ?? null,
      accountId: asString(leg.accountId) ?? asString(leg.account_id),
      platformPostId: asString(leg.platformPostId) ?? asString(leg.platform_post_id),
      publishedUrl: findPostUrl(leg),
      publishedAt: asString(leg.publishedAt) ?? asString(leg.published_at),
      error: asString(leg.error) ?? asString(leg.errorMessage),
      raw: leg,
    }));

  return {
    id,
    episode,
    kind,
    scheduledFor: asString(post.scheduledFor) ?? asString(post.scheduled_for),
    publishedAt: asString(post.publishedAt) ?? asString(post.published_at),
    status: asString(post.status)?.toLowerCase() ?? null,
    platforms,
    raw: post,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface ListResponse {
  posts?: unknown[];
  data?: unknown[];
  pagination?: { page?: number; pages?: number; total?: number; hasMore?: boolean };
}

/**
 * Published YouTube posts on the MU profile, last `pollWindowDays`.
 *
 * `GET /posts?profileId=…&platform=youtube&status=published&dateFrom=…&page=…&limit=…`
 * — parameter names from the Zernio API reference (2026-09-08). The response
 * envelope is tolerated three ways (`posts`, `data`, bare array) because it
 * was not verifiable from the docs; the poll fallback logs the page count it
 * saw so a wrong guess is visible on /status rather than silent.
 */
export async function listPublishedPosts(opts?: {
  platform?: ZernioPlatform;
  sinceDays?: number;
}): Promise<ZernioPost[]> {
  const platform = opts?.platform ?? ZERNIO.listParams.platform;
  const sinceDays = opts?.sinceDays ?? ZERNIO.pollWindowDays;
  const dateFrom = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const posts: ZernioPost[] = [];

  for (let page = 1; page <= ZERNIO.listParams.maxPages; page++) {
    const params = new URLSearchParams({
      profileId: ZERNIO.profileId,
      platform,
      status: ZERNIO.listParams.status,
      dateFrom,
      page: String(page),
      limit: String(ZERNIO.listParams.pageSize),
    });

    const raw = await request<ListResponse | unknown[]>(`/posts?${params}`);
    const items = Array.isArray(raw) ? raw : (raw.posts ?? raw.data ?? []);

    for (const item of items) {
      const post = normalizePost(item);
      if (post) posts.push(post);
    }

    if (items.length < ZERNIO.listParams.pageSize) break;
    if (!Array.isArray(raw) && raw.pagination?.hasMore === false) break;
  }

  return posts;
}

/** One post by id. Null on 404. */
export async function getPost(postId: string): Promise<ZernioPost | null> {
  try {
    const raw = await request<Record<string, unknown>>(`/posts/${encodeURIComponent(postId)}`);
    return normalizePost(raw.post ?? raw);
  } catch (error) {
    if (error instanceof ZernioError && error.status === 404) return null;
    throw error;
  }
}

/** The MU profile, by id, as a health probe. Proves the key and the purview at once. */
export async function probeProfile(): Promise<{ id: string; name: string }> {
  const raw = await request<Record<string, unknown>>(
    `/profiles/${encodeURIComponent(ZERNIO.profileId)}`,
  );
  const profile = asRecord(raw.profile ?? raw);
  const id = asString(profile._id) ?? asString(profile.id) ?? ZERNIO.profileId;
  const name = asString(profile.name) ?? "(unnamed)";
  if (name.toLowerCase() !== ZERNIO.profileName.toLowerCase()) {
    throw new ZernioError(
      `Profile ${id} is named "${name}", expected "${ZERNIO.profileName}". ` +
        "Check the profile id in src/config/zernio.ts before anything reads posts.",
    );
  }
  return { id, name };
}

// ---------------------------------------------------------------------------

/**
 * Finds the published URL in a payload.
 *
 * IT IS `publishedUrl` — confirmed against a real delivery in photo-publisher
 * (2026-09-07). The alternatives stay in the list behind it; they cost one
 * property lookup each and are the difference between a rename upstream being
 * a shrug and being another silent post with no URL.
 */
export function findPostUrl(
  source: Record<string, unknown> | undefined | null,
): string | null {
  if (!source) return null;
  for (const key of [
    "publishedUrl",
    "platformPostUrl",
    "postUrl",
    "permalink",
    "url",
    "link",
  ]) {
    const value = source[key];
    if (typeof value === "string" && value.startsWith("http")) return value;
  }
  return null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
