"use client";

import { useMemo, type CSSProperties, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import QuestNav from "./quest-nav";
import DebugPanel from "./debug-panel";
import { useAuth } from "../lib/auth";
import { useUIStore } from "../lib/stores/ui-store";

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { isTom } = useAuth();
  const debugOpen = useUIStore((state) => state.debugOpen);
  const debugWidth = useUIStore((state) => state.debugWidth);
  const debugActive = isTom && debugOpen;

  const mainStyle = useMemo<CSSProperties>(() => {
    return debugActive ? { marginLeft: debugWidth } : {};
  }, [debugActive, debugWidth]);

  const navOffsets = useMemo(
    () => ({
      left: debugActive ? debugWidth : 0,
      right: 0,
    }),
    [debugActive, debugWidth],
  );

  /* The home page renders its own hero version of the nav (big logo +
     expanded terminal + auth top-right). Everywhere else uses the docked bar. */
  const isHome = pathname === "/";
  const padTop = isHome ? "" : "pt-16";
  const mainClassName = `${padTop} transition-[margin] duration-150 ease-out`;

  return (
    <>
      {!isHome && (
        <header>
          <QuestNav offsets={navOffsets} />
        </header>
      )}
      <main className={mainClassName} style={mainStyle}>
        {children}
      </main>
      <DebugPanel />
    </>
  );
}
