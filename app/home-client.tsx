"use client";

import { useEffect, useRef, useState } from "react";
import SymbolGame from "./components/symbol-game";
import Leaderboard, { type PendingResult } from "./components/leaderboard";
import LoginModal from "./components/login-modal";
import { useHeroMode } from "./lib/hero-mode";

/* Game size reserves room for the docked nav at the top and for score + retry
   text + leaderboard area below. Clamped to a reasonable max so it doesn't
   dominate on huge displays. */
function computeGameSize(vw: number, vh: number): number {
  const topReserve = 80;      // docked nav + gutter
  const bottomReserve = 220;  // score label + retry hint + leaderboard header
  const maxByHeight = vh - topReserve - bottomReserve;
  const maxByWidth = vw * 0.82;
  return Math.max(260, Math.min(maxByWidth, maxByHeight, 440));
}

function useViewportSize() {
  const [size, setSize] = useState({ w: 1024, h: 768 });
  useEffect(() => {
    const measure = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return size;
}

export default function HomeClient() {
  const { mode, startGame } = useHeroMode();
  const [result, setResult] = useState<PendingResult | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const nextWinId = useRef(1);
  const { w, h } = useViewportSize();
  const gameSize = computeGameSize(w, h);

  // Hero mode: space key starts the game (click-on-logo is handled in QuestNav).
  useEffect(() => {
    if (mode !== "hero") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      const t = e.target as HTMLElement | null;
      if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA") return;
      e.preventDefault();
      startGame();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, startGame]);

  // Going back to hero (logo click) clears any fail result.
  useEffect(() => {
    if (mode === "hero") setResult(null);
  }, [mode]);

  // Hero mode: the QuestNav renders the big logo, hint, and expanded nav term.
  // Nothing in the main content area — just the login modal mount.
  if (mode === "hero") {
    return <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />;
  }

  return (
    <div className="flex flex-col items-center w-full">
      <SymbolGame
        size={gameSize}
        onResult={({ hits }) => setResult({ winId: nextWinId.current++, ms: hits })}
        onReset={() => setResult(null)}
      />

      {result !== null && (
        <div className="mt-10 w-full flex justify-center">
          <Leaderboard
            result={result}
            onRequestLogin={() => setLoginOpen(true)}
          />
        </div>
      )}

      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />
    </div>
  );
}
