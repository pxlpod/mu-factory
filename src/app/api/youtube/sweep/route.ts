import { NextResponse, type NextRequest } from "next/server";

import { isSignedIn } from "@/lib/auth";
import { runYoutubeSweep } from "@/lib/youtube/finish";

/**
 * The YouTube sweep endpoint. Vercel Cron every fifteen minutes (GET,
 * CRON_SECRET), and the Run sweep now button on /status (POST, session
 * cookie). Same work either way — one code path, so the button proves the
 * cron.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sized to the per-run cap in config: up to eight videos, each a Drive
 * download, a storage round-trip with read-back, and four YouTube calls; plus
 * up to eight verifications, each a thumbnail download and two hashes.
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
  return NextResponse.json(await runYoutubeSweep());
}

export async function POST(request: NextRequest) {
  // The button carries the session cookie; the cron header is accepted too so
  // a manual trigger from outside the browser needs nothing new.
  if (!authorisedByCron(request) && !(await isSignedIn())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runYoutubeSweep());
}
