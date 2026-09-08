"use server";

import { redirect } from "next/navigation";

import { signIn } from "@/lib/auth";

export async function submitPassword(formData: FormData) {
  const password = String(formData.get("password") ?? "");
  const ok = await signIn(password);
  redirect(ok ? "/status" : "/login?error=1");
}
