import { NextResponse, type NextRequest } from "next/server";

import { logEvent } from "@/lib/events";
import { completeConnect } from "@/lib/google/auth";

/**
 * Step two: Google sends the operator back here with a code and the state.
 *
 * NOT SESSION-GATED, and it cannot be: this is a redirect from
 * accounts.google.com, and requiring the app's own cookie would break the
 * flow on any browser that drops a cross-site cookie. What protects it is the
 * parked `state` — the exchange only proceeds against a value this app stored
 * minutes ago during an authenticated Connect, consumed on first use.
 *
 * Registered in Google Cloud as `${APP_URL}/google/callback`, byte for byte.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const status = new URL("/status", request.url);

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const denied = request.nextUrl.searchParams.get("error");

  if (denied) {
    status.searchParams.set("google_error", `Google returned "${denied}". Press Connect Google again.`);
    return NextResponse.redirect(status);
  }

  if (!code || !state) {
    status.searchParams.set(
      "google_error",
      "Google returned no code or state. Press Connect Google again.",
    );
    return NextResponse.redirect(status);
  }

  try {
    const result = await completeConnect({ code, state });
    await logEvent(null, {
      level: "info",
      area: "auth",
      message: `Google connected: ${result.channelTitle ?? "(unknown channel)"} (${result.channelId ?? "?"}).`,
    });
    status.searchParams.set("google_connected", result.channelTitle ?? "connected");
    return NextResponse.redirect(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logEvent(null, {
      level: "error",
      area: "auth",
      message: `Google connect failed: ${message}`,
    });
    status.searchParams.set("google_error", message.slice(0, 300));
    return NextResponse.redirect(status);
  }
}
