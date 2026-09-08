import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "MU Factory",
  description: "Publishing automation for Mu the Mindless Rabbit.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
