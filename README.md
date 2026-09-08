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
   cover. A 200 from `thumbnails.set` proves nothing and marks nothing.
4. **Monday, not Slack.** Alerts are Monday notifications aimed at the
   episode's Publishing item. There is no Slack in this repository.
5. **Pausha never runs a script.** Anything she would need to do is a Monday
   gesture or nothing. Scripts are Christopher's one-time tools.
6. **Every failure gets a `/status` line or a Monday notification.**
   `console.*` is not a surface.

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
src/lib/supabase.ts            the one service-role client, pinned to schema `mu`
src/lib/auth.ts                APP_PASSWORD → HMAC cookie `mu_session`
src/lib/events.ts              logEvent — the only writer to `events`
src/lib/heartbeat.ts           beat / deadRoutes
src/lib/alerts.ts              raiseAlert / resolveAlert, 24 h cooldown, Monday notifications
src/lib/attempts.ts            retry policy for finish / verify / cover, in one table
src/lib/monday.ts              gql, paginated items_page, notify, checkBoard
src/lib/drive.ts               service-account Drive, folder paths by name, read-only
src/lib/google/auth.ts         the ONLY OAuth2 builder; consent URL, code exchange, token rotation
src/lib/google/credentials.ts  `mu.credentials` rows for `youtube` and `google:state`
src/lib/youtube/client.ts      videos.list/update, captions.list/insert, thumbnails.set, channel probe
src/lib/youtube/finish.ts      the sweep: poll → finish → verify
src/lib/resolve-status.ts      the ONLY code that changes `youtube_finish.state`
src/lib/media.ts               cover mirror Drive → storage, sha256 read-back, 2 MB refusal
src/lib/dhash.ts               64-bit dHash + Hamming, in memory only
src/lib/zernio/client.ts       fetch wrapper, list/get posts (profile-scoped), URL finder
src/lib/zernio/posts.ts        applyPost — one path for webhook and poll; episode resolution
src/lib/zernio/events.ts       what happens to a delivery after 200
src/lib/health.ts              hourly probes, cron-dead, housekeeping
src/lib/config-check.ts        the red/green lines on /status; requiredEnv()
src/app/status                 the only page
src/app/google/{connect,callback}   the OAuth dance (non-/api)
src/app/api/{youtube/sweep,health,webhooks/zernio}
supabase/migrations/           `<UTC timestamp>_<name>.sql` + README.md
scripts/                       import-publish-queue, check-drive, check-youtube, backfill-covers
```

## Supabase

Project `mindless-mu` (ref `bfvrekckhuifncagccqx`), schema **`mu`**, bucket
**`mu-media`**. Nothing here touches `public`.

Apply `supabase/migrations/20260908150000_initial_schema.sql` in the SQL
editor — [the migrations README](supabase/migrations/README.md) walks through
it. It is idempotent.

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
- Upsert one `platform_posts` row per platform leg (`source: webhook`).
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
     `wait-for-human`.
   - c. `snippet.defaultLanguage !== "en"` → `videos.update` with the
     existing title/categoryId/description/tags + `defaultLanguage: "en"`.
   - d. `captions.list` — a non-`asr` `en` track already there → record it;
     else `captions.insert` (`{videoId, language: "en", name: "English",
     isDraft: false}`, `application/x-subrip`, the one-cue U+2800 SRT).
   - e. `thumbnails.set` with the cover's bytes.
   - f. state → `verify-pending`, attempts reset.
   Three failed attempts → `wait-for-human` + alert `youtube.finish_stuck:<Ep>`.
3. **Verify** `verify-pending` rows: `captions.list` must show the standard
   `en` track; the thumbnail YouTube serves (`snippet.thumbnails.maxres`, then
   `high`) is downloaded, letterbox-trimmed, dHashed (9×8 greyscale) and
   compared with the cover — Hamming ≤ 14 passes. Both → `done`, alerts for
   that episode resolved. Not yet → wait 15 min. Eight looks → `wait-for-human`
   + alert `youtube.verify_failed:<Ep>` carrying the distance.
4. Heartbeat `youtube.sweep`; every outcome is an `events` row; returns
   `{polled, finished, verified, waiting, errors}`.

### `GET /api/health` — cron hourly, `maxDuration 120`

Required env present · Supabase reachable (counts `episodes`) · Drive root +
`Covers/yt` resolvable · YouTube `channels.list(mine)` (raises / resolves
`youtube.disconnected`) · Monday `checkBoard(Publishing)` · `youtube.sweep`
silent > 45 min after it has ever run → `cron.dead:youtube.sweep` ·
housekeeping (prune `events` and `webhook_events` older than 60 days).
Heartbeat `health`.

### `/status` (session) and `/login`

Config lines (red/green) · YouTube connection with **Connect Google** ·
heartbeats · open alerts · the `youtube_finish` table (ep, video, state,
attempts, language/caption/thumbnail set + verified flags, distance, last
error) · retry policy · last 10 webhooks · last 50 events · **Run sweep now**
and **Run health check** buttons that POST to the same routes the crons call.
`/` redirects to `/status`.

### Alerts

Monday `create_notification` to the token owner, `target_type: Project`,
`target_id` = the episode's Publishing item when known, else
`MONDAY_ALERT_ITEM_ID`. One notification per condition, repeated no more
often than every 24 h while it persists, one ✅ on resolve. Conditions:
`youtube.disconnected`, `youtube.unknown_episode:<video>`,
`youtube.finish_stuck:<Ep>`, `youtube.verify_failed:<Ep>`,
`youtube.cover_too_large:<Ep>`, `zernio.post_failed:<post>`,
`cron.dead:youtube.sweep`, `config.invalid:<probe>`.

### Scripts (Christopher's, one-time, `npx tsx`)

| Script | What it does |
|---|---|
| `scripts/import-publish-queue.ts <csv> [--youtube-done-through YYYY-MM-DD]` | Imports `Publish-Queue.csv` → `episodes` + one `platform_posts` row per non-empty post id (`source: import`; `kind: text` for `facebook_text_post_id`). The flag marks YouTube finish rows with `post_date ≤ date` as `done` (finished by hand). |
| `scripts/check-drive.ts` | Service account, root, `Covers/yt`, and what is in it. Read-only. |
| `scripts/check-youtube.ts [videoId]` | Stored token, live channel probe, and (optionally) one video's snippet + caption tracks. Read-only. |
| `scripts/backfill-covers.ts` | Mirrors every `cover_<Ep>.jpg` from Drive into storage + `media`, verified. |

## Not built

Publishing, TikTok/IG/Facebook finishing, Monday column writes, analytics.
Phase 1 reads Monday and never writes a column. No video is ever uploaded or
processed here.
