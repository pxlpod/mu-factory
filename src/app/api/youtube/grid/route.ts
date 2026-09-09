import { NextResponse, type NextRequest } from "next/server";

import { isSignedIn } from "@/lib/auth";
import { runGridPass } from "@/lib/youtube/grid";

/**
 * The Shorts-grid pass. Vercel Cron every fifteen minutes, seven minutes after
 * the sweep (GET, CRON_SECRET), and the Run grid pass button on /status
 * (POST, session cookie). Same work either way.
 *
 * ITS OWN ROUTE rather than a step inside the sweep: it launches a browser,
 * drives YouTube Studio and then polls the public grid for up to two minutes
 * per video, which would eat the sweep's ceiling; and its one systemic
 * failure — an expired Studio session — must not stop captions and classic
 * thumbnails from being finished. The reasoning in full is at the top of
 * `src/lib/youtube/grid.ts`.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Chromium inflating into /tmp (a few seconds, once per warm instance), one
 * Studio page and one upload per row (about 30 s), then up to two minutes of
 * polling the public grid — for at most two rows, stopped early by the run
 * budget in config so it never runs into this ceiling.
 */
export const maxDuration = 300;

function authorisedByCron(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!authorisedByCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runGridPass());
}

export async function POST(request: NextRequest) {
  if (!authorisedByCron(request) && !(await isSignedIn())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runGridPass());
}
