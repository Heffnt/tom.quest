"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../components/AuthProvider";
import LoginModal from "../components/LoginModal";
import { createBrowserSupabaseClient } from "../lib/supabase";

/* ── constants ────────────────────────────────────────────────── */

const CANVAS_SIZE = 400;
const CIRCLE_R = 140;
const CX = CANVAS_SIZE / 2;
const CY = CANVAS_SIZE / 2;

// Pivot sits above circle center (where the horizontal bar's midpoint is)
const PIVOT_OFFSET_Y = -CIRCLE_R * 0.35;
const PX = CX;
const PY = CY + PIVOT_OFFSET_Y;

// Target local angles (measured from "straight down" from pivot, CW positive)
const TARGETS = [
  -Math.PI / 4.5, // left diagonal (~-40°)
  0,               // center vertical (straight down)
  Math.PI / 4.5,  // right diagonal (~+40°)
];

const ZONE_TOL = Math.PI / 14;          // ~12.8° tolerance per zone
const LINE_LEN = CIRCLE_R - PIVOT_OFFSET_Y; // pivot → bottom of circle
const BAR_HW = CIRCLE_R * 0.65;         // bar half-width
const SPIN_BASE = 1.8;                  // rad/s base speed
const SPIN_ACCEL = 0.4;                 // extra rad/s per placed line
const LAUNCH_MS = 160;                  // launch animation duration

/* ── types ────────────────────────────────────────────────────── */

interface PlacedLine {
  localAngle: number;   // angle in the symbol's rotating frame
  hit: boolean;         // did it land in a valid zone?
}

interface LeaderboardEntry {
  id: string;
  username: string;
  time_ms: number;
  created_at: string;
}

type Phase = "idle" | "playing" | "launching" | "win" | "fail";

/* ── helpers ──────────────────────────────────────────────────── */

function norm(a: number): number {
  let n = a % (Math.PI * 2);
  if (n > Math.PI) n -= Math.PI * 2;
  if (n < -Math.PI) n += Math.PI * 2;
  return n;
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${s}.${String(ms % 1000).padStart(3, "0")}s`;
}

/* ── draw ─────────────────────────────────────────────────────── */

function draw(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  rot: number,
  placed: PlacedLine[],
  launchProg: number | null, // 0→1 or null
  remaining: number,
) {
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  // Circle
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(CX, CY, CIRCLE_R, 0, Math.PI * 2);
  ctx.stroke();

  // Enter rotating frame
  ctx.save();
  ctx.translate(PX, PY);
  ctx.rotate(rot);

  // Horizontal bar
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(-BAR_HW, 0);
  ctx.lineTo(BAR_HW, 0);
  ctx.stroke();

  // Zone guides (faint dashed)
  ctx.save();
  ctx.setLineDash([4, 8]);
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 1;
  for (const a of TARGETS) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.sin(a) * LINE_LEN, Math.cos(a) * LINE_LEN);
    ctx.stroke();
  }
  ctx.restore();

  // Placed lines (drawn in local frame)
  for (const l of placed) {
    ctx.strokeStyle = l.hit ? "rgba(255,255,255,0.9)" : "rgba(255,80,80,0.9)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.sin(l.localAngle) * LINE_LEN, Math.cos(l.localAngle) * LINE_LEN);
    ctx.stroke();
  }

  // Launching line (animates from pivot outward in local frame)
  if (launchProg !== null) {
    const ease = 1 - Math.pow(1 - launchProg, 3);
    // Launching line enters at local angle = "straight down in world" minus current rotation
    // But we compute this in the caller. Here we just draw at local angle 0 and let the
    // rotation context handle it. Actually, the line comes from below the pivot in WORLD space.
    // In the rotated frame, "world down" is at local angle = -rot.
    const localA = norm(-rot);
    ctx.strokeStyle = `rgba(255,255,255,${0.3 + 0.6 * ease})`;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.sin(localA) * LINE_LEN * ease, Math.cos(localA) * LINE_LEN * ease);
    ctx.stroke();
  }

  ctx.restore(); // exit rotating frame

  // Waiting lines at bottom
  const sp = 20;
  const sx = CX - ((remaining - 1) * sp) / 2;
  for (let i = 0; i < remaining; i++) {
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx + i * sp, CANVAS_SIZE - 35);
    ctx.lineTo(sx + i * sp, CANVAS_SIZE - 60);
    ctx.stroke();
  }

  // Up arrow
  if (remaining > 0) {
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath();
    ctx.moveTo(CX, CANVAS_SIZE - 68);
    ctx.lineTo(CX - 6, CANVAS_SIZE - 58);
    ctx.lineTo(CX + 6, CANVAS_SIZE - 58);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

/* ── component ────────────────────────────────────────────────── */

export default function SymbolGame() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const { user, profile } = useAuth();
  const [loginOpen, setLoginOpen] = useState(false);

  // State
  const [phase, setPhase] = useState<Phase>("idle");
  const [placed, setPlaced] = useState<PlacedLine[]>([]);
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(0);
  const [spinDir, setSpinDir] = useState(1);

  // Launch tracking
  const launchRef = useRef<{ start: number; rotAtLock: number } | null>(null);

  // Leaderboard
  const [lb, setLb] = useState<LeaderboardEntry[]>([]);
  const [showLb, setShowLb] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState<number | null>(null);

  // Mutable refs for animation loop
  const s = useRef({
    phase: "idle" as Phase,
    rot: 0,
    placed: [] as PlacedLine[],
    spinDir: 1,
    startMs: 0,
  });

  /* ── leaderboard ──────────────────────────────────────────── */

  const fetchLb = useCallback(async () => {
    const sb = createBrowserSupabaseClient();
    if (!sb) return;
    const { data } = await sb
      .from("symbol_scores")
      .select("id, username, time_ms, created_at")
      .order("time_ms", { ascending: true })
      .limit(20);
    if (data) setLb(data as LeaderboardEntry[]);
  }, []);

  useEffect(() => { fetchLb(); }, [fetchLb]);

  const saveScore = useCallback(async (ms: number) => {
    const sb = createBrowserSupabaseClient();
    if (!sb || !user) return;
    const uname = profile?.username
      || (typeof user.user_metadata === "object"
        ? (user.user_metadata as { username?: string }).username
        : null)
      || "Anonymous";
    const { error } = await sb.from("symbol_scores").insert({
      user_id: user.id,
      username: uname,
      time_ms: ms,
    });
    if (!error) { setSaved(true); setPending(null); fetchLb(); }
  }, [user, profile, fetchLb]);

  useEffect(() => {
    if (user && pending !== null && !saved) saveScore(pending);
  }, [user, pending, saved, saveScore]);

  /* ── animation loop ───────────────────────────────────────── */

  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    cvs.width = CANVAS_SIZE * dpr;
    cvs.height = CANVAS_SIZE * dpr;
    cvs.style.width = `${CANVAS_SIZE}px`;
    cvs.style.height = `${CANVAS_SIZE}px`;

    let prev = performance.now();

    const tick = (now: number) => {
      const dt = (now - prev) / 1000;
      prev = now;
      const st = s.current;

      // Spin
      if (st.phase === "playing" || st.phase === "launching") {
        const spd = SPIN_BASE + st.placed.length * SPIN_ACCEL;
        st.rot += spd * st.spinDir * dt;
      }

      // Check launch completion
      let launchProg: number | null = null;
      if (st.phase === "launching" && launchRef.current) {
        const elapsed = now - launchRef.current.start;
        launchProg = Math.min(elapsed / LAUNCH_MS, 1);

        if (launchProg >= 1) {
          // Lock the line — compute its local angle in the symbol
          // "Straight down in world" = angle 0. In the rotating frame, that's local = -rotation.
          const localA = norm(-st.rot);
          
          // Check zone hit
          let hit = false;
          const usedSet = new Set(st.placed.filter(l => l.hit).map((_, i) => {
            // Find which target each placed hit-line matched
            for (let t = 0; t < TARGETS.length; t++) {
              if (Math.abs(norm(st.placed.filter(l => l.hit)[i]?.localAngle - TARGETS[t])) < ZONE_TOL) return t;
            }
            return -1;
          }));

          // Simpler: just check each target
          for (let t = 0; t < TARGETS.length; t++) {
            if (Math.abs(norm(localA - TARGETS[t])) <= ZONE_TOL) {
              // Check this target isn't already taken
              const alreadyTaken = st.placed.some(
                l => l.hit && Math.abs(norm(l.localAngle - TARGETS[t])) <= ZONE_TOL
              );
              if (!alreadyTaken) { hit = true; break; }
            }
          }

          const newLine: PlacedLine = { localAngle: localA, hit };
          const newPlaced = [...st.placed, newLine];
          st.placed = newPlaced;
          setPlaced(newPlaced);
          launchRef.current = null;
          launchProg = null;

          if (!hit) {
            st.phase = "fail";
            setPhase("fail");
          } else if (newPlaced.length === 3) {
            const elapsed = Math.round(now - st.startMs);
            st.phase = "win";
            setPhase("win");
            setEndMs(elapsed);
            setSpinDir(Math.random() > 0.5 ? 1 : -1);
          } else {
            st.phase = "playing";
            setPhase("playing");
            // Occasionally flip direction
            if (Math.random() > 0.6) {
              st.spinDir *= -1;
              setSpinDir(st.spinDir);
            }
          }
        }
      }

      const remaining = 3 - st.placed.length - (launchProg !== null ? 1 : 0);
      draw(ctx, dpr, st.rot, st.placed, launchProg, remaining);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  /* ── tap ──────────────────────────────────────────────────── */

  const handleTap = useCallback(() => {
    const st = s.current;

    if (st.phase === "idle" || st.phase === "win" || st.phase === "fail") {
      // Start / restart
      st.placed = [];
      st.phase = "playing";
      st.startMs = performance.now();
      st.spinDir = spinDir;
      launchRef.current = null;
      setPlaced([]);
      setPhase("playing");
      setStartMs(performance.now());
      setEndMs(0);
      setSaved(false);
      setPending(null);
      return;
    }

    if (st.phase === "launching") return;

    if (st.phase === "playing") {
      launchRef.current = { start: performance.now(), rotAtLock: st.rot };
      st.phase = "launching";
      setPhase("launching");
    }
  }, [spinDir]);

  /* ── keyboard ─────────────────────────────────────────────── */

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.code === "Space" || e.key === " ") { e.preventDefault(); handleTap(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [handleTap]);

  /* ── render ───────────────────────────────────────────────── */

  return (
    <div className="min-h-screen px-4 py-16 flex flex-col items-center">
      <div className="text-center animate-fade-in mb-8">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight">The Tom Symbol</h1>
        <p className="mt-2 text-white/50 text-sm">
          Build the symbol. Time your taps. Don&apos;t miss.
        </p>
      </div>

      {/* Canvas */}
      <div className="relative animate-fade-in-delay">
        <canvas
          ref={canvasRef}
          className="cursor-pointer select-none"
          style={{ width: CANVAS_SIZE, height: CANVAS_SIZE }}
          onClick={handleTap}
          onTouchStart={(e) => { e.preventDefault(); handleTap(); }}
        />

        {phase === "idle" && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center">
              <p className="text-white/70 text-lg font-medium">Tap to Start</p>
              <p className="text-white/30 text-xs mt-1">or press Space</p>
            </div>
          </div>
        )}

        {phase === "win" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[2px] rounded-lg">
            <div className="text-center">
              <p className="text-green-400 text-2xl font-bold">{fmtTime(endMs)}</p>
              <p className="text-white/50 text-sm mt-1">Symbol complete!</p>
              {!user && !saved && (
                <button
                  onClick={(e) => { e.stopPropagation(); setPending(endMs); setLoginOpen(true); }}
                  className="mt-3 text-xs px-4 py-1.5 rounded-full border border-white/20 text-white/60 hover:text-white hover:border-white/40 transition-colors"
                >
                  Sign in to save score
                </button>
              )}
              {user && !saved && (
                <button
                  onClick={(e) => { e.stopPropagation(); saveScore(endMs); }}
                  className="mt-3 text-xs px-4 py-1.5 rounded-full border border-white/20 text-white/60 hover:text-white hover:border-white/40 transition-colors"
                >
                  Save score
                </button>
              )}
              {saved && <p className="mt-2 text-green-400/60 text-xs">Score saved! ✓</p>}
              <p className="text-white/30 text-xs mt-3">Tap to play again</p>
            </div>
          </div>
        )}

        {phase === "fail" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[2px] rounded-lg">
            <div className="text-center">
              <p className="text-red-400 text-xl font-bold">Missed!</p>
              <p className="text-white/40 text-sm mt-1">Line landed outside a zone</p>
              <p className="text-white/30 text-xs mt-3">Tap to try again</p>
            </div>
          </div>
        )}
      </div>

      {/* Timer */}
      {(phase === "playing" || phase === "launching") && (
        <div className="mt-4 text-white/40 text-sm font-mono tabular-nums">
          <LiveTimer start={startMs} />
        </div>
      )}

      {/* Leaderboard */}
      <div className="mt-8 w-full max-w-sm animate-fade-in-delay">
        <button
          onClick={() => { setShowLb(!showLb); if (!showLb) fetchLb(); }}
          className="w-full text-center text-sm text-white/40 hover:text-white/60 transition-colors"
        >
          {showLb ? "Hide Leaderboard" : "Leaderboard"}
        </button>

        {showLb && (
          <div className="mt-4 border border-white/10 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-white/10 bg-white/[0.02]">
              <h3 className="text-sm font-semibold text-white/60">Top Times</h3>
            </div>
            {lb.length === 0 ? (
              <div className="px-4 py-6 text-center text-white/30 text-sm">
                No scores yet. Be the first!
              </div>
            ) : (
              <div className="divide-y divide-white/5">
                {lb.map((e, i) => (
                  <div key={e.id} className="px-4 py-2.5 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className={`text-xs font-mono w-6 text-right ${
                        i === 0 ? "text-yellow-400" : i === 1 ? "text-white/50" : i === 2 ? "text-orange-400/70" : "text-white/20"
                      }`}>
                        {i + 1}
                      </span>
                      <span className="text-sm text-white/70">{e.username}</span>
                    </div>
                    <span className="text-sm font-mono text-white/50 tabular-nums">
                      {fmtTime(e.time_ms)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Instructions */}
      <div className="mt-8 max-w-sm text-center animate-fade-in-delay">
        <p className="text-white/20 text-xs leading-relaxed">
          The symbol spins. Tap to launch a line into the center.
          Land all 3 lines in the correct zones to complete the Tom Symbol.
          Miss a zone and it&apos;s over.
        </p>
      </div>

      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />
    </div>
  );
}

/* ── live timer ───────────────────────────────────────────────── */

function LiveTimer({ start }: { start: number }) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setMs(Math.round(performance.now() - start)), 47);
    return () => clearInterval(id);
  }, [start]);
  return <span>{fmtTime(ms)}</span>;
}
