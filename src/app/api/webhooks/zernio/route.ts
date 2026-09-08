import { createHmac, timingSafeEqual } from "node:crypto";

import { after, NextResponse, type NextRequest } from "next/server";

import { createServiceClient } from "@/lib/supabase";
import { handleZernioEvent } from "@/lib/zernio/events";

/**
 * Zernio's webhook receiver — how a published Short reaches the finisher.
 *
 * THREE THINGS IN A FIXED ORDER, and the order is the design (copied from
 * photo-publisher, 2026-09-08):
 *
 * 1. Verify the signature against the RAW body, before parsing anything. A
 *    payload that has been through `JSON.parse` and back is not the bytes that
 *    were signed, and verifying a re-serialised body is a check that passes
 *    when it should fail.
 * 2. Record the delivery and answer 2xx. Zernio treats anything slower than
 *    five seconds as a failure and retries up to seven times before giving up,
 *    so the work cannot happen before the response.
 * 3. Do the work afterwards, in `after()`.
 *
 * Replays are expected rather than exceptional — seven retries of a delivery
 * that timed out are seven copies of the same event — so the unique event id
 * is what makes the second one a no-op instead of a second write.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The response is immediate; `after()` needs room for Drive + Monday calls. */
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const secret = process.env.ZERNIO_WEBHOOK_SECRET;
  if (!secret) {
    // Refuse rather than accept unverified writes.
    return NextResponse.json(
      { error: "ZERNIO_WEBHOOK_SECRET is not set" },
      { status: 503 },
    );
  }

  const raw = await request.text();
  const signature =
    request.headers.get("x-zernio-signature") ??
    request.headers.get("x-late-signature");

  if (!signature || !verify(raw, signature, secret)) {
    /**
     * A REJECTED DELIVERY IS STILL EVIDENCE: with nothing recorded, an empty
     * webhook log cannot distinguish "Zernio never sent anything" from
     * "everything it sent was refused" — opposite problems with opposite
     * fixes. Bounded on purpose: no payload is stored (the request is
     * unauthenticated), and the event id is a per-minute bucket so a flood
     * collapses to one row a minute.
     */
    await recordRejection(
      signature ? "signature did not match" : "no signature header",
    );
    return NextResponse.json({ error: "Bad signature" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Unparseable body" }, { status: 400 });
  }

  const eventId =
    asString(payload.id) ??
    request.headers.get("x-zernio-event-id") ??
    request.headers.get("x-late-event-id");

  if (!eventId) {
    return NextResponse.json({ error: "No event id" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Stored verbatim, matched in lowercase downstream. The wire values are
  // lowercase already (photo-publisher confirmed 2026-09-07); the lowercasing
  // in the handler is cheap insurance against the silent kind of failure.
  const event = asString(payload.event) ?? "unknown";

  // Insert first. A conflict means this exact delivery has been seen, which is
  // the whole dedupe: nothing else runs and Zernio gets its 2xx.
  const { error: insertError } = await supabase.from("webhook_events").insert({
    provider: "zernio",
    event_id: eventId,
    event,
    payload: payload as never,
  });

  if (insertError) {
    const duplicate = insertError.code === "23505";
    return NextResponse.json(
      { ok: true, duplicate, event },
      { status: duplicate ? 200 : 500 },
    );
  }

  // Answer now, work after. Returning the promise keeps the invocation alive
  // until it settles without holding up the response.
  after(handleZernioEvent(supabase, eventId, event, payload));

  return NextResponse.json({ ok: true, event });
}

/**
 * HMAC-SHA256 of the raw body, lowercase hex, optional `sha256=` prefix.
 *
 * Compared through `timingSafeEqual` on equal-length buffers — a plain string
 * comparison leaks how much of a forged signature was correct, one character
 * at a time.
 */
function verify(raw: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const given = signature.trim().replace(/^sha256=/i, "").toLowerCase();

  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

async function recordRejection(reason: string): Promise<void> {
  try {
    const minute = new Date().toISOString().slice(0, 16);
    await createServiceClient()
      .from("webhook_events")
      .insert({
        provider: "zernio",
        event_id: `rejected:${minute}`,
        event: "rejected",
        error: reason,
        processed_at: new Date().toISOString(),
      });
  } catch {
    // A duplicate for this minute, or an unreachable database. Either way the
    // rejection itself is what matters and it has already been returned.
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
