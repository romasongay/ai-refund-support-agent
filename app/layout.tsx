import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { NavLinks } from "@/components/nav-links";
import { EnvBanner } from "@/components/env-banner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "AI Refund Support Agent",
  description:
    "AI customer-support agent that approves or denies e-commerce refunds against a strict policy — over text and live voice.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <header className="sticky top-0 z-20 border-b border-zinc-200/70 bg-white/80 backdrop-blur dark:border-zinc-800/70 dark:bg-zinc-900/80">
          <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="grid h-7 w-7 place-items-center rounded-lg bg-indigo-600 text-sm font-bold text-white"
              >
                R
              </span>
              <span className="font-semibold tracking-tight">Refund Support</span>
              <span className="hidden rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 sm:inline dark:bg-zinc-800 dark:text-zinc-400">
                AI agent
              </span>
            </div>
            <NavLinks />
          </div>
        </header>
        <EnvBanner />
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
