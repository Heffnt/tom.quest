"use client";

import { useRouter } from "next/navigation";

export default function NotFound() {
  const router = useRouter();

  return (
    <div className="min-h-[calc(100vh-8rem)] flex flex-col items-center justify-center px-6 text-center">
      <div className="font-mono text-7xl text-accent mb-6 select-none">404</div>
      <h1 className="font-display text-3xl font-bold mb-3">That&apos;s not a place.</h1>
      <p className="text-text-muted max-w-md mb-2">
        The page you tried doesn&apos;t exist.
      </p>
      <p className="text-text-faint text-sm mb-10 max-w-md">
        Not a bug. Not a mistake. Just nothing there.
      </p>
      <button
        onClick={() => router.back()}
        className="px-8 py-4 rounded-lg border border-accent text-accent hover:bg-accent/10 transition-colors font-mono text-lg"
      >
        ← back
      </button>
    </div>
  );
}
