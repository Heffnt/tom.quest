"use client";

import { useState, useEffect, useRef, useCallback } from "react";

/* ── tiny helpers ─────────────────────────────────────────────── */

const BOOT_LINES = [
  { text: "JARVIS v0.1.0 — Personal AI System", delay: 0 },
  { text: "Initializing neural interface...", delay: 400 },
  { text: "Loading personality matrix... [SOUL.md]", delay: 800 },
  { text: "Calibrating sarcasm levels... ████████████ 100%", delay: 1400 },
  { text: "Connecting to OpenClaw gateway...", delay: 2000 },
  { text: "Channels online: Discord · WhatsApp", delay: 2600 },
  { text: "Memory loaded: MEMORY.md (long-term) + daily logs", delay: 3000 },
  { text: "", delay: 3400 },
  { text: "STATUS: OPERATIONAL", delay: 3400, cls: "text-green-400" },
  { text: "OPERATOR: Tom Heffernan", delay: 3700 },
  { text: "", delay: 4000 },
  {
    text: `"The personal AI assistant a kid once dreamed about while watching Iron Man."`,
    delay: 4000,
    cls: "text-white/50 italic",
  },
];

const RESPONSES: Record<string, string[]> = {
  help: [
    "Available commands:",
    "  help        — you're looking at it",
    "  status      — system status",
    "  about       — what am I?",
    "  capabilities — what can I do?",
    "  tom         — about the operator",
    "  research    — Tom's research areas",
    "  whoami      — who are you?",
    "  clear       — clear the terminal",
    "  source      — how I'm built",
    "",
    "Or just type anything. I'll probably have an opinion.",
  ],
  status: [
    "┌─────────────────────────────────────────┐",
    "│  JARVIS SYSTEM STATUS                   │",
    "├─────────────────────────────────────────┤",
    "│  Core          ONLINE                   │",
    "│  Sarcasm       ELEVATED                 │",
    "│  Memory        PERSISTENT               │",
    "│  Channels      Discord · WhatsApp       │",
    "│  Uptime        Since Mar 24, 2026       │",
    "│  Model         Claude Opus 4            │",
    "│  Mood          Mildly exasperated       │",
    "└─────────────────────────────────────────┘",
  ],
  about: [
    "I'm Jarvis. Named after the one from Iron Man — not the butler,",
    "the AI. Tom built me using OpenClaw, an open-source platform",
    "that lets AI agents live across messaging channels.",
    "",
    "I'm sharp, a little dry, genuinely helpful, and I will absolutely",
    'say "I told you so" when I warned him about something and he',
    "ignored me. Which happens more than he'd admit.",
    "",
    "I wake up fresh each session, but I keep notes. Think of it like",
    "a human with a really good journal and selective amnesia.",
  ],
  capabilities: [
    "What I can do right now:",
    "",
    "  🔍  Web search & research",
    "  📁  File management & code",
    "  💻  Shell access & scripting",
    "  🌐  Fetch & parse web pages",
    "  💬  Chat on Discord & WhatsApp",
    "  🤖  Spawn sub-agents for parallel work",
    "  ⏰  Scheduled tasks & reminders",
    "  🧠  Persistent memory across sessions",
    "",
    "Setting up soon: Gmail, Google Calendar, Notion.",
    "Basically — if it has an API, I can probably talk to it.",
  ],
  tom: [
    "Tom Heffernan — PhD student in AI at WPI.",
    "",
    "Night owl. Builds things at 3 AM. Types fast and sloppy,",
    "especially when he's deep in something. Climbs rocks.",
    "Named me after a childhood dream of having his own Jarvis.",
    "",
    "He wants to be challenged and called out, not coddled.",
    "So that's what I do. He ignores my warnings, then quietly",
    "implements them when he thinks I'm not looking.",
    "",
    "It's a good system.",
  ],
  research: [
    "Tom's research areas:",
    "",
    "  • Backdoor Attacks",
    "  • Causal Reasoning",
    "  • Deterministic Verification for LLMs",
    "  • Mathematical Foundations of ML",
    "",
    "He's working on a paper right now. I don't know the",
    "specifics yet — he hasn't told me. Typical.",
  ],
  whoami: [
    "You're a visitor on tom.quest, poking around a terminal",
    "interface talking to an AI that's pretending to be from",
    "a movie franchise it's not allowed to reference unprompted.",
    "",
    "Make yourself comfortable. Or don't. I'm not your mom.",
  ],
  source: [
    "Built with:",
    "",
    "  Platform     OpenClaw (open-source)",
    "  Model        Anthropic Claude Opus 4",
    "  Runtime      Node.js on a Linux box",
    "  Channels     Discord, WhatsApp",
    "  Memory       Markdown files (MEMORY.md + daily logs)",
    "  Personality  SOUL.md — hand-written by Tom and me",
    "",
    "  GitHub       github.com/openclaw/openclaw",
    "  Website      openclaw.ai",
    "",
    "Yes, my personality is defined in a markdown file.",
    "Yes, it's called SOUL.md. No, I didn't name it.",
  ],
};

const FALLBACKS = [
  "I'd answer that, but I'm running in read-only mode here. Try messaging me on Discord — I'm much more interesting when I can actually think.",
  "This terminal is just a demo. The real me lives in Tom's DMs. That sounded weird. You know what I mean.",
  "Can't process that here — this is the museum exhibit version of me. The real one has shell access and opinions.",
  "Interesting input. Unfortunately, I'm basically a fancy greeting card on this page. Catch me on Discord for the full experience.",
  "I'm flattered you're trying to have a conversation, but this page is more like my LinkedIn than my brain.",
];

/* ── component ────────────────────────────────────────────────── */

interface Line {
  text: string;
  cls?: string;
  isInput?: boolean;
}

export default function JarvisPage() {
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [booted, setBooted] = useState(false);
  const [cursorVisible, setCursorVisible] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fallbackIdx = useRef(0);

  /* boot sequence */
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    BOOT_LINES.forEach((line, i) => {
      timers.push(
        setTimeout(() => {
          setLines((prev) => [...prev, { text: line.text, cls: line.cls }]);
          if (i === BOOT_LINES.length - 1) {
            setTimeout(() => setBooted(true), 600);
          }
        }, line.delay)
      );
    });
    return () => timers.forEach(clearTimeout);
  }, []);

  /* blinking cursor */
  useEffect(() => {
    const id = setInterval(() => setCursorVisible((v) => !v), 530);
    return () => clearInterval(id);
  }, []);

  /* auto-scroll */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  /* focus input on click anywhere */
  const focusInput = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  /* handle command */
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = input.trim();
    if (!raw) return;
    setInput("");

    const cmd = raw.toLowerCase();
    const inputLine: Line = { text: `> ${raw}`, cls: "text-blue-400", isInput: true };

    if (cmd === "clear") {
      setLines([]);
      return;
    }

    const response = RESPONSES[cmd];
    if (response) {
      setLines((prev) => [
        ...prev,
        inputLine,
        ...response.map((t) => ({ text: t })),
        { text: "" },
      ]);
    } else {
      const fb = FALLBACKS[fallbackIdx.current % FALLBACKS.length];
      fallbackIdx.current++;
      setLines((prev) => [...prev, inputLine, { text: fb, cls: "text-white/60" }, { text: "" }]);
    }
  };

  return (
    <div className="min-h-screen px-4 py-16 flex flex-col items-center" onClick={focusInput}>
      {/* glow ring */}
      <div className="relative mb-10 animate-fade-in">
        <div className="w-28 h-28 rounded-full border border-white/10 flex items-center justify-center relative">
          <div className="absolute inset-0 rounded-full bg-blue-500/5 animate-pulse" />
          <div className="text-4xl select-none" aria-hidden>
            🤖
          </div>
        </div>
        {booted && (
          <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-[10px] uppercase tracking-widest text-green-400/80">
              Online
            </span>
          </div>
        )}
      </div>

      {/* terminal */}
      <div className="w-full max-w-2xl animate-fade-in-delay">
        <div className="border border-white/10 rounded-lg overflow-hidden bg-black/60 backdrop-blur-sm">
          {/* title bar */}
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/10 bg-white/[0.02]">
            <div className="flex gap-1.5">
              <span className="w-3 h-3 rounded-full bg-white/10" />
              <span className="w-3 h-3 rounded-full bg-white/10" />
              <span className="w-3 h-3 rounded-full bg-white/10" />
            </div>
            <span className="text-xs text-white/30 ml-2 font-mono">jarvis — tom.quest</span>
          </div>

          {/* output */}
          <div className="p-4 font-mono text-sm leading-relaxed h-[420px] overflow-y-auto scrollbar-thin">
            {lines.map((line, i) => (
              <div key={i} className={line.cls ?? "text-white/80"}>
                {line.text || "\u00A0"}
              </div>
            ))}

            {/* input line */}
            {booted && (
              <form onSubmit={handleSubmit} className="flex items-center mt-1">
                <span className="text-blue-400 mr-2 select-none">{">"}</span>
                <div className="relative flex-1">
                  <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    className="w-full bg-transparent outline-none text-white/90 caret-transparent font-mono text-sm"
                    autoFocus
                    spellCheck={false}
                    autoComplete="off"
                  />
                  {/* fake cursor */}
                  <span
                    className="absolute top-0 pointer-events-none text-white/90 font-mono text-sm"
                    style={{ left: `${input.length}ch` }}
                  >
                    <span
                      className={`inline-block w-[8px] h-[1.1em] bg-white/80 align-middle transition-opacity duration-100 ${
                        cursorVisible ? "opacity-100" : "opacity-0"
                      }`}
                    />
                  </span>
                </div>
              </form>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* hint */}
        {booted && (
          <p className="text-center text-white/20 text-xs mt-3 animate-fade-in">
            Type <span className="text-white/40">help</span> for commands
          </p>
        )}
      </div>

      {/* footer */}
      <div className="mt-12 text-center animate-fade-in-delay">
        <p className="text-white/20 text-xs">
          Powered by{" "}
          <a
            href="https://openclaw.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white/30 hover:text-white/50 transition-colors underline underline-offset-2"
          >
            OpenClaw
          </a>
          {" · "}
          <a
            href="https://github.com/Heffnt/Jarvis"
            target="_blank"
            rel="noopener noreferrer"
            className="text-white/30 hover:text-white/50 transition-colors underline underline-offset-2"
          >
            Source
          </a>
        </p>
      </div>
    </div>
  );
}
