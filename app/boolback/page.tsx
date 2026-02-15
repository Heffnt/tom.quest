"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "../components/AuthProvider";
import { logDebug } from "../lib/debug";
import PipelineTab from "./PipelineTab";
import ResultsTab from "./ResultsTab";
import ValidateTab from "./ValidateTab";
import ReviewTab from "./ReviewTab";
import ExperimentReviewTab from "./ExperimentReviewTab";
import type { BoolbackTab } from "./types";

const TAB_ORDER: BoolbackTab[] = ["pipeline", "results", "validate", "review", "experiment-review"];

function parseTab(value: string | null): BoolbackTab {
  if (value === "results" || value === "validate" || value === "review" || value === "experiment-review") {
    return value;
  }
  return "pipeline";
}

export default function BoolbackPage() {
  const { user, isTom } = useAuth();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [activeTab, setActiveTab] = useState<BoolbackTab>(() => parseTab(searchParams.get("tab")));
  const logSource = "BoolBack";
  const userId = user?.id;

  useEffect(() => {
    const nextTab = parseTab(searchParams.get("tab"));
    setActiveTab(nextTab);
  }, [searchParams]);

  useEffect(() => {
    logDebug("lifecycle", "BoolBack page mounted", { activeTab }, logSource);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTab = useCallback(
    (tab: BoolbackTab) => {
      setActiveTab(tab);
      const next = new URLSearchParams(searchParams.toString());
      next.set("tab", tab);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
      logDebug("action", "BoolBack tab changed", { tab }, logSource);
    },
    [pathname, router, searchParams]
  );

  const tabButtonClass = useMemo(
    () =>
      "rounded-full border px-4 py-2 text-sm transition hover:border-white/40 hover:text-white",
    []
  );

  return (
    <div className="min-h-screen px-6 py-16" style={{ paddingBottom: 60 }}>
      <div className="mx-auto max-w-6xl animate-fade-in">
        <h1 className="text-4xl font-bold tracking-tight">BoolBack</h1>
        <p className="mt-3 text-white/60">
          Pipeline visibility, results, and fast validation workflows.
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
              {tab === "pipeline"
                ? "Pipeline"
                : tab === "results"
                  ? "Results"
                  : tab === "validate"
                    ? "Validate"
                    : tab === "review"
                      ? "Validation Review"
                      : "Experiment Review"}
            </button>
          ))}
        </div>
        <div className="mt-6">
          {activeTab === "pipeline" && <PipelineTab userId={userId} />}
          {activeTab === "results" && <ResultsTab userId={userId} />}
          {activeTab === "validate" && <ValidateTab userId={userId} isTom={isTom} />}
          {activeTab === "review" && <ReviewTab userId={userId} />}
          {activeTab === "experiment-review" && <ExperimentReviewTab userId={userId} />}
        </div>
      </div>
    </div>
  );
}
