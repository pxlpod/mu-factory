-- =============================================================================
-- mu — Phase 1 foundation (2026-09-08)
--
-- Creates everything MU Factory owns, entirely inside the `mu` schema and the
-- `mu-media` storage bucket, in the `mindless-mu` project
-- (ref bfvrekckhuifncagccqx).
--
-- SAFE TO RUN TWICE. Every statement is CREATE … IF NOT EXISTS, INSERT … ON
-- CONFLICT DO NOTHING, DROP TRIGGER IF EXISTS before CREATE TRIGGER, or a DO
-- block that checks before it acts. Running it a second time changes nothing
-- and reports success — which matters because it is applied by pasting into
-- the SQL editor, and a half-applied migration re-run should complete rather
-- than abort.
--
-- SERVICE ROLE ONLY. Row-level security is ON for every table with ZERO
-- policies, and `anon`/`authenticated` are granted nothing. No browser ever
-- talks to this schema; every read and write goes through a server route
-- holding the service-role key. Supabase's advisor will report one
-- "RLS enabled, no policies" notice per table. Those are correct.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS mu;

GRANT USAGE ON SCHEMA mu TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mu GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mu GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA mu GRANT ALL ON FUNCTIONS TO service_role;


-- -----------------------------------------------------------------------------
-- updated_at
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mu.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION mu.touch_updated_at() IS
  'BEFORE UPDATE trigger body: stamps updated_at so the app never has to remember to.';


-- -----------------------------------------------------------------------------
-- credentials — OAuth tokens and the parked OAuth state, service-role only
--
-- ONE ROW PER PROVIDER, keyed by name. `youtube` holds the Google refresh
-- token, access token, expiry, scope and the channel it authorised;
-- `google:state` holds the one-time state between Connect and the callback.
-- These values are the authority to edit MU's channel and must never reach a
-- browser.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mu.credentials (
  provider    text PRIMARY KEY,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE mu.credentials IS
  'OAuth material, one row per provider (youtube, google:state). Service role only.';

DROP TRIGGER IF EXISTS credentials_touch_updated_at ON mu.credentials;
CREATE TRIGGER credentials_touch_updated_at
  BEFORE UPDATE ON mu.credentials
  FOR EACH ROW EXECUTE FUNCTION mu.touch_updated_at();


-- -----------------------------------------------------------------------------
-- webhook_events — every Zernio delivery, once
--
-- INSERT FIRST, PROCESS AFTER. Zernio expects a 2xx within five seconds and
-- retries up to seven times, so the receiver inserts this row, answers, and
-- works afterwards. The unique (provider, event_id) is the whole dedupe: a
-- replay conflicts and is answered 200 without a second write.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mu.webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL DEFAULT 'zernio',
  event_id      text NOT NULL,
  event         text,
  payload       jsonb,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  error         text,

  CONSTRAINT webhook_events_provider_event_key UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS webhook_events_received_at_idx
  ON mu.webhook_events (received_at DESC);

COMMENT ON COLUMN mu.webhook_events.error IS
  'Why the delivery was not acted on ("not MU: account …"), or what failed. Null = handled.';


-- -----------------------------------------------------------------------------
-- events — the log; the status page's whole data source
--
-- Nobody here reads Vercel logs. Every outcome the sweep, the webhook, the
-- health probe or a script produces is a row here.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mu.events (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at       timestamptz NOT NULL DEFAULT now(),
  level    text NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  area     text NOT NULL,
  message  text NOT NULL,
  detail   jsonb,
  ep       text,
  run_id   uuid
);

CREATE INDEX IF NOT EXISTS events_at_idx ON mu.events (at DESC);
CREATE INDEX IF NOT EXISTS events_ep_idx ON mu.events (ep) WHERE ep IS NOT NULL;

COMMENT ON COLUMN mu.events.area IS
  'webhook | poll | finish | verify | cover | health | import | auth — how /status groups lines.';


-- -----------------------------------------------------------------------------
-- heartbeats — when each cron route last completed
--
-- A cron that stops firing produces no error and no evidence; a Short
-- publishes and nothing finishes it. This is the only way to tell "nothing to
-- do" from "nothing running".
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mu.heartbeats (
  route    text PRIMARY KEY,
  last_at  timestamptz NOT NULL DEFAULT now(),
  status   text,
  detail   text
);


-- -----------------------------------------------------------------------------
-- alerts — one row per CONDITION, not per occurrence
--
-- `condition_key` carries the identity — `youtube.finish_stuck:Ep017`,
-- `cron.dead:youtube.sweep` — so two episodes stuck are two conditions while
-- one episode stuck twice is one. Raised once, re-notified no more often than
-- the cooldown, resolved exactly once. Notifications go to Monday.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mu.alerts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  condition_key     text NOT NULL UNIQUE,
  condition         text NOT NULL,
  subject           text,
  message           text,
  payload           jsonb,
  raised_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_notified_at  timestamptz,
  resolved_at       timestamptz,
  count             int NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS alerts_open_idx
  ON mu.alerts (resolved_at, last_seen_at DESC);

COMMENT ON COLUMN mu.alerts.last_notified_at IS
  'When Monday was last told. Null while every send has failed — the condition stays loud.';


-- -----------------------------------------------------------------------------
-- runs — the run lock and a summary per sweep
--
-- An open row (finished_at IS NULL) younger than ten minutes means a sweep is
-- in flight and the next tick stands down.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mu.runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route        text NOT NULL,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  summary      jsonb
);

CREATE INDEX IF NOT EXISTS runs_route_started_idx
  ON mu.runs (route, started_at DESC);


-- -----------------------------------------------------------------------------
-- episodes — one row per Ep, imported from the Mac's Publish-Queue.csv
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mu.episodes (
  ep                          text PRIMARY KEY CHECK (ep ~ '^Ep\d{3}$'),
  slug                        text,
  lane                        text,
  series                      text,
  look                        text,
  question                    text,
  duration_s                  numeric,
  final_file                  text,
  post_date                   date,
  post_time_local             text,
  timezone                    text,
  queue_status                text,
  monday_publishing_item_id   text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE mu.episodes IS
  'The record of episodes. Monday is a surface on top of this, not the record.';
COMMENT ON COLUMN mu.episodes.queue_status IS
  'The Publish-Queue.csv status column, verbatim. Informational in Phase 1.';

DROP TRIGGER IF EXISTS episodes_touch_updated_at ON mu.episodes;
CREATE TRIGGER episodes_touch_updated_at
  BEFORE UPDATE ON mu.episodes
  FOR EACH ROW EXECUTE FUNCTION mu.touch_updated_at();


-- -----------------------------------------------------------------------------
-- platform_posts — one row per (platform, Zernio post)
--
-- `ep` is nullable because a post can arrive by webhook before anyone has
-- said which episode it is. UNIQUE (platform, zernio_post_id) is what makes
-- the webhook and the poll converge on one row.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mu.platform_posts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ep                 text REFERENCES mu.episodes(ep) ON DELETE SET NULL,
  platform           text NOT NULL
                       CHECK (platform IN ('tiktok', 'instagram', 'youtube', 'facebook')),
  kind               text NOT NULL DEFAULT 'video' CHECK (kind IN ('video', 'text')),
  zernio_post_id     text,
  zernio_account_id  text,
  platform_post_id   text,
  published_url      text,
  status             text,
  scheduled_for      timestamptz,
  published_at       timestamptz,
  source             text NOT NULL CHECK (source IN ('import', 'webhook', 'poll')),
  raw                jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT platform_posts_platform_zernio_key UNIQUE (platform, zernio_post_id)
);

CREATE INDEX IF NOT EXISTS platform_posts_ep_idx ON mu.platform_posts (ep);
CREATE INDEX IF NOT EXISTS platform_posts_platform_post_idx
  ON mu.platform_posts (platform, platform_post_id) WHERE platform_post_id IS NOT NULL;

COMMENT ON COLUMN mu.platform_posts.platform_post_id IS
  'The platform''s own id. For youtube this is the video id.';
COMMENT ON COLUMN mu.platform_posts.source IS
  'Who FIRST told us about this post: import (CSV), webhook, or poll. Never rewritten.';
COMMENT ON COLUMN mu.platform_posts.kind IS
  'video for the Short; text for the Facebook text-lane post (facebook_text_post_id in the CSV).';

DROP TRIGGER IF EXISTS platform_posts_touch_updated_at ON mu.platform_posts;
CREATE TRIGGER platform_posts_touch_updated_at
  BEFORE UPDATE ON mu.platform_posts
  FOR EACH ROW EXECUTE FUNCTION mu.touch_updated_at();


-- -----------------------------------------------------------------------------
-- youtube_finish — the finisher's state machine, one row per YouTube post
--
-- pending → (cover, language, caption, thumbnail) → verify-pending →
-- (read-back) → done. Anything the code cannot decide goes to wait-for-human
-- with last_error saying why. `done` requires BOTH verified timestamps; the
-- app enforces that in one file (resolve-status.ts) and the CHECK below makes
-- the database refuse a `done` row that lacks them.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mu.youtube_finish (
  platform_post_id       uuid PRIMARY KEY REFERENCES mu.platform_posts(id) ON DELETE CASCADE,
  ep                     text,
  video_id               text,
  state                  text NOT NULL DEFAULT 'pending'
                           CHECK (state IN ('pending', 'verify-pending', 'done', 'wait-for-human', 'skipped')),
  thumbnail_set_at       timestamptz,
  thumbnail_verified_at  timestamptz,
  thumbnail_distance     int,
  caption_track_id       text,
  caption_set_at         timestamptz,
  caption_verified_at    timestamptz,
  language_set_at        timestamptz,
  attempts               int NOT NULL DEFAULT 0,
  last_attempt_at        timestamptz,
  next_attempt_at        timestamptz,
  last_error             text,
  cover_sha256           text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS youtube_finish_state_idx
  ON mu.youtube_finish (state, next_attempt_at, created_at);

COMMENT ON COLUMN mu.youtube_finish.thumbnail_distance IS
  'dHash Hamming distance between the thumbnail YouTube serves and our cover. <= 14 verifies.';
COMMENT ON COLUMN mu.youtube_finish.attempts IS
  'Consecutive attempts in the CURRENT state. Reset to 0 when the row enters verify-pending.';
COMMENT ON COLUMN mu.youtube_finish.state IS
  'pending | verify-pending | done | wait-for-human | skipped. done needs both *_verified_at.';

-- `done` without both verifications is refused by the database, not just by
-- the app. Rows the import marks done by hand carry the import timestamp in
-- both columns, which is honest: a human verified them in YouTube Studio.
DO $done$
BEGIN
  ALTER TABLE mu.youtube_finish DROP CONSTRAINT IF EXISTS youtube_finish_done_is_verified;
  ALTER TABLE mu.youtube_finish
    ADD CONSTRAINT youtube_finish_done_is_verified
    CHECK (
      state <> 'done'
      OR (thumbnail_verified_at IS NOT NULL AND caption_verified_at IS NOT NULL)
    );
END
$done$;

DROP TRIGGER IF EXISTS youtube_finish_touch_updated_at ON mu.youtube_finish;
CREATE TRIGGER youtube_finish_touch_updated_at
  BEFORE UPDATE ON mu.youtube_finish
  FOR EACH ROW EXECUTE FUNCTION mu.touch_updated_at();


-- -----------------------------------------------------------------------------
-- media — files mirrored from Drive into the `mu-media` bucket
--
-- One row per (ep, kind). Phase 1 mirrors cover_yt only. sha256 is of the
-- bytes as exported; the stored object is re-downloaded and re-hashed before
-- the row is written.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mu.media (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ep             text NOT NULL,
  kind           text NOT NULL
                   CHECK (kind IN ('final', 'final_tt', 'cover_ig', 'cover_yt', 'cover_fb')),
  drive_file_id  text,
  drive_md5      text,
  storage_path   text,
  sha256         text,
  bytes          bigint,
  mirrored_at    timestamptz,

  CONSTRAINT media_ep_kind_key UNIQUE (ep, kind)
);

COMMENT ON COLUMN mu.media.mirrored_at IS
  'Null with a storage_path of null means the file was seen but refused (e.g. over 2 MB).';


-- -----------------------------------------------------------------------------
-- Row-level security: on everywhere, zero policies, service role only.
-- -----------------------------------------------------------------------------
ALTER TABLE mu.credentials     ENABLE ROW LEVEL SECURITY;
ALTER TABLE mu.webhook_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mu.events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE mu.heartbeats      ENABLE ROW LEVEL SECURITY;
ALTER TABLE mu.alerts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE mu.runs            ENABLE ROW LEVEL SECURITY;
ALTER TABLE mu.episodes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE mu.platform_posts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mu.youtube_finish  ENABLE ROW LEVEL SECURITY;
ALTER TABLE mu.media           ENABLE ROW LEVEL SECURITY;

GRANT ALL ON ALL TABLES IN SCHEMA mu TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA mu TO service_role;
REVOKE ALL ON ALL TABLES IN SCHEMA mu FROM anon, authenticated;


-- -----------------------------------------------------------------------------
-- Storage bucket
--
-- Private. Nothing here needs a public URL: covers are handed to YouTube as
-- bytes. `storage.objects` carries RLS with no policy for this bucket, so the
-- service-role key is the only way in.
-- -----------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('mu-media', 'mu-media', false)
ON CONFLICT (id) DO NOTHING;


-- -----------------------------------------------------------------------------
-- Expose `mu` to PostgREST
--
-- supabase-js reaches a schema only if PostgREST is configured to serve it,
-- and the app pins its client to `mu`. THIS IS A NEW PROJECT, so `mu` is not
-- exposed yet: without this block every query returns PGRST106 and the status
-- page's Supabase line goes red.
--
-- APPENDS, never replaces: `public`, `graphql_public` and anything else
-- already exposed stay exposed.
--
-- The dashboard (Project Settings → API → Exposed schemas) is the DURABLE
-- place for this. A later save there overwrites the role setting, so add
-- `mu` in the dashboard too — this block gets the app running now and the
-- dashboard keeps it running. Copied from photo-publisher v1.0.
-- -----------------------------------------------------------------------------
DO $expose$
DECLARE
  current_schemas text;
BEGIN
  SELECT split_part(cfg, '=', 2) INTO current_schemas
  FROM pg_catalog.pg_roles r,
       LATERAL unnest(COALESCE(r.rolconfig, '{}')) AS cfg
  WHERE r.rolname = 'authenticator'
    AND cfg LIKE 'pgrst.db_schemas=%'
  LIMIT 1;

  IF current_schemas IS NULL THEN
    current_schemas := 'public, graphql_public';
  END IF;

  IF NOT (string_to_array(replace(current_schemas, ' ', ''), ',') @> ARRAY['mu']) THEN
    EXECUTE format(
      'ALTER ROLE authenticator SET pgrst.db_schemas = %L',
      current_schemas || ', mu'
    );
    RAISE NOTICE 'Exposed schema `mu` to PostgREST (was: %)', current_schemas;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE
    'Could not expose `mu` to PostgREST from SQL. Add it by hand: '
    'Supabase dashboard -> Project Settings -> API -> Exposed schemas.';
END
$expose$;

NOTIFY pgrst, 'reload config';
