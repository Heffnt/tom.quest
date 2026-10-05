import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { AuthProvider } from "./lib/auth";
import AppShell from "./components/app-shell";

// Self-hosted (app/fonts/, latin subset, from the Fontsource packages of the
// Google Fonts files; each family's OFL.txt is its licence) so `next build`
// fetches nothing: next/font/google downloads at build time, and that fetch
// failed CI's build twice on 2026-10-05 with no code change involved.
const syne = localFont({
  variable: "--font-syne",
  src: [
    { path: "./fonts/syne/syne-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "./fonts/syne/syne-latin-700-normal.woff2", weight: "700", style: "normal" },
    { path: "./fonts/syne/syne-latin-800-normal.woff2", weight: "800", style: "normal" },
  ],
});

const ibmPlexSans = localFont({
  variable: "--font-ibm-plex-sans",
  src: [
    { path: "./fonts/ibm-plex-sans/ibm-plex-sans-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans/ibm-plex-sans-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans/ibm-plex-sans-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
});

const ibmPlexMono = localFont({
  variable: "--font-ibm-plex-mono",
  src: [
    { path: "./fonts/ibm-plex-mono/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
});

export const metadata: Metadata = {
  title: "tom.Quest",
  description: "The personal website of Tom Heffernan - PhD Student in Artificial Intelligence at WPI",
  appleWebApp: {
    capable: true,
    title: "tom.Quest",
    statusBarStyle: "black",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // The next/font variable classes sit on <html>, not <body>: globals.css
    // reads --font-ibm-plex-sans and friends at :root, and a variable set
    // only on <body> resolves to nothing there, so text falls back to system sans.
    <html
      lang="en"
      className={`${syne.variable} ${ibmPlexSans.variable} ${ibmPlexMono.variable}`}
      suppressHydrationWarning
    >
      <body className="antialiased" suppressHydrationWarning>
        <AuthProvider>
          <AppShell>{children}</AppShell>
        </AuthProvider>
      </body>
    </html>
  );
}
