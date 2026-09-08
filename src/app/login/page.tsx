import { redirect } from "next/navigation";

import { isSignedIn } from "@/lib/auth";

import { submitPassword } from "./actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await isSignedIn()) redirect("/status");

  const params = await searchParams;
  const failed = Boolean(params.error);

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <form
        action={submitPassword}
        className="w-full max-w-xs space-y-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-6"
      >
        <h1 className="text-base font-medium">MU Factory</h1>
        <label htmlFor="password" className="block text-[var(--muted)]">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          className="w-full rounded border border-[var(--border)] bg-transparent px-3 py-2 outline-none focus:border-[var(--text)]"
        />
        <button
          type="submit"
          className="w-full rounded bg-[var(--text)] px-3 py-2 text-[var(--bg)]"
        >
          Sign in
        </button>
        {failed ? <p className="text-[var(--bad)]">Wrong password.</p> : null}
      </form>
    </main>
  );
}
