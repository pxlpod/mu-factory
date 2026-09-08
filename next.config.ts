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
   * cold start. Shape copied from photo-publisher (2026-09-08); nothing is read
   * from disk at run time here, so there is no `outputFileTracingIncludes`.
   */
  serverExternalPackages: ["sharp", "googleapis"],
};

export default nextConfig;
