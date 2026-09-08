import { createClient } from "@supabase/supabase-js";

import { MEDIA_BUCKET, MU_SCHEMA } from "@/config/factory";

/**
 * The one Supabase client this app uses.
 *
 * PINNED TO THE `mu` SCHEMA. Copied from photo-publisher with the schema name
 * changed, and the reasoning survives the move: setting the default schema
 * here means a forgotten prefix in a query lands on a non-existent
 * `mu.<something>` and errors, rather than silently creating or reading a
 * table in `public`. The project (`mindless-mu`) is ours alone today; the pin
 * is what keeps that true if it is ever shared.
 *
 * SERVICE ROLE ONLY, SERVER ONLY. Nothing in the browser bundle talks to
 * Supabase, so there is no anon client and no NEXT_PUBLIC_ URL. If browser
 * code ever appears to need one, that code is bypassing the server-route
 * boundary.
 */
export function createServiceClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    // Fail at the call site. A client built from undefined env vars 401s on
    // every query instead, which in a serverless log reads like a permissions
    // problem on the database.
    throw new Error(
      "Supabase is not configured: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY " +
        "must both be set.",
    );
  }

  return createClient(url, serviceKey, {
    db: { schema: MU_SCHEMA },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * The client type, exported so callers do not have to spell out the schema
 * generic. `SupabaseClient` on its own defaults to `public`, which is exactly
 * the schema nothing in this app is allowed to touch.
 */
export type MuClient = ReturnType<typeof createServiceClient>;

export { MEDIA_BUCKET };
