# MU Factory

The hosted automation service for **MU ("Mu the Mindless Rabbit")**, a
TikTok / Instagram / YouTube / Facebook video character. It replaces the
manual Terminal-and-Chrome chores in the publishing workflow.

Built by Claude, hosted by Christopher (PXLPOD) on **Vercel + Supabase**,
operated by nobody: Pausha (the creator) never runs a script. The human
control surface is **Monday.com**; Postgres (Supabase) is the record.

**Phase 1 = the foundation and the YouTube finisher.** After a Short publishes
through Zernio, YouTube auto-generates a caption track that double-prints over
MU's burned-in karaoke captions, and Zernio cannot set a YouTube thumbnail.
This app uploads `cover_<Ep>.jpg` as the thumbnail, publishes a blank caption
track that overrides the auto one, sets the video language, and then **reads
both back to prove it** — triggered by Zernio's webhook, with a poll fallback.

**Plus the Shorts-grid thumbnail (2026-09-09).** The Data API sets only the
classic thumbnail; the card on the channel's Shorts tab reads a second image
(`i.ytimg.com/vi/<videoId>/sardefault.jpg`) that only YouTube Studio can set. A separate pass drives Studio in a headless
browser with a session Christopher exports once from his Mac, uploads the same
cover, and then **reads the public grid back** and hashes the card. Nothing
here calls that done because Save was pressed.

**Since 2026-10-17 the app also writes ONE Monday column, `Factory`** (spec
`16_Factory-Migration-Spec.md` §6, in the MU hub folder): a verified finish
shows as *YT finished* on the episode's Publishing item, and a Queued item due
within 24 h with no post ids shows as *Needs files* and raises an alert a day
ahead. The migration spec is the plan of record for moving the rest of
publishing off Pausha's Mac; this README describes what is live.

**The Shorts-grid cron is retired (2026-10-17).** The tile is set by the Mac's
`studio_bot` launchd job — the one declared Mac exception (spec 16 §7). The
`/api/youtube/grid` route stays for a manual run from `/status`.

**Operating it: [RUNBOOK.md](RUNBOOK.md).** Agent notes and the laws:
[CLAUDE.md](CLAUDE.md).

---

## The laws

Violations are build failures, not preferences.

1. **Profile purview.** The Zernio account also holds PXLPOD client work.
   Every Zernio read passes MU's profile id; every webhook is checked against
   MU's four account ids before anything acts. Other profiles are never read.
2. **Never re-encode silently.** The JPEG Pausha exported is the JPEG YouTube
   gets, byte for byte. Over 2 MB is a `wait-for-human` and an alert, not a
   quiet quality drop.
3. **A verification must be able to fail.** `done` requires the caption track
   to be read back AND the served thumbnail to hash within 14 bits of the
   cover. A 200 from `thumbnails.set` proves nothing and marks nothing. The
   Shorts-grid slot is the same: `grid_thumbnail_verified_at` comes only from
   hashing the card the PUBLIC grid serves, never from Studio's Save button,
   and `/status` says "done" for a row only when both slots are verified.
4. **Monday, not Slack.** Alerts are Monday notifications aimed at the
   episode's Publishing item. There is no Slack in this repository.
5. **Pausha never runs a script.** Anything she would need to do is a Monday
   gesture or nothing. Scripts are Christopher's one-time tools.
6. **Every failure gets a `/status` line or a Monday notification.**
   `console.*` is not a surface.
7. **Every automatic action gets a board write** (Pausha, 2026-10-17: "so I
   can see what's happening"). The `Factory` column on the Publishing board
   is the machine's, written by index and read back; `Status` stays Pausha's
   (Review → Queued is her flip; Published is written only on a read-back
   platform post id, by the reconcile phase). `src/lib/board-reflect.ts` is
   the one place that writes `Factory`. The publish executor (Phase 3) adds
   exactly three more writes, all of them records of what it did: the four
   **post-id columns** (one per platform, written once per hand-off, read
   back), the **Cover tile** file column (the IG cover, attached once), and
   **Cover status → No cover yet** when a Queued video has no cover in Drive.
   Nothing else on the board is the machine's.
8. **Nothing posts twice, and nothing is back-posted.** The executor hands
   off only a `Queued` item whose slot is in the future and within six days,
   and only one with no post ids on it (ids mean someone else already queued
   it). A slot that passes un-handed-off raises `publish.slot_missed` and is
   left alone: move its Date forward and it goes then. The executor ships
   **DRY** (`PUBLISH_EXECUTOR_MODE` unset): every tick plans and writes
   nothing until the switch is flipped to `live` in Vercel.

## Deploy

Git push to `main`. Vercel (team PXLPOD Web, project `mu-factory`) builds
every push. **Never** deploy from a working copy — no CLI, no MCP. Check
`git config user.email` is `web@pxlpod.co` before the first commit.

## Layout

```
src/config/factory.ts          schema, bucket, episode pattern, filenames, Drive folder paths, caps
src/config/zernio.ts           base URL, MU profile + account ids, webhook events, list params
src/config/youtube.ts          scope, per-run cap, attempt counts, dHash threshold, the blank SRT
src/config/monday.ts           board ids, column ids, API version, alert fallback item
src/config/alerts.ts           cooldown, cron-dead window, retention, condition keys
src/config/publish.ts          the executor: hand-off window, per-tick caps, platform settings, legs, DRY/LIVE switch
src/lib/supabase.ts            the one service-role client, pinned to schema `mu`
src/lib/auth.ts                APP_PASSWORD → HMAC cookie `mu_session`
src/lib/events.ts              logEvent — the only writer to `events`
src/lib/heartbeat.ts           beat / deadRoutes
src/lib/alerts.ts              raiseAlert / resolveAlert, 24 h cooldown, Monday notifications
src/lib/attempts.ts            retry policy for finish / verify / cover, in one table
src/lib/monday.ts              gql, paginated items_page, notify, checkBoard, setFactory (the one column write)
src/lib/board-reflect.ts       Factory column: reflect a finish, hourly backfill (spec 16 §6)
src/lib/preflight.ts           Queued + due within 24 h + no post ids → publish.blocked (spec 16 §4.1)
src/lib/slots.ts               slot instants and Zernio wall-clock strings, one timezone
src/lib/publish/executor.ts    the tick: reconcile → attach covers → missed slots → hand off one episode
src/lib/publish/legs.ts        item → the Zernio posts it means (copy from the board), copy hash
src/lib/publish/media.ts       Drive → (bucket for covers) → Zernio upload, one upload per file per episode
src/lib/drive.ts               service-account Drive, folder paths by name, read-only
src/lib/google/auth.ts         the ONLY OAuth2 builder; consent URL, code exchange, token rotation
src/lib/google/credentials.ts  `mu.credentials` rows for `youtube` and `google:state`
src/lib/youtube/client.ts      videos.list/update, captions.list/insert, thumbnails.set, channel probe
src/lib/youtube/finish.ts      the sweep: poll → finish → verify
src/lib/youtube/grid.ts        the Shorts-grid pass: Studio upload → public-grid read-back
src/lib/studio.ts              the exported Studio session (mu.credentials), the headless browser
src/lib/resolve-status.ts      the ONLY code that changes `youtube_finish.state`
src/lib/media.ts               cover mirror Drive → storage, sha256 read-back, 2 MB refusal
src/lib/dhash.ts               64-bit dHash + Hamming, in memory only
src/lib/zernio/client.ts       fetch wrapper, list/get posts (profile-scoped), URL finder, upload, create/cancel scheduled post
src/lib/zernio/posts.ts        applyPost — one path for webhook and poll; episode resolution
src/lib/zernio/events.ts       what happens to a delivery after 200
src/lib/health.ts              hourly probes, cron-dead, housekeeping
src/lib/config-check.ts        the red/green lines on /status; requiredEnv()
src/app/status                 the only page
src/app/google/{connect,callback}   the OAuth dance (non-/api)
src/app/api/{youtube/sweep,youtube/grid,publish/tick,health,webhooks/zernio}
supabase/migrations/           `<UTC timestamp>_<name>.sql` + README.md
scripts/                       import-publish-queue, check-drive, check-youtube, check-studio, backfill-covers
```

## Supabase

Project `mindless-mu` (ref `bfvrekckhuifncagccqx`), schema **`mu`**, bucket
**`mu-media`**. Nothing here touches `public`.

Apply the files in `supabase/migrations/` in order in the SQL editor — [the
migrations README](supabase/migrations/README.md) walks through them. Every
one is idempotent.

Afterwards confirm `mu` is in **Project Settings → API → Exposed schemas**.
The migration adds it, but the dashboard is the durable place: a later save
there would drop it and every query would return `PGRST106`.

## Environment

| Variable | Where the value comes from |
|---|---|
| `SUPABASE_URL` | `https://bfvrekckhuifncagccqx.supabase.co`. Supabase → Project Settings → API. |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page, the `service_role` secret. Server-only; never `NEXT_PUBLIC_`. |
| `MONDAY_API_TOKEN` | Monday → avatar (bottom left) → Developer → My access tokens → Show. |
| `MONDAY_ALERT_ITEM_ID` | An item on the Publishing board that receives alerts with no episode (make one called "MU Factory alerts"). From its URL. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The downloaded service-account key, base64: `base64 -i key.json \| pbcopy`. |
| `DRIVE_ROOT_FOLDER_ID` | The MU root folder id from its Drive URL. `Covers/yt` lives under it. |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | Google Cloud → Credentials → the Web application OAuth client. |
| `APP_URL` | The deployed origin, no trailing slash. The OAuth redirect is `${APP_URL}/google/callback`. |
| `ZERNIO_API_KEY` | Zernio dashboard → Settings → API. |
| `ZERNIO_WEBHOOK_SECRET` | Generated when you register `${APP_URL}/api/webhooks/zernio` at Zernio. |
| `CRON_SECRET` | Any long random string: `openssl rand -hex 32`. Vercel Cron sends it as a bearer token. |
| `APP_PASSWORD` | Your choice. The single password for `/status`. |
| `PUBLISH_EXECUTOR_MODE` | Optional. `live` makes the publish tick hand off for real; unset or anything else is a DRY RUN: the tick touches nothing at Zernio or Monday and makes no post rows; it only records its plan in Events (when the plan changes) and its heartbeat. Flip it in Vercel after a week of plans has matched the Mac. |

No `NEXT_PUBLIC_*` anywhere. Env is read lazily inside throwing getters, never
at module top level. `.env.example` lists every name with its provenance.

## Behaviour

### `POST /api/webhooks/zernio`

Verify the HMAC-SHA256 signature against the **raw body**
(`x-zernio-signature` / `x-late-signature`, `timingSafeEqual`) → insert into
`webhook_events` (unique `provider + event_id`; a duplicate is answered 200
and nothing else runs) → answer 200 → work in `after()`:

- Any account id not in MU's four → row marked processed with `not MU`, stop.
- Resolve the episode: `post.metadata.episode` if valid, else an existing
  `platform_posts` row for that Zernio post id, else null.
- Upsert one `platform_posts` row per platform leg (`source: webhook`), with
  `kind` from `post.metadata.kind` (`video` | `text` | `story`; anything else
  leaves the row's kind alone, defaulting to `video`).
- A published YouTube leg with a video id → `youtube_finish` row, `pending`.
  Unknown episode → still created, `wait-for-human`, alert
  `youtube.unknown_episode:<video_id>`.
- `post.failed` / `post.platform.failed` → alert
  `zernio.post_failed:<zernio_post_id>` on the episode's Publishing item.

### `GET /api/youtube/sweep` — cron `*/15 * * * *`, `maxDuration 300`

Same handler for `POST` from the status button. Run lock via `runs`.

1. **Poll.** `GET /posts?profileId=<MU>&platform=youtube&status=published&dateFrom=<14 d ago>`.
   Anything not yet in `platform_posts` is applied exactly as a webhook would
   be (`source: poll`). A `done` finish row is never re-opened.
2. **Finish** `pending` rows, oldest first, up to 8 per run, honouring
   `next_attempt_at`. Each step is skipped when its `*_at` is already set:
   - a. **Cover** — `media` row, else Drive `Covers/yt/cover_<Ep>.jpg` →
     download → sha256 → upload to `mu-media/covers/yt/` → download again and
     re-hash → `media` row. Over 2 MB → `wait-for-human` + alert
     `youtube.cover_too_large:<Ep>`. Not in Drive yet → stay `pending`, look
     again in an hour, warn line only.
   - b. `videos.list` — must exist, public or unlisted. Not found →
     `wait-for-human`. **Private on a row under 30 min old = publish lag**
     (Ep007, Ep009): looked at again every 5 min, no attempt used; private on
     an older row → `wait-for-human`.
   - c. `snippet.defaultLanguage !== "en"` → `videos.update` with the
     existing title/categoryId/description/tags + `defaultLanguage: "en"`.
   - d. `captions.list` — a non-`asr` `en` track already there → record it;
     else `captions.insert` (`{videoId, language: "en", name: "English",
     isDraft: false}`, `application/x-subrip`, the one-cue U+2800 SRT).
   - e. `thumbnails.set` with the cover's bytes. **Order law:** if the row's
     Shorts-grid tile is already set or verified, the grid columns are cleared
     in the same step (`clearGridForReset`) — the classic thumbnail resets the
     grid tile (doc 12, 2026-09-10), so the grid bot must set it again.
   - f. state → `verify-pending`, attempts reset.
   Three failed attempts → `wait-for-human` + alert `youtube.finish_stuck:<Ep>`.
3. **Verify** `verify-pending` rows: `captions.list` must show the standard
   `en` track; the thumbnail YouTube serves (`snippet.thumbnails.maxres`, then
   `high`) is downloaded, letterbox-trimmed, dHashed (9×8 greyscale) and
   compared with the cover — Hamming ≤ 14 passes. Both → `done`, alerts for
   that episode resolved, **and the episode's Publishing item gets
   `Factory → YT finished`** (read back; a failed write is
   `monday.write_failed:<Ep>` and the hourly backfill retries). Not yet → wait
   15 min. Eight looks → `wait-for-human` + alert `youtube.verify_failed:<Ep>`
   carrying the distance.
4. Heartbeat `youtube.sweep`; every outcome is an `events` row; returns
   `{polled, finished, verified, waiting, errors}`.

### `GET /api/youtube/grid` — **no longer a cron** (retired 2026-10-17), `maxDuration 300`

The route stays for a manual run from the status button (`POST`, run lock via
`runs`, `youtube.grid`). It was a cron at `7,22,37,52 * * * *` from 2026-09-10
to 2026-10-17 and never completed a row on Vercel (Chromium died on every
attempt — `/tmp` starvation under `@sparticuz/chromium`), while the Mac's
`studio_bot` set every tile. Decision of record (spec 16 §7, Christopher
2026-10-17): the grid tile is the one declared Mac job; do not sink more time
into an authenticated Google session in a serverless browser. Its silence is
no longer a `cron.dead` condition. What follows describes the route as built.

**Its own route, not a fourth pass of the sweep**, because one row is a
browser launch, a Studio page, an upload and up to two minutes of polling —
most of the 300 s the sweep budgets for eight finishes and eight verifies —
and because a dead Studio session must not stop captions and classic
thumbnails from being finished.

1. Select `youtube_finish` rows with `state = done`, a video id and an
   episode, `grid_thumbnail_verified_at IS NULL`, under the attempt cap and
   past `grid_next_attempt_at`; oldest first, up to 2 per run, and no new row
   is opened once fewer than 150 s of the 270 s budget remain. No rows → no
   browser.
2. Load the Studio session from `mu.credentials` (`studio_session`, a
   Playwright storageState plus the user agent it was signed in with). None →
   alert `studio.session_expired`, stop.
3. Launch `@sparticuz/chromium` via `playwright-core`; one context with the
   exported cookies under the exported user agent (Studio refuses a UA that
   says HeadlessChrome), one anonymous context for the public grid.
4. Per row: **a.** the cover's bytes from storage (`ensureCoverYt`).
   **b.** Look at the public grid first — if the card for the video already
   hashes within 14 bits of the cover, record it and touch nothing.
   **c.** Open `studio.youtube.com/video/<id>/edit`. A redirect to
   `accounts.google.com` → alert `studio.session_expired` with the
   instruction "re-run `studio_bot.mjs login && export`", no attempt consumed,
   run stops. Otherwise `setInputFiles` on `ytcp-thumbnail-uploader
   input#file-loader` with the cover's own bytes, wait for `ytcp-button#save`
   to enable, click, wait for it to disable again, wait 8 s →
   `grid_thumbnail_set_at`. **d.** Poll `youtube.com/@mindless_mu/shorts`
   anonymously every 10 s for up to 2 min: find
   `a[href*="/shorts/<id>"]`, take its card's `img.currentSrc`, download,
   centre-crop 9:16, dHash, compare. ≤ 14 → `grid_thumbnail_verified_at` +
   `grid_thumbnail_distance`, written by `resolveGridVerified` alone.
   Not within the window → `grid_attempts + 1`, `grid_error`, again in 15
   min. Three → the row waits for a human + alert `youtube.grid_stuck:<Ep>`.
   A browser that dies under a row (single-process Chromium: one renderer
   crash is the whole browser) is relaunched once in the same run and the
   row retried without consuming an attempt; the warn line carries how long
   it lived, `/tmp` free space, memory and the tail of Chromium's own log.
5. Write the rotated cookies back to `mu.credentials` — only if Studio
   accepted the session this run. Heartbeat `youtube.grid`; every outcome is
   an `events` row with area `grid`; returns
   `{checked, uploaded, verified, waiting, errors}`.

### `GET /api/publish/tick` — cron `*/10 * * * *`, `maxDuration 300`

The publish executor (spec 16 §4). Replaces the Mac's `mu_post.py`. Run lock
`publish.tick`; heartbeat `publish.tick`; budget `PUBLISH.runBudgetMs`
(270 s) so a Vercel kill never lands mid-upload. **DRY unless
`PUBLISH_EXECUTOR_MODE=live`**, and dry on demand (`?dry=1`, the **Publish
dry run** button): a dry tick reads everything, touches nothing at Zernio, Monday or the
post tables, beats its heartbeat, and puts its plan in Events whenever the
plan differs from the previous tick's. Four steps, in order:

1. **Reconcile** every active `platform_posts` row the executor made (status
   `scheduled`). If its item is gone or no longer `Queued`, or the copy hash
   (content + title + slot, from the board) has changed, the Zernio post is
   **cancelled** and the row marked `cancelled_at`; the next tick re-makes it
   from the board. An item already `Published`, or whose slot has passed, is
   left alone.
2. **Attach covers** (§4.6): up to five Queued video items with no Cover
   tile get `cover_<Ep>.png` from Drive attached to the file column (cleared
   first — Monday appends). A Queued video with no cover in Drive at all has
   Cover status set to *No cover yet*.
3. **Missed slots**: a Queued item with no post ids whose slot passed in the
   last seven days raises `publish.slot_missed` and `Factory → Needs you`.
   Nothing is back-posted. Move the Date forward and it goes then.
4. **Hand off one episode** (`PUBLISH.episodesPerTick`): the earliest Queued
   item whose slot is in the future and within six days (Zernio temp media
   lives seven). Skipped with `Factory → Queued in Zernio` if the board
   already carries post ids. The gate is **Cover status = Approved** (video
   items) **and every file in Drive** — `MU_<Ep>_FINAL_916.mp4`, `_tt.mp4`,
   `_tt_tail.mp4` + `.json`, `cover_<Ep>.png`, `cover_<Ep>.jpg` (the
   finisher's, which must exist before the Short publishes); the text lane
   needs `cover_fb_<Ep>.png`. Short of the gate → `Factory → Needs files`,
   `publish.needs_files:<Ep>`, and a `/status` line naming what is missing.
   Through it: each file is uploaded to Zernio once (reused by every leg;
   redone after six days), then one `createScheduledPost` per leg — TikTok
   (tail variant, `video_cover_timestamp_ms` from the sidecar), Instagram
   (FINAL + IG cover as thumbnail), YouTube (FINAL, title capped at 100,
   `containsSyntheticMedia`), Facebook reel (HEAD bake, disclosure line),
   IG + FB stories (IG cover, +10 min); a Text item is one Facebook post
   with `cover_fb` and the disclosure line. Every post carries
   `metadata {episode, kind, source: "mu-factory"}` so the webhook resolves
   it. Each success writes the platform's post-id column on the board and a
   `platform_posts` row (`source: executor`, `slot_at`, `copy_hash`,
   `handed_off_at`). A leg failing three times → `wait-for-human`,
   `publish.handoff_failed:<Ep>:<platform>/<kind>`, `Factory → Needs you`.
   All legs scheduled → `Factory → Queued in Zernio` and `publish.blocked` /
   `publish.needs_files` resolved.

Copy is the board's: YT title / YT description / TikTok caption / IG-FB
caption columns of the item; the reel reuses the IG-FB caption and YT title;
stories carry the episode's question. The disclosure line is appended to
every Facebook post idempotently and never typed into the board.

### `GET /api/health` — cron hourly, `maxDuration 120`

Required env present · Supabase reachable (counts `episodes`) · **Drive root
reachable by id and visible to the service account** (a rebuilt or unshared
root says so in words — the 2026-10-03 failure mode), then `Covers/yt`,
`Covers`, `Finals` resolvable · YouTube `channels.list(mine)` (raises /
resolves `youtube.disconnected`) · Monday `checkBoard(Publishing)` including
the `Factory` column · **board reflection backfill** (every `done` finish row
whose item does not yet read *YT finished*) · **pre-flight** (Queued, due
within 24 h, no post ids → `publish.blocked:<Ep>` + `Factory → Needs files`)
· `youtube.sweep` or `publish.tick` silent > 45 min after it has ever run → `cron.dead:<route>`
· housekeeping (prune `events` and `webhook_events` older than 60 days).
Heartbeat `health`.

### `/status` (session) and `/login`

Config lines (red/green, including whether a Studio session is stored and
when it was exported and last refreshed) · YouTube connection with **Connect
Google** · heartbeats · open alerts · the `youtube_finish` table (ep, video,
state, attempts, language/caption/thumbnail set + verified flags, distance,
Shorts-grid set + verified flags and distance, last error) · retry policy ·
**Publishing queue** (every Queued item in the next 14 days: slot, Factory,
cover status, board post ids, executor legs) · last 10 webhooks · last 50
events · **Run sweep now**, **Run grid pass**, **Run publish tick**,
**Publish dry run** and **Run health check** buttons that POST to the same
routes the crons call.
`/` redirects to `/status`.

The State column says **`done` only when both slots are verified.** A row
the sweep has finished whose grid card has not been read back shows
`grid pending`; one that has used its three grid attempts shows
`grid: wait-for-human` in red, even though its `state` column reads `done`.

### Alerts

Monday `create_notification` to the token owner, `target_type: Project`,
`target_id` = the episode's Publishing item when known, else
`MONDAY_ALERT_ITEM_ID`. One notification per condition, repeated no more
often than every 24 h while it persists, one ✅ on resolve. Conditions:
`youtube.disconnected`, `youtube.unknown_episode:<video>`,
`youtube.finish_stuck:<Ep>`, `youtube.verify_failed:<Ep>`,
`youtube.cover_too_large:<Ep>`, `youtube.grid_stuck:<Ep>`,
`studio.session_expired`, `zernio.post_failed:<post>`,
`publish.blocked:<Ep>` (Text items: `<Ep>-text`), `publish.needs_files:<Ep>`,
`publish.slot_missed:<Ep>`, `publish.handoff_failed:<Ep>:<platform>/<kind>`,
`monday.write_failed:<Ep>`, `cron.dead:youtube.sweep`, `cron.dead:publish.tick`,
`config.invalid:<probe>`.

### Scripts (Christopher's, one-time, `npx tsx`)

| Script | What it does |
|---|---|
| `scripts/import-publish-queue.ts <csv> [--youtube-done-through YYYY-MM-DD]` | Imports `Publish-Queue.csv` → `episodes` + one `platform_posts` row per non-empty post id (`source: import`; `kind: text` for `facebook_text_post_id`). The flag marks YouTube finish rows with `post_date ≤ date` as `done` (finished by hand). |
| `scripts/check-drive.ts` | Service account, root, `Covers/yt`, and what is in it. Read-only. |
| `scripts/check-youtube.ts [videoId]` | Stored token, live channel probe, and (optionally) one video's snippet + caption tracks. Read-only. |
| `scripts/backfill-covers.ts` | Mirrors every `cover_<Ep>.jpg` from Drive into storage + `media`, verified. |
| `scripts/check-studio.ts` | Opens Studio under the stored session and says whether it is still signed in. Writes nothing back. |

## Not built

TikTok/IG/Facebook finishing, the webhook-driven Published flip and analytics
— Phases 4–5 of spec 16. No video is ever processed here: the executor moves
bytes from Drive to Zernio untouched. Signing in to Studio: the session is exported once from a
browser a human signed in with (`studio_bot.mjs` on the Mac); this app only
uses and refreshes it.
