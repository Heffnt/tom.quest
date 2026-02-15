"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "../components/AuthProvider";
import { logDebug } from "../lib/debug";
import ChoicesTab from "./ChoicesTab";
import ReviewTab from "./ReviewTab";
import type { CubeTab } from "./types";

const TAB_ORDER: CubeTab[] = ["choices", "review"];

function parseTab(value: string | null): CubeTab {
  if (value === "review") return "review";
  return "choices";
}

function CubeContent() {
  const { user, session } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [activeTab, setActiveTab] = useState<CubeTab>(() => parseTab(searchParams.get("tab")));
  const logSource = "Cube";

  useEffect(() => {
    const nextTab = parseTab(searchParams.get("tab"));
    setActiveTab(nextTab);
  }, [searchParams]);

  useEffect(() => {
    logDebug("lifecycle", "Cube page mounted", { activeTab }, logSource);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTab = useCallback(
    (tab: CubeTab) => {
      setActiveTab(tab);
      const next = new URLSearchParams(searchParams.toString());
      next.set("tab", tab);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
      logDebug("action", "Cube tab changed", { tab }, logSource);
    },
    [pathname, router, searchParams]
  );

  const tabButtonClass = useMemo(
    () =>
      "rounded-full border px-4 py-2 text-sm transition hover:border-white/40 hover:text-white",
    []
  );

  return (
    <div className="mx-auto max-w-6xl animate-fade-in">
      <h1 className="text-4xl font-bold tracking-tight">Cube</h1>
      <p className="mt-3 text-white/60">
        Rate Ravnica block cards for Tom's cube.
      </p>
      <div className="mt-6 flex flex-wrap gap-2 border-b border-white/10 pb-4">
        {TAB_ORDER.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setTab(tab)}
            className={`${tabButtonClass} ${
              activeTab === tab
                ? "border-white/50 bg-white/10 text-white"
                : "border-white/20 text-white/70"
            }`}
          >
            {tab === "choices" ? "Choices" : "Review"}
          </button>
        ))}
      </div>
      <div className="mt-6">
        {activeTab === "choices" && (
          <ChoicesTab
            userId={user?.id ?? null}
            accessToken={session?.access_token ?? null}
          />
        )}
        {activeTab === "review" && <ReviewTab />}
      </div>
    </div>
  );
}

export default function CubePage() {
  return (
    <div className="min-h-screen px-6 py-16" style={{ paddingBottom: 60 }}>
      <Suspense>
        <CubeContent />
      </Suspense>
    </div>
  );
}

