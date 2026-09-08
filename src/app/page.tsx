import { redirect } from "next/navigation";

/** The status page is the only page. */
export default function Home() {
  redirect("/status");
}
