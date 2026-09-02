"use client";

import { useRef, useState } from "react";
import SymbolGame from "../components/symbol-game";
import Leaderboard, { type PendingResult } from "../components/leaderboard";
import LoginModal from "../components/login-modal";
import { useViewport } from "../lib/hooks/use-viewport";

function computeGameSize(vw: number, vh: number): number {
  const topReserve = 96;      // docked nav + gutter
  const bottomReserve = 240;  // score label + retry hint + leaderboard header
  const maxByHeight = vh - topReserve - bottomReserve;
  const maxByWidth = vw * 0.82;
  return Math.max(260, Math.min(maxByWidth, maxByHeight, 440));
}

export default function GamePage() {
  const [result, setResult] = useState<PendingResult | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const nextWinId = useRef(1);
  // 1024x768 before measurement: the dimensions this page's server HTML has
  // always used, so the first-paint board size is unchanged.
  const vp = useViewport();
  const gameSize = computeGameSize(vp?.width ?? 1024, vp?.height ?? 768);

  return (
    <div className="flex flex-col items-center px-6 pt-6 pb-16">
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
