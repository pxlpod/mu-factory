import serverlessChromium from "@sparticuz/chromium";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import { STUDIO } from "@/config/youtube";
import { createServiceClient, type MuClient } from "@/lib/supabase";

/**
 * YouTube Studio, driven in a headless browser — the session, the browser,
 * and nothing about what to do once inside. That is `youtube/grid.ts`.
 *
 * WHY A BROWSER AT ALL. The Shorts-grid thumbnail has no API (proven
 * 2026-09-09). The only thing that sets it is Studio's own edit page. Until
 * then a Mac ran a Playwright script by hand per video; this file is what lets
 * the same thing happen on Vercel with no Mac involved.
 *
 * THE SESSION IS A CREDENTIAL and lives where the other one lives:
 * `mu.credentials`, service-role only, never in env, never in a response.
 * Christopher signs in once on his Mac (`studio_bot.mjs login && export`) and
 * the export — Playwright's storageState plus the user agent it was signed in
 * with — is the row. Google rotates session cookies as they are used, so each
 * run writes the refreshed jar back; a jar that is never refreshed expires.
 *
 * HEADLESS IS REFUSED BY STUDIO ("unsupported browser") on the user agent
 * alone, so the exported UA is sent instead of the browser's own. That is the
 * whole of the disguise; nothing else is faked.
 *
 * `@sparticuz/chromium` is the Chromium build that fits a serverless function.
 * It inflates itself into /tmp on first use (a few seconds, once per warm
 * instance). `CHROMIUM_EXECUTABLE_PATH` overrides it for Christopher's local
 * checks; it is not required anywhere and Vercel never sets it.
 */

export class StudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioError";
  }
}

/** Studio sent us to accounts.google.com: the exported session no longer signs in. */
export class StudioSessionExpiredError extends StudioError {
  constructor(readonly landedOn: string) {
    super(
      `YouTube Studio redirected to ${landedOn} — the stored Studio session has ` +
        `expired. Re-run studio_bot.mjs login && export on the Mac to store a fresh one.`,
    );
    this.name = "StudioSessionExpiredError";
  }
}

// ---------------------------------------------------------------------------
// The stored session
// ---------------------------------------------------------------------------

type StorageState = NonNullable<
  Exclude<Parameters<Browser["newContext"]>[0], undefined>["storageState"]
> &
  object;

export interface StudioSession {
  cookies: StorageState["cookies"];
  origins: StorageState["origins"];
  /** The UA the session was signed in with. Sent on every request. */
  user_agent: string | null;
  /** When the Mac exported it. */
  exported_at: string | null;
  /** When a hosted run last wrote the rotated cookies back. */
  refreshed_at: string | null;
}

/** Everything /status is allowed to know about the session. No cookie values. */
export interface StudioSessionSummary {
  cookies: number;
  exported_at: string | null;
  refreshed_at: string | null;
  /** Earliest expiry among cookies that carry one; null when none do. */
  earliest_expiry: string | null;
}

export async function loadStudioSession(supabase?: MuClient): Promise<StudioSession | null> {
  const client = supabase ?? createServiceClient();
  const { data } = await client
    .from("credentials")
    .select("data")
    .eq("provider", STUDIO.credentialKey)
    .maybeSingle();

  const stored = (data as { data?: Partial<StudioSession> } | null)?.data;
  if (!stored || !Array.isArray(stored.cookies) || stored.cookies.length === 0) return null;

  return {
    cookies: stored.cookies,
    origins: Array.isArray(stored.origins) ? stored.origins : [],
    user_agent: stored.user_agent ?? null,
    exported_at: stored.exported_at ?? null,
    refreshed_at: stored.refreshed_at ?? null,
  };
}

export async function saveStudioSession(
  session: StudioSession,
  supabase?: MuClient,
): Promise<void> {
  const client = supabase ?? createServiceClient();
  const { error } = await client
    .from("credentials")
    .upsert({ provider: STUDIO.credentialKey, data: session as never }, { onConflict: "provider" });
  if (error) throw new StudioError(`Studio session could not be saved: ${error.message}`);
}

export async function describeStudioSession(
  supabase?: MuClient,
): Promise<StudioSessionSummary | null> {
  const session = await loadStudioSession(supabase);
  if (!session) return null;

  const expiries = session.cookies
    .map((c) => (typeof c.expires === "number" && c.expires > 0 ? c.expires * 1000 : null))
    .filter((t): t is number => t !== null);

  return {
    cookies: session.cookies.length,
    exported_at: session.exported_at,
    refreshed_at: session.refreshed_at,
    earliest_expiry: expiries.length ? new Date(Math.min(...expiries)).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

export async function launchBrowser(): Promise<Browser> {
  const override = process.env.CHROMIUM_EXECUTABLE_PATH;
  if (override) {
    return chromium.launch({ executablePath: override, headless: true });
  }

  // No WebGL needed to press a button; skipping the graphics stack also skips
  // inflating swiftshader into /tmp.
  serverlessChromium.setGraphicsMode = false;
  const executablePath = await serverlessChromium.executablePath();
  return chromium.launch({
    executablePath,
    args: serverlessChromium.args,
    headless: true,
  });
}

/** The signed-in context: the exported cookies, under the exported user agent. */
export async function openStudioContext(
  browser: Browser,
  session: StudioSession,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    storageState: { cookies: session.cookies, origins: session.origins },
    userAgent: session.user_agent ?? STUDIO.fallbackUserAgent,
    viewport: STUDIO.viewport,
    locale: "en-US",
  });
  context.setDefaultNavigationTimeout(STUDIO.navigationTimeoutMs);
  context.setDefaultTimeout(STUDIO.navigationTimeoutMs);
  return context;
}

/**
 * An anonymous context — no Google cookies at all — for reading the public
 * Shorts grid. Verification has to see what a viewer sees, not what the
 * signed-in owner sees.
 */
export async function openViewerContext(
  browser: Browser,
  session: StudioSession | null,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: session?.user_agent ?? STUDIO.fallbackUserAgent,
    viewport: STUDIO.viewport,
    locale: "en-US",
  });
  await context.addCookies([STUDIO.consentCookie]);
  context.setDefaultNavigationTimeout(STUDIO.navigationTimeoutMs);
  context.setDefaultTimeout(STUDIO.navigationTimeoutMs);
  return context;
}

/** Throws `StudioSessionExpiredError` when the page has landed on the sign-in host. */
export function assertSignedIn(page: Page): void {
  let host = "";
  try {
    host = new URL(page.url()).hostname;
  } catch {
    return;
  }
  if (host === STUDIO.signInHost || host.endsWith(`.${STUDIO.signInHost}`)) {
    throw new StudioSessionExpiredError(host);
  }
}

/**
 * The rotated cookie jar, back into the row. Called only after a run has seen
 * Studio signed in — a signed-out jar must never overwrite a good one.
 */
export async function persistRefreshedSession(
  context: BrowserContext,
  session: StudioSession,
  supabase?: MuClient,
): Promise<void> {
  const state = await context.storageState();
  await saveStudioSession(
    {
      ...session,
      cookies: state.cookies,
      origins: state.origins,
      refreshed_at: new Date().toISOString(),
    },
    supabase,
  );
}
