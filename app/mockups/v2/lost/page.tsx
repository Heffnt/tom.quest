"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LostInner() {
  const router = useRouter();
  const params = useSearchParams();
  const q = params.get("q");

  return (
    <div className="min-h-[calc(100vh-4rem)] flex flex-col items-center justify-center px-6 text-center">
      <div className="font-mono text-7xl text-accent mb-6 select-none">404</div>
      <h1 className="font-display text-3xl font-bold mb-3">That&apos;s not a place.</h1>
      <p className="text-text-muted max-w-md mb-2">
        {q ? (
          <>You tried <code className="text-accent">/{q}</code>. It isn&apos;t a page here.</>
        ) : (
          <>The page you wanted doesn&apos;t exist.</>
        )}
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

export default function LostPage() {
  return (
    <Suspense fallback={<div className="min-h-[calc(100vh-4rem)]" />}>
      <LostInner />
    </Suspense>
  );
}
