"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navLinks = [
  { href: "/", label: "Home" },
  { href: "/bio", label: "Bio" },
  { href: "/projects", label: "Projects" },
  { href: "/turing", label: "Turing" },
  { href: "/data-labeling", label: "Data Labeling" },
];

export default function Navigation() {
  const pathname = usePathname();

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-black/80 backdrop-blur-sm border-b border-white/10">
      <div className="max-w-4xl mx-auto px-6 py-4">
        <div className="flex items-center justify-between">
          <Link
            href="/"
            className="font-mono text-lg tracking-tight hover:opacity-70 transition-opacity"
          >
            TOM.quest
          </Link>
          <div className="flex gap-6">
            {navLinks.slice(1).map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className={`text-sm transition-all duration-300 hover:opacity-100 ${
                  pathname === link.href
                    ? "opacity-100 underline underline-offset-4"
                    : "opacity-60"
                }`}
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </nav>
  );
}
