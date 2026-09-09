-- =============================================================================
-- mu — the Shorts GRID thumbnail slot (2026-09-09)
--
-- YouTube's Data API sets only the classic thumbnail. The card on the
-- channel's Shorts tab reads a separate, Studio-only image. These columns
-- track that second slot on the same `youtube_finish` row: when it was set
-- (by driving Studio in a browser), when it was VERIFIED (by hashing the card
-- the public grid serves against the cover), the measured distance, and the
-- grid step's own attempt counter, retry gate and last error.
--
-- Five of the six columns were first added by hand from the Mac-side tool
-- (Tools/studio_bot) before this file existed; this migration records them so
-- the repository and the database agree, and adds the one the hosted step
-- needs (`grid_next_attempt_at`, the same gate `next_attempt_at` is for the
-- classic slot).
--
-- SAFE TO RUN TWICE. Every ADD COLUMN is IF NOT EXISTS; the constraint is
-- dropped IF EXISTS before it is added; COMMENT ON is idempotent by nature.
-- The constraint is added NOT VALID so rows verified before it existed are
-- not re-judged — it binds every row written from now on.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS mu;

ALTER TABLE mu.youtube_finish ADD COLUMN IF NOT EXISTS grid_thumbnail_set_at       timestamptz;
ALTER TABLE mu.youtube_finish ADD COLUMN IF NOT EXISTS grid_thumbnail_verified_at  timestamptz;
ALTER TABLE mu.youtube_finish ADD COLUMN IF NOT EXISTS grid_thumbnail_distance     int;
ALTER TABLE mu.youtube_finish ADD COLUMN IF NOT EXISTS grid_attempts               int NOT NULL DEFAULT 0;
ALTER TABLE mu.youtube_finish ADD COLUMN IF NOT EXISTS grid_next_attempt_at        timestamptz;
ALTER TABLE mu.youtube_finish ADD COLUMN IF NOT EXISTS grid_error                  text;

COMMENT ON COLUMN mu.youtube_finish.grid_thumbnail_set_at IS
  'When cover_<Ep>.jpg was uploaded to the Shorts-grid slot through YouTube Studio. Proves nothing on its own.';
COMMENT ON COLUMN mu.youtube_finish.grid_thumbnail_verified_at IS
  'Set only when the card the PUBLIC Shorts grid serves hashes within the threshold of the cover (<= 14). This, not thumbnail_verified_at, is what Pausha sees.';
COMMENT ON COLUMN mu.youtube_finish.grid_thumbnail_distance IS
  'dHash Hamming distance between the served grid card (centre 9:16) and our cover, from the latest look.';
COMMENT ON COLUMN mu.youtube_finish.grid_attempts IS
  'Consecutive failed grid attempts. At 3 the row waits for a human and alerts. A stale Studio session does not count.';
COMMENT ON COLUMN mu.youtube_finish.grid_next_attempt_at IS
  'The grid pass skips this row until this time. NULL means now.';
COMMENT ON COLUMN mu.youtube_finish.grid_error IS
  'Why the last grid attempt did not verify, in words /status can show.';

-- A verified grid slot always carries the distance that verified it. The app
-- enforces the threshold in one place (resolve-status.ts); the database
-- refuses the shape where "verified" has no measurement behind it.
DO $grid$
BEGIN
  ALTER TABLE mu.youtube_finish DROP CONSTRAINT IF EXISTS youtube_finish_grid_verified_has_distance;
  ALTER TABLE mu.youtube_finish
    ADD CONSTRAINT youtube_finish_grid_verified_has_distance
    CHECK (grid_thumbnail_verified_at IS NULL OR grid_thumbnail_distance IS NOT NULL)
    NOT VALID;
END
$grid$;

CREATE INDEX IF NOT EXISTS youtube_finish_grid_pending_idx
  ON mu.youtube_finish (state, grid_next_attempt_at, created_at)
  WHERE grid_thumbnail_verified_at IS NULL;
