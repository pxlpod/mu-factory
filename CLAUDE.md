# MU Factory — working notes

Read `README.md` first; it carries the laws, the layout and the behaviour per
route. The build spec that produced this scaffold is
`MU-FACTORY-PHASE1-SPEC.md` (outside the repo, 2026-09-08); the house style it
follows is photo-publisher's, debriefed in `CONVENTIONS.md` alongside it.

## What this is

A hosted service on Vercel + Supabase that does the chores around publishing
MU ("Mu the Mindless Rabbit") videos. Christopher (PXLPOD) hosts it. Pausha
creates the videos and looks at Monday. **Nobody operates it.** Phase 1 is the
foundation plus the YouTube finisher: thumbnail, blank caption track, video
language, read-back verification.

## The MU laws — non-negotiable

- **Profile purview.** The Zernio API key sees every profile in the
  workspace, and every profile except `Default` (id
  `6a832a6b4928398841af0647`) is PXLPOD client work. Every list/analytics
  call passes `profileId` from `src/config/zernio.ts`; there is no client
  function that omits it. Every webhook delivery is checked against MU's
  four account ids before a single row is written, and a delivery for any
  other account is recorded as `not MU` and dropped. A read across profiles
  is a bug even when it returns the right answer.
- **Never re-encode silently.** `src/lib/media.ts` has no `sharp` import and
  must never get one. `cover_<Ep>.jpg` goes to YouTube byte for byte; over
  2 MB it is refused with an alert. The only image processing in the repo is
  `src/lib/dhash.ts`, which reads and discards.
- **A verification must be able to fail.** `youtube_finish.state = done`
  requires `caption_verified_at` AND `thumbnail_verified_at`, both written by
  the verify pass from what YouTube actually serves, and the database CHECK
  refuses a `done` without them. Nothing in the finish pass marks anything
  verified. If a change makes verification unable to fail, it is wrong.
- **Monday, not Slack.** Alerts are `create_notification` on the episode's
  Publishing item (fallback: `MONDAY_ALERT_ITEM_ID`). There is no Slack
  webhook, no `SLACK_*` env var, no `slack.ts`. Do not add one.
- **Pausha never runs a script.** `scripts/` are Christopher's one-time
  tools. If a step in a flow would require Pausha to open a terminal, the
  design is wrong.
- **Every failure needs a UI surface or an alert.** A new failure mode means
  a new `logEvent` line on `/status` or a new condition in
  `src/config/alerts.ts`, never a `console.error`.
- **`src/lib/resolve-status.ts` is the only code that changes
  `youtube_finish.state`.** Finish and verify both call it; neither holds an
  opinion of its own about when a row is done.
- **`src/lib/google/auth.ts` is the only file that builds `google.auth.OAuth2`,
  calls `setCredentials`, or persists a rotated token.** Tokens live in
  `mu.credentials`, service-role only, never in env, never in a response.
- **Phase 1 writes no Monday column.** It reads the Publishing board to find
  an item and it sends notifications. `statusValue`/`updateItem` exist in
  `src/lib/monday.ts` for Phase 2 and are unused.

## Conventions

- **Every id and threshold lives in `src/config/`.** Board and column ids,
  Zernio profile and account ids, filenames, the blank SRT, attempt counts,
  the dHash threshold, retention. Nothing else hardcodes one.
- **The Supabase client is pinned to schema `mu`.** Nothing touches `public`.
  Types in `src/types/db.ts` are hand-written; change them in the same commit
  as a migration.
- **Migrations** are `supabase/migrations/<UTC timestamp>_<snake_name>.sql`,
  additive, idempotent ("SAFE TO RUN TWICE" header explaining how), begin
  with `CREATE SCHEMA IF NOT EXISTS mu;`, RLS on with zero policies, grants
  to `service_role` only, `COMMENT ON` for semantics, applied by pasting into
  the SQL editor, explained in plain language in `supabase/migrations/README.md`.
- **Crons are API routes** authorised by `Authorization: Bearer $CRON_SECRET`
  (GET), with the status-page button (POST, `mu_session` cookie) hitting the
  same handler. Every API route exports `runtime = "nodejs"`,
  `dynamic = "force-dynamic"`, `maxDuration`. `vercel.json` holds crons only —
  no `functions` block; memory comes from the dashboard under Active CPU
  billing.
- **Webhooks:** verify the raw body with HMAC-SHA256 + `timingSafeEqual`,
  insert into `webhook_events` first (unique provider+event_id → duplicate is
  a 200), answer, work in `after()`.
- **Vendor clients** are raw `fetch` + `AbortSignal.timeout` + a vendor Error
  subclass + a lazy env getter that throws. `googleapis` is the one SDK
  (Drive via service account, YouTube via OAuth); `sharp` is allowed for the
  read-only hash.
- **Retry policy lives in `src/lib/attempts.ts`.** Finish and verify stop and
  wait for a human at their caps; a missing cover backs off hourly forever
  because nothing is broken.
- **Monday API version is tracked in config** (`2025-10`), not pinned to an
  old one. Status columns, when Phase 2 writes them, go by index.
- **Env is read lazily** inside a throwing getter, never at module top level.
  `requiredEnv()` in `config-check.ts` is the one list; health and `/status`
  both read it.
- **Deploys are `git push` to `main`.** Never the Vercel CLI, never MCP,
  never from a working copy. `git config user.email` must be `web@pxlpod.co`.

## Decisions taken in the scaffold (2026-09-08)

- **Drive scope is `drive.readonly`.** Phase 1 never writes to Drive. Widen it
  in `src/lib/drive.ts` when a phase needs to move a file, not before.
- **Zernio list-posts uses `GET /posts?profileId&platform&status&dateFrom&page&limit`**,
  parameter names confirmed against the Zernio API reference. The response
  envelope was not documented in the same place; `listPublishedPosts`
  tolerates `posts`, `data` and a bare array. The first real sweep settles it
  — the poll logs how many posts it saw.
- **Zernio health probe is `GET /profiles/<MU id>`**, checked by name, rather
  than `GET /profiles`, which would list client profiles.
- **Thumbnail verification trims letterbox bars** (`sharp.trim`) from both
  sides before hashing, because YouTube pads a 9:16 Short into 16:9 for
  `maxres`. If real distances cluster above 14 for correct thumbnails, raise
  `YOUTUBE.thumbnailMaxDistance` and record why; do not remove the check.
- **`attempts` counts the current state.** It resets to 0 when a row enters
  `verify-pending`, so the finish cap (3) and the verify cap (8) are
  independent. A missing cover does not consume an attempt.
- **The import marks `done` rows with all four `*_at` timestamps** set to the
  import time, because the database CHECK requires both verified columns for
  `done`. That is honest: a human verified them in YouTube Studio.
- **`platform_posts.ep` is a real FK to `episodes`**, so `upsertPlatformPost`
  creates a bare `episodes` row when a webhook names an episode the import
  has not seen.
- **Alert `payload` carries `mondayItemId`** so the resolve notification lands
  on the same item the raise did.

## Checking things by hand (Christopher only)

```bash
npx tsx scripts/check-drive.ts             # key, share, Covers/yt contents
npx tsx scripts/check-youtube.ts [videoId] # stored token, live channel, one video's tracks
npx tsx scripts/backfill-covers.ts         # mirror all covers, verified
npx tsx scripts/import-publish-queue.ts ~/Publish-Queue.csv --youtube-done-through 2026-09-01
```

All read `.env.local`. None of them is something Pausha runs.
