# MU Factory — Runbook

Everything Christopher needs to set this up and keep it running, in the order
he'll need it. Nothing here requires a terminal except the two import scripts
at step 9, which run once.

Pausha never touches any of this. Her whole interface is Monday: a
notification arrives on the episode's item when something needs a person, and
a ✅ arrives when it clears.

---

## One-time setup, in order

### 1. Supabase — the database

1. Open supabase.com → project **mindless-mu**.
2. **SQL Editor → + New query.** Paste the whole of
   `supabase/migrations/20260908150000_initial_schema.sql` and **Run**. Expect
   "Success. No rows returned". Running it twice is harmless.
3. **Project Settings → API → Exposed schemas** → add `mu` → Save. The
   migration does this too, but the dashboard is what survives future edits.
4. Note two values from the same API page for step 6: the **Project URL** and
   the **service_role** key.

The plain-language walkthrough is `supabase/migrations/README.md`.

### 2. Google Cloud — the YouTube side

1. console.cloud.google.com → create a project (or use an existing PXLPOD
   one) → note it.
2. **APIs & Services → Library** → enable **YouTube Data API v3** and
   **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → User type **External** →
   fill in the app name (`MU Factory`) and your email → add the scope
   `https://www.googleapis.com/auth/youtube.force-ssl` → save.
4. **Publish the app.** On the consent screen page, press **Publish App**.
   This matters more than it looks: an app left in **Testing** issues refresh
   tokens that expire after **7 days**, and the finisher would silently stop
   every week. Published is the fix; Google may show an "unverified app"
   warning on the consent page, which is fine for a single-user internal
   tool — click through it.
5. **Credentials → Create credentials → OAuth client ID** → type **Web
   application** → name `mu-factory` → **Authorised redirect URIs**: add
   exactly `https://<your app host>/google/callback` (the same value as
   `APP_URL` + `/google/callback`; no trailing slash on `APP_URL`). Note the
   **Client ID** and **Client secret**.

### 3. Google service account — the Drive side

1. **Credentials → Create credentials → Service account** → name
   `mu-factory-drive` → create → **Keys → Add key → JSON** → a file downloads.
2. Turn the file into one line for Vercel:
   `base64 -i ~/Downloads/<that file>.json | pbcopy` (this is the one
   terminal line; it produces the value for `GOOGLE_SERVICE_ACCOUNT_JSON`).
3. In Google Drive, open the **MU root folder** (the one containing `Covers`
   and `Finals`) → **Share** → paste the service account's email address (it
   ends in `.iam.gserviceaccount.com`) → **Viewer** is enough for Phase 1.
4. Copy the root folder's id from its URL (the long string after `/folders/`)
   for `DRIVE_ROOT_FOLDER_ID`.

### 4. Monday — the alert target

1. On the **Publishing** board, create one item called **MU Factory alerts**.
   Any alert that has no episode to attach to lands here.
2. Open it and copy the number at the end of the URL
   (`…/pulses/<number>`) for `MONDAY_ALERT_ITEM_ID`.
3. Your personal API token: avatar (bottom left) → **Developer → My access
   tokens → Show** → `MONDAY_API_TOKEN`. Notifications will be sent to
   whoever owns this token.

### 5. Zernio — the API key

Zernio dashboard → **Settings → API** → create or copy a key →
`ZERNIO_API_KEY`. The webhook secret comes in step 8.

### 6. Vercel — the deployment

1. vercel.com, team **PXLPOD Web** → **Add New → Project** → import the
   `mu-factory` GitHub repository. Framework is detected as Next.js; keep
   the defaults.
2. **Environment Variables**: add every name from `.env.example`. Where each
   value comes from is in the README's Environment table. Two you invent:
   `CRON_SECRET` (any long random string) and `APP_PASSWORD` (the `/status`
   password). `APP_URL` is the production URL Vercel will give you — set it
   after the first deploy if you don't know it yet, then redeploy.
3. Deploy. From now on every push to `main` deploys.
4. **Do not** add a `functions.memory` block to `vercel.json` — the project
   is on Active CPU billing, where Vercel ignores it. Memory is set under the
   project's Function settings in the dashboard if it is ever needed.

### 7. First visit to `/status`

Open `https://<your app host>/status`, sign in with `APP_PASSWORD`. Every
line in **Configuration** should be green except **YouTube**. Red lines say
exactly what is missing.

### 8. Zernio — the webhook

1. Zernio dashboard → **Settings → Webhooks** (or Developers → Webhooks) →
   **Add endpoint**.
2. URL: `https://<your app host>/api/webhooks/zernio`.
3. Events: `post.platform.published`, `post.published`, `post.failed`,
   `post.platform.failed`, `post.tiktok.url_resolved`.
4. Save; Zernio shows a **signing secret**. Put it in Vercel as
   `ZERNIO_WEBHOOK_SECRET` and redeploy.
5. Send a test event from Zernio. On `/status` → **Webhooks**, it appears as
   received and processed. If it says "Delivery refused", the secret does not
   match.

### 9. Connect Google

On `/status` → **YouTube connection** → **Connect Google**. Sign in as the
Google account that owns **@mindless_mu**, accept the YouTube permission. You
land back on `/status` with "Google connected: Mu the Mindless Rabbit" (or
whatever the channel is called). The YouTube line turns green.

If Google says "no refresh token", remove the app at
myaccount.google.com/permissions and press Connect Google again.

### 10. Import the existing queue (one time, terminal)

From a checkout of the repo with a `.env.local` holding the same variables
as Vercel:

```
npm install
npx tsx scripts/check-drive.ts
npx tsx scripts/import-publish-queue.ts ~/path/to/Publish-Queue.csv --youtube-done-through 2026-09-07
npx tsx scripts/backfill-covers.ts
```

Use for `--youtube-done-through` the post date of the last video whose
thumbnail and captions were done by hand in YouTube Studio. Everything on or
before it is marked done and never touched; everything after it is queued.
Re-running the import is safe.

Then press **Run sweep now** on `/status` and watch the Events section.

---

## How to read `/status`

| Section | What it tells you |
|---|---|
| **Needs you** | Open alerts. Each also went to Monday as a notification. Gone when resolved. |
| **Configuration** | One line per dependency, green or red. A red line names the fix. |
| **YouTube connection** | Which channel is connected and since when. Reconnect here. |
| **Cron heartbeats** | When `youtube.sweep` and `health` last ran. Sweep is every 15 min, health hourly. Silent for 45 min → an alert. |
| **YouTube finishes** | One row per YouTube post. `pending` → `verify-pending` → `done`. `wait-for-human` means read **Last error**. ✓ marks show what is set and what is verified. |
| **Webhooks** | The last 10 deliveries from Zernio. "not MU" in grey is a client-profile delivery, correctly ignored. |
| **Events** | The last 50 things that happened, newest first. Red = error. |

**Run sweep now** and **Run health check** call the same code the crons call,
so pressing them proves the crons.

---

## Alerts, and what to do about each

Each arrives once as a Monday notification, is repeated no more than once a
day while it persists, and is followed by a ✅ when it clears. Episode alerts
land on that episode's Publishing item; the rest land on **MU Factory alerts**.

| Alert | What it means | What to do |
|---|---|---|
| `youtube.disconnected` | Google no longer accepts the refresh token | `/status` → **Reconnect Google**. Check the consent screen is **Published**, not Testing. |
| `youtube.cover_too_large:<Ep>` | `cover_<Ep>.jpg` is over YouTube's 2 MB cap | Ask Pausha for a smaller export into `Covers/yt` (same filename). The next sweep picks it up; then set the row's state back to `pending`. |
| `youtube.unknown_episode:<video>` | A Short published with no episode attached | Find the Ep, set it on the `platform_posts` and `youtube_finish` rows, set state to `pending`. Future posts should carry `metadata.episode`. |
| `youtube.finish_stuck:<Ep>` | Three attempts failed at YouTube | Read **Last error**. Fix the cause, set state back to `pending`. |
| `youtube.verify_failed:<Ep>` | The read-back never matched after two hours | Open the video in YouTube Studio. If the thumbnail and captions look right, set the row to `done` (with both verified timestamps); if not, set it to `pending`. |
| `zernio.post_failed:<post>` | Zernio could not publish | Open the post in Zernio; the reason is there. |
| `cron.dead:youtube.sweep` | No sweep for 45 minutes | Vercel → the project → **Cron Jobs**. Redeploy if they are missing. |
| `config.invalid:<probe>` | A dependency check failed | `/status` — the red line names it. |

A cover that simply is not in Drive yet is **not** an alert. The row waits,
looks again every hour, and says so in Events.

---

## Where the knobs are

All in `src/config/`, all in git, all changed by asking Claude Code:

- `youtube.ts` — per-run cap, attempt counts, verify interval, dHash threshold, the blank SRT
- `zernio.ts` — profile and account ids, poll window, list page size
- `monday.ts` — board and column ids, API version
- `alerts.ts` — cooldown, cron-dead window, retention
- `factory.ts` — filenames, Drive folder paths, run lock

---

## What never happens automatically

- No video is uploaded, edited, re-encoded or deleted. Ever.
- No cover is re-encoded. Over 2 MB stops and asks.
- Nothing is marked `done` because a call returned 200. Only a read-back does that.
- No Monday column is written in Phase 1. Notifications only.
- Nothing reads any Zernio profile other than `Default`.
- Nothing asks Pausha to run anything.
