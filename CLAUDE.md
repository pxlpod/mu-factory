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
  verified. The Shorts-grid slot follows the same law: `grid_thumbnail_verified_at`
  is written by `resolveGridVerified` alone, from the card the PUBLIC grid
  serves; pressing Save in Studio writes `grid_thumbnail_set_at` and nothing
  more. If a change makes verification unable to fail, it is wrong.
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
- **`src/lib/studio.ts` is the only file that loads or saves the Studio
  session or launches a browser.** The session (`studio_session`) is a
  Playwright storageState exported from a browser a human signed in with; this
  app never signs in to Google itself. Cookies go back to the row only after
  a run has seen Studio accept them.
- **The app's Monday writes are records of what it did, never instructions.**
  `Factory` (since 2026-10-17; spec 16 §6, Pausha: "all actions that happen
  automatically are still reflected in Monday boards") — `src/lib/board-reflect.ts`
  is the only caller of `setFactory`; every write is by index and read back.
  The executor (Phase 3) adds the four **post-id columns** (once per
  hand-off, read back), the **Cover tile** file column (attached once), and
  **Cover status → No cover yet** (only when Drive has no `cover_<Ep>.png`;
  never Approved, never Awaiting review). `Status` is Pausha's: Review →
  Queued is her flip, and Published is written only by the reconcile phase on
  a read-back platform post id — never by the finisher, never by the executor,
  never on an item that is not Queued. Captions and titles are READ from the
  board and never written to it.
- **The executor hands off once, forward only, and ships DRY.** A Queued item
  is handed to Zernio only when its slot is in the future and within
  `PUBLISH.handoffWindowDays` (6; Zernio temp media lives 7), and only when
  the board carries no post ids for it (ids mean `mu_post.py` or a hand got
  there first — reflect *Queued in Zernio* and leave it). A passed slot is
  `publish.slot_missed`, never a post. `PUBLISH_EXECUTOR_MODE` unset = every
  tick is a dry run that touches nothing at Zernio, Monday or the post
  tables (it still beats `publish.tick` and logs its plan to Events when the
  plan changes — a silent dry cron would read as dead); `live` is flipped in
  Vercel after a week of plans has matched the Mac (spec 16 §8). Do not add
  a publish-now path, a back-post path, or a second episode per tick without
  a decision of record.
- **A hand-off can be withdrawn only by the board.** Every executor row keeps
  `copy_hash` (content + title + slot from the board); the reconcile step
  cancels the Zernio post and re-makes it when the hash changes, when Status
  leaves Queued, or when the item is gone. Nothing in Zernio is edited in
  place, and nothing is cancelled for a reason the board does not show.
- **The Shorts-grid tile is set by the Mac's `studio_bot`, by decision**
  (Christopher 2026-10-17, spec 16 §7). The `youtube.grid` cron is retired;
  the route stays for manual runs. Do not re-add the cron or spend time on
  Chromium-on-Vercel for an authenticated Google session; the off-Mac path,
  if ever needed, is a hosted browser with a persistent profile.
- **The order law is code** (`clearGridForReset`): the finisher never sets the
  classic thumbnail on a row with a set or verified grid tile without clearing
  the grid columns in the same step. A human reset of a `wait-for-human` row
  does the same by hand (state → pending AND the grid columns → null/0).

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
- **Retry policy lives in `src/lib/attempts.ts`.** Finish, verify and grid
  stop and wait for a human at their caps; a missing cover backs off hourly
  forever because nothing is broken.
- **Monday API version is tracked in config** (`2025-10`), not pinned to an
  old one. Status columns are written as `{index: N}` where **N is the label's
  ID, not its display position** — the two differ on every column whose labels
  were reordered or hand-created (Publishing "Queued" = id 9 at position 8;
  the Factory column's ids are 17/0/9/1/3/2). `src/config/monday.ts` holds
  ids only. Learned the hard way 2026-10-17 16:00Z (21 failed writes).
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

## Decisions taken for the Shorts grid (2026-09-09)

- **The grid slot has no API.** `thumbnails.set` fills the classic slot only;
  the channel's Shorts tab reads `i.ytimg.com/vi/<id>/sardefault.jpg`, which
  only YouTube Studio's edit page sets (proven 02:50Z). Hence a browser.
- **Own cron (`/api/youtube/grid`, seven minutes after the sweep), not a
  fourth sweep pass.** One row is a browser launch, a Studio page, an upload
  and up to two minutes of polling; inside the sweep that would starve the
  caption and classic-thumbnail work, and an expired Studio session would
  take the whole sweep down. Same auth, run lock, heartbeat and budget shape.
- **Public first.** Before opening Studio the pass reads the public grid; a
  card that already hashes to the cover is recorded and Studio is not touched.
  A human's hand-set thumbnail and a late-propagating upload both land here.
- **A stale session is a rail condition, not a row failure.** A redirect to
  `accounts.google.com` raises `studio.session_expired`, stops the run and
  consumes no `grid_attempts`. Nothing about the video is wrong.
- **`done` on /status means both slots.** `state` still means the classic
  slot (the CHECK is unchanged); the page derives `grid pending` and
  `grid: wait-for-human` from the grid columns and reserves the word `done`.
- **A browser death mid-row is relaunched once, in the run.** Both real
  hosted attempts (Ep019 2026-09-10, Ep008 2026-09-12) died on the first
  navigation with "Target page, context or browser has been closed" and
  Vercel's log held only the request line. The pass now relaunches once and
  retries the row at the same attempt number; Chromium writes its own log to
  `/tmp` (`--enable-logging` + `CHROME_LOG_FILE`; `--log-file` is ignored on
  Linux) and `describeBrowserLoss` puts its
  tail, `/tmp` free space and rss into the event. A second death is the
  row's failure. The Mac's `studio_bot` still runs at 22:20Z daily and
  usually reaches a row first; the hosted pass is only proven once it is off.
- **Run budget in config, not just `maxDuration`.** `STUDIO.runBudgetMs`
  (270 s) and `perRowBudgetMs` (150 s) stop the pass opening a row it cannot
  finish, so a Vercel kill never leaves a half-saved upload unlogged.
- **`@sparticuz/chromium` + `playwright-core`,** both in
  `serverExternalPackages`, with the Chromium binary named in
  `outputFileTracingIncludes` for the grid route only. The binary inflates
  into /tmp once per warm instance; graphics are off. Function CPU is set in
  the dashboard (Standard, 1 vCPU / 2 GB, is enough), never in `vercel.json`.

- **A bulk finisher reset is rationed to ~15 rows a day** (learned 2026-10-17
  22:45Z). YouTube's quota is 10,000 units/day; one finish is ~450 units
  (`captions.insert` 400) plus ~51 per verify pass, so 33 reset rows blew the
  quota two-thirds through, every later sweep failed with `quotaExceeded`
  and burned an attempt, and the hourly health probe raised
  `config.invalid:YouTube` until the 07:00Z reset. The nightly load (one
  Short) is nowhere near the limit. When resetting many rows by hand, set
  `next_attempt_at` on the overflow to after 07:30Z, or reset in batches of
  15 on consecutive days. A `quotaExceeded` error should not consume an
  attempt — not yet coded; add it in `finish.ts` before the next bulk reset.

## Decisions taken for the publish executor (2026-10-17, spec 16 §4)

- **Copy comes from the board, nothing else.** YT title / YT description /
  TikTok caption / IG-FB caption are the Publishing item's columns; the FB
  reel reuses IG-FB caption + YT title (`mu_post.py`'s fallbacks — the board
  never carried more); stories carry `episodes.question`. An empty column is
  a leg that cannot be built (`wait-for-human` after three tries), not a
  guess.
- **Finals are not retained.** `media` rows for `final*` kinds record sha256,
  bytes, Drive id and `retained = false`; the bytes live only inside the
  invocation. Covers are kept in the bucket as the finisher already did.
  Drive is the archive; a second one was not asked for.
- **One Zernio upload per file per episode**, recorded on the `media` row
  (`zernio_key/url/uploaded_at`), reused by every leg, redone after six days
  or when the Drive file's bytes change.
- **The TikTok leg sends no image URL.** The tail card is
  `video_cover_timestamp_ms` from the `_tt_tail.json` sidecar; an image URL
  overrides it and gets dropped (doc 12, 2026-09-10). The timestamp is NOT in
  `copy_hash` — it is machine-derived and would cancel the post every tick.
- **`cover_<Ep>.jpg` is in the YouTube leg's gate** although the executor
  never sends it: the law (doc 12, 2026-09-08) is that the finisher's cover
  exists before the Short publishes.
- **`platform_posts` unique on `(ep, platform, kind) WHERE cancelled_at IS
  NULL`.** A cancelled row stays as history; the re-made post is a new row.
- **Covers are attached as a side-job, five per tick**, before the hand-off,
  so a Queued item carries its tile on the board as soon as the cover exists.
  Dry mode skips this too — dry touches nothing on Monday.
- **`attempts` for `zernio_handoff` is per leg** (`platform_posts.attempts`),
  cap 3, retry 10 min; a failure on one leg does not stop the others, and
  the next tick resumes the item at its remaining legs.

## Checking things by hand (Christopher only)

```bash
npx tsx scripts/check-drive.ts             # key, share, Covers/yt contents
npx tsx scripts/check-youtube.ts [videoId] # stored token, live channel, one video's tracks
npx tsx scripts/backfill-covers.ts         # mirror all covers, verified
npx tsx scripts/check-studio.ts            # is the stored Studio session still signed in? (writes nothing)
npx tsx scripts/import-publish-queue.ts ~/Publish-Queue.csv --youtube-done-through 2026-09-01
```

All read `.env.local`. None of them is something Pausha runs.
