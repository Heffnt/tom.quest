// discover.mjs — describe both CLIs' files without reading their contents.
//
// The classification mirrors the retired session archive's directory rules,
// but lives with the sweeper so the archive can disappear without leaving a
// second discovery dependency behind.

import fsDefault from "node:fs";
import path from "node:path";

function entries(dir, fs) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
}

function statFile(file, fs) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat : null;
  } catch {
    return null;
  }
}

function rootEntry(entry) {
  return typeof entry === "string" ? { path: entry } : entry;
}

function codexThreadId(file) {
  const name = path.basename(file, ".jsonl");
  return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(name)?.[1] ?? name;
}

// A child transcript is `agent-<agentId>.jsonl` ANYWHERE under the session's
// `subagents/` tree. The CLI writes the agents of a Workflow one folder
// deeper, at `subagents/workflows/wf_<id>/`, and nothing stops it nesting
// further; the agent id is the identity and the folder is only where the file
// lives, so the walk is recursive and the thread id keeps its one slash.
export const AGENT_FILE = /^agent-(.+)\.jsonl$/i;
export const AGENT_SIDECAR = /^agent-(.+)\.meta\.json$/i;
/** The `wf_<id>` folder a path sits under, when it sits under one. */
export function workflowIdOf(parts) {
  return parts.find((part) => /^wf_./.test(part));
}

function describeClaude(file, root, host, account, project, fs) {
  const stat = statFile(file, fs);
  if (!stat) return null;
  const relative = path.relative(root, file);
  const parts = relative.split(path.sep);
  if (parts.some((part) => part === "..")) return null;
  if (parts.length === 2 && file.endsWith(".jsonl")) {
    return { runtime: "claude", host, root, ...(account ? { account } : {}), project: project ?? parts[0], threadId: path.basename(file, ".jsonl"), kind: "root", path: path.resolve(file), mtimeMs: stat.mtimeMs, bytes: stat.size };
  }
  const sessionId = parts[1];
  const name = parts[parts.length - 1];
  const underSubagents = parts.length >= 4 && parts[2] === "subagents";
  const subagent = underSubagents && AGENT_FILE.exec(name);
  const workflowId = workflowIdOf(parts);
  if (subagent) {
    return { runtime: "claude", host, root, ...(account ? { account } : {}), project: project ?? parts[0], threadId: `${sessionId}/${subagent[1]}`, kind: "subagent", ...(workflowId ? { workflowId } : {}), path: path.resolve(file), mtimeMs: stat.mtimeMs, bytes: stat.size };
  }
  if (parts.length >= 3 && !file.endsWith(".registration.json") && !file.endsWith(".lock")) {
    // Everything else under the session directory is an attachment, named for
    // the nearest run: the agent when the file name says one, else the root.
    const sidecar = underSubagents && AGENT_SIDECAR.exec(name);
    return { runtime: "claude", host, root, ...(account ? { account } : {}), project: project ?? parts[0], threadId: sidecar ? `${sessionId}/${sidecar[1]}` : sessionId, kind: "attachment", ...(workflowId ? { workflowId } : {}), path: path.resolve(file), mtimeMs: stat.mtimeMs, bytes: stat.size };
  }
  return null;
}

function walkFiles(directory, fs, visit) {
  for (const entry of entries(directory, fs)) {
    if (entry.isSymbolicLink?.()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(absolute, fs, visit);
    else if (entry.isFile()) visit(absolute);
  }
}

/** Describe a hook-supplied file without scanning either CLI tree. */
export function describeRunFile(file, { roots, host, fs = fsDefault } = {}) {
  const absolute = path.resolve(file);
  for (const raw of roots?.claude ?? []) {
    const entry = rootEntry(raw);
    const root = path.resolve(entry.path);
    if (absolute === root || absolute.startsWith(`${root}${path.sep}`)) {
      return describeClaude(absolute, root, host, entry.account, entry.project, fs);
    }
  }
  for (const raw of roots?.codex ?? []) {
    const entry = rootEntry(raw);
    const root = path.resolve(entry.path);
    if (absolute === root || absolute.startsWith(`${root}${path.sep}`)) {
      const stat = statFile(absolute, fs);
      if (!stat || !absolute.endsWith(".jsonl")) return null;
      return { runtime: "codex", host, root, threadId: codexThreadId(absolute), kind: "rollout", path: absolute, mtimeMs: stat.mtimeMs, bytes: stat.size };
    }
  }
  // Hooks can run before configuration names a newly-created account. The
  // CLI's stable path words are enough to choose a parser, never a host id.
  if (/[\\/]\.codex[\\/]sessions[\\/]/i.test(absolute) || /^rollout-.*\.jsonl$/i.test(path.basename(absolute))) {
    const stat = statFile(absolute, fs);
    return stat ? { runtime: "codex", host, root: path.dirname(absolute), threadId: codexThreadId(absolute), kind: "rollout", path: absolute, mtimeMs: stat.mtimeMs, bytes: stat.size } : null;
  }
  const subagent = /[\\/]([^\\/]+)[\\/]subagents[\\/](?:.+[\\/])?agent-(.+)\.jsonl$/i.exec(absolute);
  const stat = statFile(absolute, fs);
  if (!stat || !absolute.endsWith(".jsonl")) return null;
  const threadId = subagent ? `${subagent[1]}/${subagent[2]}` : path.basename(absolute, ".jsonl");
  const workflowId = subagent ? workflowIdOf(absolute.split(/[\\/]/)) : undefined;
  return { runtime: "claude", host, root: path.dirname(absolute), threadId, kind: subagent ? "subagent" : "root", ...(workflowId ? { workflowId } : {}), path: absolute, mtimeMs: stat.mtimeMs, bytes: stat.size };
}

/**
 * Every changed run-related file under the configured roots. `since` filters
 * by the file's own mtime; directories are never pruned because appending a
 * transcript does not update its parent directory's mtime.
 */
export function discoverRunFiles({ roots, since = 0, host, fs = fsDefault } = {}) {
  const found = [];
  for (const raw of roots?.claude ?? []) {
    const configured = rootEntry(raw);
    const root = path.resolve(configured.path);
    for (const projectEntry of entries(root, fs)) {
      if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink?.()) continue;
      const projectDir = path.join(root, projectEntry.name);
      walkFiles(projectDir, fs, (file) => {
        const item = describeClaude(file, root, host, configured.account, projectEntry.name, fs);
        if (item && item.mtimeMs > since) found.push(item);
      });
    }
  }
  for (const raw of roots?.codex ?? []) {
    const configured = rootEntry(raw);
    const root = path.resolve(configured.path);
    walkFiles(root, fs, (file) => {
      if (!file.endsWith(".jsonl")) return;
      const stat = statFile(file, fs);
      if (stat && stat.mtimeMs > since) found.push({ runtime: "codex", host, root, threadId: codexThreadId(file), kind: "rollout", path: path.resolve(file), mtimeMs: stat.mtimeMs, bytes: stat.size });
    });
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
