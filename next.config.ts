import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * `sharp` is a native addon. Next already ships it in its built-in external
   * list, but naming it here is cheap insurance: if that default ever changes,
   * bundling sharp fails at run time on Vercel with a `.node` resolution error
   * rather than at build time, and the sweep's verify pass is the only place
   * that would show it — as every thumbnail failing to verify.
   *
   * `googleapis` is externalised because it resolves API surfaces through
   * dynamic requires that a bundler can rewrite into a much larger, slower
   * cold start. Shape copied from photo-publisher (2026-09-08).
   *
   * `playwright-core` and `@sparticuz/chromium` (2026-09-09) drive YouTube
   * Studio for the Shorts-grid thumbnail. Both locate files relative to their
   * own package at run time — Playwright its browser protocol assets, the
   * Chromium package its brotli-packed binary — so neither survives bundling.
   */
  serverExternalPackages: ["sharp", "googleapis", "playwright-core", "@sparticuz/chromium"],

  /**
   * The Chromium binary is read from disk with a computed path, which file
   * tracing cannot follow. Name it for the one route that launches a browser
   * so the deployed function carries it; the sweep and health stay small.
   */
  outputFileTracingIncludes: {
    "/api/youtube/grid": ["./node_modules/@sparticuz/chromium/bin/**"],
  },
};

export default nextConfig;
