import type { Metadata } from "next";
import { Syne, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { AuthProvider } from "./lib/auth";
import Navigation from "./components/navigation";
import DebugDrawer from "./components/debug-drawer";

const syne = Syne({
  variable: "--font-syne",
  subsets: ["latin"],
  weight: ["600", "700", "800"],
});

const ibmPlexSans = IBM_Plex_Sans({
  variable: "--font-ibm-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: "--font-ibm-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "tom.Quest",
  description: "The personal website of Tom Heffernan - PhD Student in Artificial Intelligence at WPI",
  icons: {
    icon: "/images/symbol-white-transparent.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${syne.variable} ${ibmPlexSans.variable} ${ibmPlexMono.variable} antialiased`}
      >
        <AuthProvider>
          <header>
            <Navigation />
          </header>
          <main className="pt-16">
            {children}
          </main>
          <DebugDrawer />
        </AuthProvider>
      </body>
    </html>
  );
}
