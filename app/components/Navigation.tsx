"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useAuth } from "./AuthProvider";
import LoginModal from "./LoginModal";
import ProfileModal from "./ProfileModal";
import { logDebug } from "../lib/debug";

const navLinks = [
  { href: "/", label: "Home" },
  { href: "/bio", label: "Bio" },
  { href: "/turing", label: "Turing" },
  { href: "/boolback", label: "BoolBack" },
  { href: "/cube", label: "Cube" },
];

export default function Navigation() {
  const pathname = usePathname();
  const { isTom, user, profile } = useAuth();
  const [loginOpen, setLoginOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const logSource = "Nav";

  const displayName =
    profile?.username ||
    (typeof user?.user_metadata === "object"
      ? (user.user_metadata as { username?: string }).username
      : null) ||
    "User";

  const allLinks = isTom
    ? [...navLinks, { href: "/feedback", label: "Feedback" }]
    : navLinks;

  return (
    <>
      <nav className="fixed top-0 left-0 right-0 z-40 bg-black/80 backdrop-blur-sm border-b border-white/10">
        <div className="max-w-4xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <Link
              href="/"
              className="hover:opacity-70 transition-opacity"
            >
              <Image
                src="/images/logo-white-transparent.svg"
                alt="tom.quest"
                width={120}
                height={30}
              />
            </Link>
            <div className="flex items-center gap-6">
              {allLinks.slice(1).map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`relative text-sm transition-all duration-300 hover:opacity-100 ${
                    pathname === link.href
                      ? "opacity-100 underline underline-offset-4"
                      : "opacity-60"
                  }`}
                >
                  {link.label}
                </Link>
              ))}
              {user ? (
                <button
                  type="button"
                  onClick={() => {
                    logDebug("action", "Profile modal opened", undefined, logSource);
                    setProfileOpen(true);
                  }}
                  className={`text-sm px-3 py-1 rounded-full border transition-colors hover:text-white hover:border-white/40 ${
                    isTom
                      ? "border-green-400 text-green-300"
                      : "border-white/20 text-white/70"
                  }`}
                >
                  {displayName}
                </button>
              ) : (
                <button
                  onClick={() => {
                    logDebug("action", "Login modal opened", undefined, logSource);
                    setLoginOpen(true);
                  }}
                  className="text-sm px-3 py-1 rounded-full border border-white/20 text-white/70 hover:text-white hover:border-white/40 transition-colors"
                >
                  Log in
                </button>
              )}
            </div>
          </div>
        </div>
      </nav>
      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />
      <ProfileModal
        isOpen={profileOpen}
        onClose={() => setProfileOpen(false)}
        displayName={displayName}
      />
    </>
  );
}
