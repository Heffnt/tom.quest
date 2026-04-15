"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import QuestNav from "./quest-nav";
import DebugDrawer from "./debug-drawer";
import { useAuth } from "../lib/auth";
import { debug } from "../lib/debug";

type DebugEdge = "left" | "right" | "bottom";
type DebugSizes = Record<DebugEdge, number>;

const DEFAULT_SIZES: DebugSizes = {
  left: 360,
  right: 420,
  bottom: 320,
};
const STORAGE_KEY = "debug-panel-sizes";
const navLog = debug.scoped("nav");

function clampSize(edge: DebugEdge, size: number): number {
  if (typeof window === "undefined") return size;
  const viewportSize = edge === "bottom" ? window.innerHeight : window.innerWidth;
  const maxSize = Math.round(viewportSize * 0.6);
  return Math.max(200, Math.min(maxSize, Math.round(size)));
}

function clampSizes(sizes: DebugSizes): DebugSizes {
  return {
    left: clampSize("left", sizes.left),
    right: clampSize("right", sizes.right),
    bottom: clampSize("bottom", sizes.bottom),
  };
}

function loadStoredSizes(): DebugSizes {
  if (typeof window === "undefined") return DEFAULT_SIZES;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SIZES;
    const parsed = JSON.parse(raw) as Partial<DebugSizes>;
    return clampSizes({
      left: typeof parsed.left === "number" ? parsed.left : DEFAULT_SIZES.left,
      right: typeof parsed.right === "number" ? parsed.right : DEFAULT_SIZES.right,
      bottom: typeof parsed.bottom === "number" ? parsed.bottom : DEFAULT_SIZES.bottom,
    });
  } catch {
    return DEFAULT_SIZES;
  }
}

function persistSizes(sizes: DebugSizes) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
}

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { isTom } = useAuth();
  const [openEdge, setOpenEdge] = useState<DebugEdge | null>(null);
  const [sizes, setSizes] = useState<DebugSizes>(() => loadStoredSizes());
  const [isResizing, setIsResizing] = useState(false);
  const sizesRef = useRef<DebugSizes>(sizes);

  useEffect(() => {
    sizesRef.current = sizes;
  }, [sizes]);

  useEffect(() => {
    if (!pathname) return;
    navLog.log(pathname);
  }, [pathname]);

  useEffect(() => {
    const handleResize = () => {
      setSizes((current) => clampSizes(current));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const handleOpen = useCallback((edge: DebugEdge) => {
    if (!isTom) return;
    setOpenEdge(edge);
  }, [isTom]);

  const handleResize = useCallback((edge: DebugEdge, nextSize: number) => {
    setSizes((current) => {
      const next = {
        ...current,
        [edge]: clampSize(edge, nextSize),
      };
      sizesRef.current = next;
      return next;
    });
  }, []);

  const handleResizeStart = useCallback(() => {
    setIsResizing(true);
  }, []);

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
    persistSizes(sizesRef.current);
  }, []);

  const activeEdge = isTom ? openEdge : null;

  const mainStyle = useMemo<CSSProperties>(() => {
    if (!activeEdge) return {};
    if (activeEdge === "left") return { marginLeft: sizes.left };
    if (activeEdge === "right") return { marginRight: sizes.right };
    return { marginBottom: sizes.bottom };
  }, [activeEdge, sizes]);

  const navOffsets = useMemo(
    () => ({
      left: activeEdge === "left" ? sizes.left : 0,
      right: activeEdge === "right" ? sizes.right : 0,
    }),
    [activeEdge, sizes],
  );

  const mainClassName = isResizing
    ? "pt-16"
    : "pt-16 transition-[margin] duration-150 ease-out";

  return (
    <>
      <header>
        <QuestNav offsets={navOffsets} animateOffsets={!isResizing} />
      </header>
      <main className={mainClassName} style={mainStyle}>
        {children}
      </main>
      <DebugDrawer
        openEdge={activeEdge}
        sizeByEdge={sizes}
        onOpen={handleOpen}
        onClose={() => setOpenEdge(null)}
        onResize={handleResize}
        onResizeStart={handleResizeStart}
        onResizeEnd={handleResizeEnd}
      />
    </>
  );
}
