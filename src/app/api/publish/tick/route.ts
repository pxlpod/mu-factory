import { NextResponse, type NextRequest } from "next/server";

import { executorMode } from "@/config/publish";
import { isSignedIn } from "@/lib/auth";
import { runPublishTick } from "@/lib/publish/executor";

/**
 * The publish executor's tick. Vercel Cron every ten minutes (GET,
 * CRON_SECRET), and the buttons on /status (POST, session cookie): "Run
 * publish tick" and "Dry run" (`?dry=1`), which plans and touches nothing at Zernio or Monday.
 * Same handler either way.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One episode: up to three video uploads of 100–180 MB plus two images, six posts. */
export const maxDuration = 300;

function authorisedByCron(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

/** Dry unless the mode is live AND the caller did not ask for a dry run. */
function wantsDryRun(request: NextRequest): boolean {
  const dry = request.nextUrl.searchParams.get("dry");
  return executorMode() !== "live" || dry === "1" || dry === "true";
}

export async function GET(request: NextRequest) {
  if (!authorisedByCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runPublishTick({ dryRun: wantsDryRun(request) }));
}

export async function POST(request: NextRequest) {
  if (!authorisedByCron(request) && !(await isSignedIn())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runPublishTick({ dryRun: wantsDryRun(request) }));
}
