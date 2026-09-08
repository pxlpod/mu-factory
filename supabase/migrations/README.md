# Migrations — what they do and how to run them

**Status: not yet applied.** The `mindless-mu` Supabase project (ref `bfvrekckhuifncagccqx`) is new, and the first file below has to be run once by hand before the app can do anything. This page walks through it. Nothing here needs a terminal.

| Order | File | What it does |
|---|---|---|
| 1 | `20260908150000_initial_schema.sql` | The `mu` schema, its ten tables, the security lockdown, the private `mu-media` bucket, and the line that lets the app see the schema |

The long number is a UTC timestamp. It is kept in the filename so this folder and the database always agree on what has been applied, and so the Supabase CLI could take over later without renaming anything.

Every file is **safe to run twice**. That is a deliberate design property, not a hope. If you ever lose track of whether one has been applied, run it again — it does nothing the second time and reports success.

---

## How to run one

1. Open **supabase.com** and sign in.
2. Click the **mindless-mu** project on the dashboard home.
3. In the left sidebar, click **SQL Editor**.
4. Click **+ New query**.
5. Open the file from this folder, select all of it, copy, and paste it into the editor.
6. Click **Run** (bottom right, or Cmd+Enter).
7. **Expected result:** a green **"Success. No rows returned"**. That is what success looks like — these create things rather than fetch things, so no rows coming back is correct. You may also see a grey notice line saying `Exposed schema mu to PostgREST` — that is the migration doing step 8 for you.
8. **Then, once, in the dashboard:** Project Settings → API → **Exposed schemas** → add `mu` → Save. The migration sets this too, but the dashboard is the durable place: a later save on that page would drop it, and every query would start failing with `PGRST106`. `/status` turns the Supabase line red with exactly that instruction if it happens.

**If you see a red error:** copy the whole message and send it over. Nothing will be half-broken, because re-running is always safe.

---

## What the first file does

### One small helper function

**`touch_updated_at`** — fills in "when was this last changed" automatically whenever a row is edited, so nothing depends on the app remembering to do it.

### The ten tables

| Table | Holds |
|---|---|
| `credentials` | The Google/YouTube token, and the one-time handshake value used while connecting |
| `webhook_events` | Every delivery Zernio has ever sent us, once each |
| `events` | The log. Everything `/status` shows in its Events section |
| `heartbeats` | When each scheduled job last ran |
| `alerts` | Open and resolved problems, one row per problem |
| `runs` | One row per sweep, and the lock that stops two sweeps overlapping |
| `episodes` | One row per Ep, from the Mac's Publish-Queue.csv |
| `platform_posts` | One row per post per platform (TikTok, Instagram, YouTube, Facebook) |
| `youtube_finish` | The YouTube finisher's to-do list: which videos still need a thumbnail and caption track, and what has been verified |
| `media` | Covers copied from Google Drive into Supabase storage, with a checksum |

Three details are doing real work:

- **`youtube_finish.state` can only hold five words** — `pending`, `verify-pending`, `done`, `wait-for-human`, `skipped` — and **`done` is refused by the database unless both the thumbnail and the caption have a verified timestamp.** A bug in the app cannot mark a video finished that was never checked.
- **`webhook_events` refuses a second copy of the same delivery.** Zernio retries webhooks up to seven times when it does not hear back fast enough; the duplicate is turned away at the database and nothing happens twice.
- **`platform_posts` has one row per (platform, Zernio post).** Whether the app hears about a post from the webhook or from its own fifteen-minute poll, both land on the same row.

### The storage bucket

`mu-media`, private. YouTube thumbnails (`cover_<Ep>.jpg`) are copied here from Drive so the app has its own verified copy to send and to compare against. Nothing is ever served publicly from it.

### The security lockdown

Row Level Security is switched on for every table, and **no permissions are granted to anyone** except the server's own secret key.

That sounds like a mistake. It is the point. If the project's public key ever leaked — in a screenshot, in browser code, in a stray commit — whoever had it could read **nothing**. Not one row, and certainly not the YouTube token.

Everything the app does goes through the server instead, using the service-role key that never reaches a browser, and only behind the `/status` password or the cron secret.

Supabase's security scanner reports one notice per table saying "RLS enabled but no policies exist." **Those are expected and correct** — it is describing the design, not finding a fault. Do not add policies to silence them.

### Exposing the schema

The app keeps everything in a schema called `mu` rather than in `public`. Supabase's API only serves schemas it has been told about, so the last block of the file adds `mu` to that list. Step 8 above makes the same change in the dashboard so it survives future edits there.

---

## Connecting the app

Two values from **Project Settings → API** go into the app's environment on Vercel (`.env.example` lists every variable): the project URL and the **service role** key.

The **service role key is the powerful one** — it bypasses every security control described above. It belongs in the server-side environment only, never anywhere a browser could reach it.
