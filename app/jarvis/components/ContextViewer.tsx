"use client";

import { useState, useEffect } from "react";

interface ContextData {
  files: Record<string, string | null>;
  skillsPrompt: string | null;
}

interface Props {
  bridgeFetch: (path: string) => Promise<Response>;
}

function parseSkills(prompt: string | null): { name: string; description: string }[] {
  if (!prompt) return [];
  const re = new RegExp("<skill>\\s*<name>(.*?)</name>\\s*<description>(.*?)</description>", "gs");
  const results: { name: string; description: string }[] = [];
  let m;
  while ((m = re.exec(prompt)) !== null) {
    results.push({ name: m[1].trim(), description: m[2].trim() });
  }
  return results;
}

export default function ContextViewer({ bridgeFetch }: Props) {
  const [data, setData] = useState<ContextData | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [openFile, setOpenFile] = useState<string | null>(null);

  useEffect(() => {
    if (collapsed || data) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await bridgeFetch("/context");
        if (!cancelled && res.ok) setData(await res.json());
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [collapsed, data, bridgeFetch]);

  const skills = data ? parseSkills(data.skillsPrompt) : [];
  const fileNames = data ? Object.keys(data.files).filter((k) => data.files[k]) : [];

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.03] transition-colors"
      >
        <h3 className="text-sm font-medium">Agent Context</h3>
        <span className="text-white/30 text-xs">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <div className="border-t border-white/5 px-4 py-3 space-y-3">
          {loading ? (
            <p className="text-xs text-white/30">Loading context…</p>
          ) : data ? (
            <>
              <div>
                <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Boot Files</p>
                <div className="flex flex-wrap gap-2">
                  {fileNames.map((name) => (
                    <button
                      key={name}
                      onClick={() => setOpenFile(openFile === name ? null : name)}
                      className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                        openFile === name
                          ? "border-blue-400/40 text-blue-400 bg-blue-400/5"
                          : "border-white/10 text-white/50 hover:text-white/80"
                      }`}
                    >
                      {name}
                    </button>
                  ))}
                </div>
                {openFile && data.files[openFile] && (
                  <pre className="mt-2 text-xs text-white/60 whitespace-pre-wrap max-h-72 overflow-y-auto font-mono bg-black/30 rounded p-3 border border-white/5">
                    {data.files[openFile]}
                  </pre>
                )}
              </div>
              <div>
                <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">
                  Skills ({skills.length})
                </p>
                <div className="space-y-1">
                  {skills.map((skill) => (
                    <div key={skill.name} className="flex items-start gap-2 text-xs">
                      <span className="text-white/60 font-mono flex-shrink-0 w-28 truncate">
                        {skill.name}
                      </span>
                      <span className="text-white/30 truncate">{skill.description}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <p className="text-xs text-white/30">Failed to load context</p>
          )}
        </div>
      )}
    </div>
  );
}
