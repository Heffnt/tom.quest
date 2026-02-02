import type { Metadata } from "next";
import { Poppins } from "next/font/google";
import "./globals.css";
import Navigation from "./components/Navigation";
import ClientProviders from "./components/ClientProviders";

const appFont = Poppins({
  variable: "--font-app",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "tom.Quest",
  description: "The personal website of Tom Heffernan - PhD Student in Artificial Intelligence at WPI",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${appFont.variable} antialiased`}
      >
        <ClientProviders>
          <Navigation />
          <main className="pt-16">
            {children}
          </main>
        </ClientProviders>
      </body>
    </html>
  );
}
