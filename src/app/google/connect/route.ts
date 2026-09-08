import { NextResponse, type NextRequest } from "next/server";

import { isSignedIn } from "@/lib/auth";
import { logEvent } from "@/lib/events";
import { beginConnect } from "@/lib/google/auth";

/**
 * Step one of the Google connect: park a `state`, send the operator to the
 * consent screen.
 *
 * BEHIND THE STATUS-PAGE SESSION. Anyone who could hit this could start an
 * OAuth flow that ends with a token in the database — the callback is
 * necessarily open (Google redirects to it), so this side is where the gate
 * has to be. Mirrors photo-publisher's `/flickr/connect` (2026-09-08).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  if (!(await isSignedIn())) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  try {
    const url = await beginConnect();
    return NextResponse.redirect(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logEvent(null, {
      level: "error",
      area: "auth",
      message: `Connect Google could not start: ${message}`,
    });
    const target = new URL("/status", request.url);
    target.searchParams.set("google_error", message.slice(0, 300));
    return NextResponse.redirect(target);
  }
}
