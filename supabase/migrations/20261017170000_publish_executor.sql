-- =============================================================================
-- mu — the publish executor (Phase 3 of 16_Factory-Migration-Spec.md, 2026-10-17)
--
-- The weekly `mu_post.py` run on Pausha's Mac moves into the app: a cron
-- reads the Publishing board, hands each Queued episode to Zernio, and writes
-- the post ids back. Two tables grow to carry what that needs.
--
-- platform_posts: rows the executor CREATES before Zernio has assigned an id
-- (`status = pending`, `zernio_post_id` null), plus everything a hand-off
-- knows — the Monday item, the resolved slot, which uploaded media the post
-- points at, when it was handed off or cancelled, attempts and the last
-- error, and a hash of the copy sent so a board edit can be detected.
-- `source` gains `executor`.
--
-- media: a file uploaded to Zernio once serves several legs (the FINAL serves
-- Instagram and YouTube; the IG cover serves the thumbnail and two stories),
-- so the Zernio key/url and upload time live on the media row. `kind` gains
-- `final_tt_tail` (the TikTok tail-card variant) and `meta` carries its
-- sidecar (`cover_ms`). Finals are NOT retained in the bucket — Drive is the
-- archive and the Mac the master — so a final's row has storage_path null and
-- mirrored_at null with `retained = false`; the first migration's "null means
-- refused" comment is narrowed accordingly.
--
-- SAFE TO RUN TWICE. Every ADD COLUMN is IF NOT EXISTS; the two CHECKs are
-- dropped IF EXISTS and re-added in DO blocks; COMMENT ON is idempotent.
-- Re-adding the CHECKs validates existing rows, all of which pass.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS mu;

-- -----------------------------------------------------------------------------
-- platform_posts
-- -----------------------------------------------------------------------------
ALTER TABLE mu.platform_posts
  ADD COLUMN IF NOT EXISTS monday_item_id   text,
  ADD COLUMN IF NOT EXISTS slot_at          timestamptz,
  ADD COLUMN IF NOT EXISTS media_id         uuid REFERENCES mu.media(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS handed_off_at    timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at     timestamptz,
  ADD COLUMN IF NOT EXISTS attempts         integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at  timestamptz,
  ADD COLUMN IF NOT EXISTS last_error       text,
  ADD COLUMN IF NOT EXISTS copy_hash        text;

DO $source$
BEGIN
  ALTER TABLE mu.platform_posts DROP CONSTRAINT IF EXISTS platform_posts_source_check;
  ALTER TABLE mu.platform_posts
    ADD CONSTRAINT platform_posts_source_check
    CHECK (source IN ('import', 'webhook', 'poll', 'executor'));
END
$source$;

CREATE INDEX IF NOT EXISTS platform_posts_active_leg_idx
  ON mu.platform_posts (ep, platform, kind)
  WHERE cancelled_at IS NULL;

COMMENT ON COLUMN mu.platform_posts.source IS
  'Who FIRST told us about this post: import (CSV), webhook, poll, or executor (this app created it). Never rewritten.';
COMMENT ON COLUMN mu.platform_posts.status IS
  'Zernio''s status once it has one (scheduled, published, failed…). Executor rows start as pending; cancelled when withdrawn from Zernio after a board change; wait-for-human after three failed hand-offs.';
COMMENT ON COLUMN mu.platform_posts.monday_item_id IS
  'The Publishing item this leg was built from. Text-lane legs point at the Text item.';
COMMENT ON COLUMN mu.platform_posts.slot_at IS
  'The instant the leg is scheduled for, resolved from the item''s Date and the slot in config (video 18:00, text 09:00, stories +10 min, America/New_York).';
COMMENT ON COLUMN mu.platform_posts.media_id IS
  'The media row whose Zernio upload this post points at. Zernio temp media lives 7 days; a re-hand-off past that re-uploads.';
COMMENT ON COLUMN mu.platform_posts.copy_hash IS
  'sha256 of what was sent (content, title, settings, slot). The reconcile step compares it with the board and cancels + re-hands-off on a difference.';

-- -----------------------------------------------------------------------------
-- media
-- -----------------------------------------------------------------------------
ALTER TABLE mu.media
  ADD COLUMN IF NOT EXISTS retained            boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS meta                jsonb,
  ADD COLUMN IF NOT EXISTS zernio_key          text,
  ADD COLUMN IF NOT EXISTS zernio_url          text,
  ADD COLUMN IF NOT EXISTS zernio_uploaded_at  timestamptz;

DO $kind$
BEGIN
  ALTER TABLE mu.media DROP CONSTRAINT IF EXISTS media_kind_check;
  ALTER TABLE mu.media
    ADD CONSTRAINT media_kind_check
    CHECK (kind IN ('final', 'final_tt', 'final_tt_tail', 'cover_ig', 'cover_yt', 'cover_fb'));
END
$kind$;

COMMENT ON COLUMN mu.media.retained IS
  'true: the bytes are in the mu-media bucket at storage_path, verified by sha256. false: seen in Drive and hashed but not kept here (finals — Drive is the archive, the Mac the master).';
COMMENT ON COLUMN mu.media.mirrored_at IS
  'When the bytes were last read from Drive and hashed. Null with storage_path null and retained true means the file was seen but refused (e.g. a cover over 2 MB).';
COMMENT ON COLUMN mu.media.meta IS
  'Per-kind facts from the Mac pipeline: for final_tt_tail the sidecar JSON (cover_ms = the TikTok cover timestamp).';
COMMENT ON COLUMN mu.media.zernio_uploaded_at IS
  'When these bytes were last PUT to Zernio''s presigned storage. Temp media expires after 7 days; the executor re-uploads before creating a post against an older upload.';
