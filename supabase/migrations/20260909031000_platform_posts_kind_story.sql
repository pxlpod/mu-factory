-- =============================================================================
-- mu — platform_posts.kind gains `story` (2026-09-09)
--
-- The Mac pipeline schedules three kinds of post through Zernio and labels
-- each in `post.metadata.kind`: `video` (the Short), `text` (the Facebook
-- text-lane post) and `story` (an Instagram or Facebook story). The first
-- migration's CHECK allowed only the first two, so a story leg arriving by
-- webhook or poll would fail its upsert. This widens the CHECK and says so on
-- the column. The app now copies `metadata.kind` onto the row.
--
-- SAFE TO RUN TWICE. The constraint is dropped IF EXISTS (under the name
-- Postgres gave the inline CHECK in the first migration) and re-added in one
-- DO block; COMMENT ON is idempotent by nature. Re-adding validates every
-- existing row, which all hold `video` or `text` and so pass.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS mu;

DO $kind$
BEGIN
  ALTER TABLE mu.platform_posts DROP CONSTRAINT IF EXISTS platform_posts_kind_check;
  ALTER TABLE mu.platform_posts
    ADD CONSTRAINT platform_posts_kind_check
    CHECK (kind IN ('video', 'text', 'story'));
END
$kind$;

COMMENT ON COLUMN mu.platform_posts.kind IS
  'video for the Short; text for the Facebook text-lane post; story for an Instagram or Facebook story. From post.metadata.kind; defaults to video.';
