import type { MediaKind, PostKind } from "@/config/factory";
import type { FinishState } from "@/config/youtube";
import type { ZernioPlatform } from "@/config/zernio";

/**
 * Row shapes for the `mu` schema.
 *
 * Hand-written rather than generated, as photo-publisher does: the shapes are
 * small, the migration is the authority, and a generated file would drag in
 * `storage` and `graphql_public` for no benefit. When a migration changes a
 * table, change the interface here in the same commit.
 */

export interface CredentialRow {
  provider: string;
  data: unknown;
  updated_at: string;
}

export interface WebhookEventRow {
  id: string;
  provider: string;
  event_id: string;
  event: string | null;
  payload: unknown;
  received_at: string;
  processed_at: string | null;
  error: string | null;
}

export type EventLevel = "info" | "warn" | "error";

export interface EventRow {
  id: string;
  at: string;
  level: EventLevel;
  area: string;
  message: string;
  detail: unknown;
  ep: string | null;
  run_id: string | null;
}

export interface HeartbeatRow {
  route: string;
  last_at: string;
  status: string | null;
  detail: string | null;
}

export interface AlertRow {
  id: string;
  condition_key: string;
  condition: string;
  subject: string | null;
  message: string | null;
  payload: unknown;
  raised_at: string;
  last_seen_at: string;
  last_notified_at: string | null;
  resolved_at: string | null;
  count: number;
}

export interface RunRow {
  id: string;
  route: string;
  started_at: string;
  finished_at: string | null;
  summary: unknown;
}

export interface EpisodeRow {
  ep: string;
  slug: string | null;
  lane: string | null;
  series: string | null;
  look: string | null;
  question: string | null;
  duration_s: number | null;
  final_file: string | null;
  post_date: string | null;
  post_time_local: string | null;
  timezone: string | null;
  queue_status: string | null;
  monday_publishing_item_id: string | null;
  created_at: string;
  updated_at: string;
}

export type PostSource = "import" | "webhook" | "poll";

export interface PlatformPostRow {
  id: string;
  ep: string | null;
  platform: ZernioPlatform;
  kind: PostKind;
  zernio_post_id: string | null;
  zernio_account_id: string | null;
  /** The platform's own id — for YouTube, the video id. */
  platform_post_id: string | null;
  published_url: string | null;
  status: string | null;
  scheduled_for: string | null;
  published_at: string | null;
  source: PostSource;
  raw: unknown;
  created_at: string;
  updated_at: string;
}

export interface YoutubeFinishRow {
  /** FK to `platform_posts.id`, and the primary key. */
  platform_post_id: string;
  ep: string | null;
  video_id: string | null;
  state: FinishState;
  thumbnail_set_at: string | null;
  thumbnail_verified_at: string | null;
  thumbnail_distance: number | null;
  caption_track_id: string | null;
  caption_set_at: string | null;
  caption_verified_at: string | null;
  language_set_at: string | null;
  attempts: number;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  cover_sha256: string | null;
  /** The Shorts GRID slot — Studio-only; see `STUDIO` in config/youtube.ts. */
  grid_thumbnail_set_at: string | null;
  grid_thumbnail_verified_at: string | null;
  grid_thumbnail_distance: number | null;
  grid_attempts: number;
  grid_next_attempt_at: string | null;
  grid_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface MediaRow {
  id: string;
  ep: string;
  kind: MediaKind;
  drive_file_id: string | null;
  drive_md5: string | null;
  storage_path: string | null;
  sha256: string | null;
  bytes: number | null;
  mirrored_at: string | null;
}
