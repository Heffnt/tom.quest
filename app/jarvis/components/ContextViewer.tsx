"use client";

import { useState, useEffect } from "react";
import { useGateway } from "./useGateway";

export default function ContextViewer() {
  const {
    agentsFilesGet,
    agentsFilesList,
    agentsList,
    connected,
    skillsStatus,
  } = useGateway();
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [files, setFiles] = useState<Array<{
    name: string;
    path: string;
    missing: boolean;
    size?: number;
  }>>([]);
  const [skills, setSkills] = useState<Array<{
    name: string;
    description: string;
    eligible: boolean;
  }>>([]);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [openFileContent, setOpenFileContent] = useState<string | null>(null);

  useEffect(() => {
    if (collapsed || !connected) return;
    let cancelled = false;
    void (async () => {
      try {
        const agents = await agentsList();
        const agentId = agents.defaultId;
        const [filesResult, skillsResult] = await Promise.all([
          agentsFilesList(agentId),
          skillsStatus(agentId),
        ]);
        if (!cancelled) {
          setDefaultAgentId(agentId);
          setFiles(filesResult.files.map((file) => ({
            name: file.name,
            path: file.path,
            missing: file.missing,
            size: file.size,
          })));
          setSkills(skillsResult.skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            eligible: skill.eligible,
          })));
        }
      } catch {
        if (!cancelled) {
          setFiles([]);
          setSkills([]);
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [agentsFilesList, agentsList, collapsed, connected, skillsStatus]);

  useEffect(() => {
    if (!connected || !openFile || !defaultAgentId) return;
    let cancelled = false;
    void (async () => {
      try {
        const file = await agentsFilesGet(defaultAgentId, openFile);
        if (!cancelled) {
          setOpenFileContent(file.file.content ?? null);
        }
      } catch {
        if (!cancelled) {
          setOpenFileContent(null);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [agentsFilesGet, connected, defaultAgentId, openFile]);

  const availableFiles = files.filter((file) => !file.missing);

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => {
          setCollapsed((current) => {
            const next = !current;
            if (current) {
              setLoading(true);
            }
            return next;
          });
        }}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.03] transition-colors"
      >
        <h3 className="text-sm font-medium">Agent Context</h3>
        <span className="text-white/30 text-xs">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <div className="border-t border-white/5 px-4 py-3 space-y-3">
          {loading ? (
            <p className="text-xs text-white/30">Loading context…</p>
          ) : (
            <>
              {defaultAgentId && (
                <p className="text-[10px] text-white/20 font-mono">agent {defaultAgentId}</p>
              )}
              <div>
                <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Boot Files</p>
                <div className="flex flex-wrap gap-2">
                  {availableFiles.map((file) => (
                    <button
                      key={file.name}
                      onClick={() => {
                        setOpenFileContent(null);
                        setOpenFile(openFile === file.name ? null : file.name);
                      }}
                      className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                        openFile === file.name
                          ? "border-blue-400/40 text-blue-400 bg-blue-400/5"
                          : "border-white/10 text-white/50 hover:text-white/80"
                      }`}
                    >
                      {file.name}
                    </button>
                  ))}
                </div>
                {openFile && (
                  <pre className="mt-2 text-xs text-white/60 whitespace-pre-wrap max-h-72 overflow-y-auto font-mono bg-black/30 rounded p-3 border border-white/5">
                    {openFileContent ?? "Loading file…"}
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
                      <span
                        className={`font-mono flex-shrink-0 w-28 truncate ${
                          skill.eligible ? "text-white/60" : "text-red-300/70"
                        }`}
                      >
                        {skill.name}
                      </span>
                      <span className="text-white/30 truncate">{skill.description}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
