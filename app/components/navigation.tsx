"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth, getUsername } from "../lib/auth";
import LoginModal from "./login-modal";
import ProfileModal from "./profile-modal";

const NAV_LINKS = [
  { href: "/bio", label: "Bio" },
  { href: "/turing", label: "Turing" },
  { href: "/jarvis", label: "Jarvis" },
];

export default function Navigation() {
  const pathname = usePathname();
  const { isTom, user } = useAuth();
  const [loginOpen, setLoginOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileRef = useRef<HTMLDivElement>(null);

  const displayName = getUsername(user);

  // Trap focus in mobile overlay
  const handleMobileKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      setMobileOpen(false);
      return;
    }
    if (e.key !== "Tab" || !mobileRef.current) return;
    const focusable = mobileRef.current.querySelectorAll<HTMLElement>(
      'a, button, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  useEffect(() => {
    if (mobileOpen) {
      document.addEventListener("keydown", handleMobileKeyDown);
      return () => document.removeEventListener("keydown", handleMobileKeyDown);
    }
  }, [mobileOpen, handleMobileKeyDown]);

  const isActive = (href: string) => pathname === href || (href !== "/" && pathname.startsWith(href));

  return (
    <>
      <nav
        aria-label="Main navigation"
        className="fixed top-0 left-0 right-0 z-40 bg-bg/80 backdrop-blur-sm border-b border-border"
      >
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          {/* Logo */}
          <Link href="/" className="hover:opacity-70 transition-opacity duration-150">
            <Image
              src="/images/logo-white-transparent.svg"
              alt="tom.quest"
              width={120}
              height={30}
            />
          </Link>

          {/* Desktop links */}
          <div className="hidden md:flex items-center gap-6">
            <ul className="flex items-center gap-6">
              {NAV_LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className={`relative text-sm transition-colors duration-150 ${
                      isActive(link.href)
                        ? "text-accent"
                        : "text-text-muted hover:text-text"
                    }`}
                  >
                    {link.label}
                    {isActive(link.href) && (
                      <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-accent" />
                    )}
                  </Link>
                </li>
              ))}
            </ul>

            {user ? (
              <button
                type="button"
                onClick={() => setProfileOpen(true)}
                className={`text-sm px-3 py-1.5 rounded-lg border transition-colors duration-150 hover:text-text hover:border-text-muted ${
                  isTom
                    ? "border-accent text-accent"
                    : "border-border text-text-muted"
                }`}
              >
                {displayName}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setLoginOpen(true)}
                className="text-sm px-3 py-1.5 rounded-lg border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors duration-150"
              >
                Log in
              </button>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            type="button"
            aria-label="Open menu"
            className="md:hidden text-text-muted hover:text-text transition-colors duration-150"
            onClick={() => setMobileOpen(true)}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </div>
      </nav>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          ref={mobileRef}
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          className="fixed inset-0 z-50 bg-bg flex flex-col items-center justify-center"
        >
          <button
            type="button"
            aria-label="Close menu"
            className="absolute top-5 right-6 text-text-muted hover:text-text transition-colors duration-150"
            onClick={() => setMobileOpen(false)}
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <ul className="flex flex-col items-center gap-8">
            {[{ href: "/", label: "Home" }, ...NAV_LINKS].map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className={`text-2xl transition-colors duration-150 ${
                    isActive(link.href)
                      ? "text-accent"
                      : "text-text-muted hover:text-text"
                  }`}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>

          <div className="mt-12">
            {user ? (
              <button
                type="button"
                onClick={() => { setMobileOpen(false); setProfileOpen(true); }}
                className="text-lg text-text-muted hover:text-text transition-colors duration-150"
              >
                {displayName}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { setMobileOpen(false); setLoginOpen(true); }}
                className="text-lg px-6 py-2 rounded-lg border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors duration-150"
              >
                Log in
              </button>
            )}
          </div>
        </div>
      )}

      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />
      <ProfileModal isOpen={profileOpen} onClose={() => setProfileOpen(false)} displayName={displayName} />
    </>
  );
}
