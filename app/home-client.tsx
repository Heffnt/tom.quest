"use client";

import { useRef, useState } from "react";
import SymbolGame from "./components/symbol-game";
import Leaderboard, { type PendingResult } from "./components/leaderboard";
import LoginModal from "./components/login-modal";

export default function HomeClient() {
  const [result, setResult] = useState<PendingResult | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const nextWinId = useRef(1);

  return (
    <>
      <div className="animate-settle">
        <SymbolGame
          onWin={(ms) => setResult({ winId: nextWinId.current++, ms })}
          onReset={() => setResult(null)}
        />
      </div>

      <div className="mt-10 text-center">
        <h1 className="text-4xl font-bold tracking-tight animate-settle-delay-1">
          Tom Heffernan
        </h1>
        <p className="mt-2 text-lg text-text-muted animate-settle-delay-2">
          PhD Student, AI @ WPI
        </p>
      </div>

      <div className="mt-10 animate-settle-delay-3">
        <Leaderboard
          result={result}
          onRequestLogin={() => setLoginOpen(true)}
        />
      </div>

      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />
    </>
  );
}
