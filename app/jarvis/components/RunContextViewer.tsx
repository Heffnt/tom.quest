"use client";

import { useState, useEffect } from "react";
import { useGateway } from "./useGateway";

interface Props {
  sessionKey: string;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function formatAge(iso: string | null) {
  if (!iso) return "unknown";
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3600000);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h`;
  const m = Math.floor(ms / 60000);
  return `${m}m`;
}

function resolveAgentId(sessionKey: string) {
  if (!sessionKey.startsWith("agent:")) return "main";
  const parts = sessionKey.split(":");
  return parts[1] || "main";
}

export default function RunContextViewer({ sessionKey }: Props) {
  const {
    agentsFilesGet,
    agentsFilesList,
    connected,
    sessionsList,
    skillsStatus,
  } = useGateway();
  const [session, setSession] = useState<Awaited<ReturnType<typeof sessionsList>>["sessions"][number] | null>(null);
  const [files, setFiles] = useState<Array<{
    name: string;
    path: string;
    missing: boolean;
    size?: number;
    updatedAtMs?: number;
  }>>([]);
  const [skills, setSkills] = useState<Array<{ name: string; description: string; eligible: boolean }>>([]);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [openFileContent, setOpenFileContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const agentId = resolveAgentId(sessionKey);
        const [sessionsPage, agentFiles, skillReport] = await Promise.all([
          sessionsList({ limit: 200, includeDerivedTitles: true, includeLastMessage: true }),
          agentsFilesList(agentId),
          skillsStatus(agentId),
        ]);
        if (!cancelled) {
          setSession(sessionsPage.sessions.find((entry) => entry.key === sessionKey) ?? null);
          setFiles(agentFiles.files.map((file) => ({
            name: file.name,
            path: file.path,
            missing: file.missing,
            size: file.size,
            updatedAtMs: file.updatedAtMs,
          })));
          setSkills(skillReport.skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            eligible: skill.eligible,
          })));
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [agentsFilesList, connected, sessionKey, sessionsList, skillsStatus]);

  useEffect(() => {
    if (!connected || !openFile) return;
    let cancelled = false;
    void (async () => {
      try {
        const agentId = resolveAgentId(sessionKey);
        const result = await agentsFilesGet(agentId, openFile);
        if (!cancelled) {
          setOpenFileContent(result.file.content ?? null);
        }
      } catch {
        if (!cancelled) {
          setOpenFileContent(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentsFilesGet, connected, openFile, sessionKey]);

  if (loading) return <div className="px-6 py-3 text-xs text-white/30">Loading run context…</div>;
  if (error) return <div className="px-6 py-3 text-xs text-red-400">Error: {error}</div>;
  if (!session) return <div className="px-6 py-3 text-xs text-white/30">No session metadata available</div>;

  const injectedFiles = files.filter((file) => !file.missing);
  const missingFiles = files.filter((file) => file.missing);
  const totalBootChars = injectedFiles.reduce((sum, file) => sum + (file.size ?? 0), 0);

  return (
    <div className="px-6 py-4 space-y-4 border-t border-white/5 bg-black/40 text-xs">
      <div>
        <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Session</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-white/50">
          <span>Status</span>
          <span className="text-white/70">{session.status ?? "unknown"}</span>
          <span>Updated</span>
          <span className="text-white/70">{session.updatedAt ? formatAge(new Date(session.updatedAt).toISOString()) : "unknown"}</span>
          {session.startedAt && (
            <>
              <span>Started</span>
              <span className="text-white/70">{formatAge(new Date(session.startedAt).toISOString())}</span>
            </>
          )}
          {session.model && (
            <>
              <span>Model</span>
              <span className="text-white/70 font-mono">{session.model}</span>
            </>
          )}
          {typeof session.contextTokens === "number" && (
            <>
              <span>Context tokens</span>
              <span className="text-white/70">{session.contextTokens.toLocaleString()}</span>
            </>
          )}
          {typeof session.totalTokens === "number" && (
            <>
              <span>Total tokens</span>
              <span className="text-white/70">{session.totalTokens.toLocaleString()}</span>
            </>
          )}
          {typeof session.estimatedCostUsd === "number" && (
            <>
              <span>Estimated cost</span>
              <span className="text-white/70">${session.estimatedCostUsd.toFixed(4)}</span>
            </>
          )}
          {session.spawnedBy && (
            <>
              <span>Spawned by</span>
              <span className="text-white/70 font-mono break-all">{session.spawnedBy}</span>
            </>
          )}
          {session.spawnedWorkspaceDir && (
            <>
              <span>Workspace</span>
              <span className="text-white/70 font-mono break-all">{session.spawnedWorkspaceDir}</span>
            </>
          )}
          {typeof session.compactionCheckpointCount === "number" && (
            <>
              <span>Compactions</span>
              <span className="text-white/70">{session.compactionCheckpointCount}</span>
            </>
          )}
        </div>
      </div>

      <div>
        <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">
          Injected Boot Files ({injectedFiles.length})
          <span className="ml-2 normal-case tracking-normal text-white/20">~{(totalBootChars / 4).toLocaleString()} tokens</span>
        </p>
        <div className="space-y-0.5">
          {injectedFiles.map((file) => (
            <button
              key={file.name}
              onClick={() => {
                setOpenFile((current) => current === file.name ? null : file.name);
                setOpenFileContent(null);
              }}
              className="w-full text-left flex items-center gap-2 hover:bg-white/[0.02] rounded px-1 py-1"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
              <span className="text-white/60 font-mono">{file.name}</span>
              <span className="text-white/25">{formatBytes(file.size ?? 0)}</span>
            </button>
          ))}
          {missingFiles.map((file) => (
            <div key={file.name} className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-white/15 flex-shrink-0" />
              <span className="text-white/25 font-mono">{file.name}</span>
              <span className="text-white/15">not present</span>
            </div>
          ))}
        </div>
        {openFile && (
          <pre className="mt-2 text-xs text-white/60 whitespace-pre-wrap max-h-72 overflow-y-auto font-mono bg-black/30 rounded p-3 border border-white/5">
            {openFileContent ?? "Loading file…"}
          </pre>
        )}
      </div>

      <div>
        <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Skills ({skills.length})</p>
        <div className="flex flex-wrap gap-1.5">
          {skills.map((skill) => (
            <span
              key={skill.name}
              className={`px-1.5 py-0.5 rounded font-mono ${
                skill.eligible
                  ? "bg-white/[0.06] text-white/40"
                  : "bg-red-400/10 text-red-300/70"
              }`}
            >
              {skill.name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
