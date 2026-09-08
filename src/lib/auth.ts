import { createHmac, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";

/**
 * One password, one cookie.
 *
 * DELIBERATELY THE SMALLEST THING THAT WORKS. Copied from photo-publisher
 * (2026-09-08). One operator reads `/status`; there are no accounts, no roles,
 * and nothing worth building a real identity system around. If a second reader
 * ever appears, that is the moment to reach for Supabase Auth like the PXLPOD
 * apps do, not before.
 *
 * The cookie value is an HMAC of a fixed message under the password — never
 * the password itself — so a leaked cookie does not hand over the secret that
 * minted it.
 */

const COOKIE_NAME = "mu_session";
/** Domain separation, so the cookie value is not the password in another form. */
const TOKEN_MESSAGE = "mu-factory/status/v1";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function expectedToken(): string | null {
  const password = process.env.APP_PASSWORD;
  if (!password) return null;
  return createHmac("sha256", password).update(TOKEN_MESSAGE).digest("hex");
}

export async function isSignedIn(): Promise<boolean> {
  const expected = expectedToken();
  // No password configured means no way in. Failing closed is right here: the
  // alternative is a status page that is public whenever an env var is missing.
  if (!expected) return false;

  const cookie = (await cookies()).get(COOKIE_NAME)?.value;
  if (!cookie) return false;

  return safeEqual(cookie, expected);
}

/** Returns false on a wrong password; sets the cookie on a right one. */
export async function signIn(password: string): Promise<boolean> {
  const configured = process.env.APP_PASSWORD;
  const expected = expectedToken();
  if (!configured || !expected) return false;

  if (!safeEqual(password, configured)) return false;

  (await cookies()).set(COOKIE_NAME, expected, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return true;
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(COOKIE_NAME);
}

/**
 * Constant-time compare that does not leak length.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * timing signal, so both sides are hashed to a fixed width first.
 */
function safeEqual(a: string, b: string): boolean {
  const left = createHmac("sha256", TOKEN_MESSAGE).update(a).digest();
  const right = createHmac("sha256", TOKEN_MESSAGE).update(b).digest();
  return timingSafeEqual(left, right);
}
