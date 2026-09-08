import { NextResponse, type NextRequest } from "next/server";

import { isSignedIn } from "@/lib/auth";
import { runHealthCheck } from "@/lib/health";

/**
 * Hourly probe of every dependency, the cron heartbeat check, and
 * housekeeping. GET is the cron (CRON_SECRET); POST is the status-page button
 * (session cookie). One handler.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function authorisedByCron(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!authorisedByCron(request) && !(await isSignedIn())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runHealthCheck());
}

export async function POST(request: NextRequest) {
  if (!authorisedByCron(request) && !(await isSignedIn())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runHealthCheck());
}
