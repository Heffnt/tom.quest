/* eslint-disable @typescript-eslint/no-explicit-any */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import type { Provider } from "./models";

export type AgentEvent =
  | { kind: "system_prompt"; content: string }
  | { kind: "assistant_text"; content: string }
  | { kind: "tool_call"; tool: string; args: unknown }
  | { kind: "tool_result"; ok: boolean; output: unknown }
  | { kind: "html_changed"; html: string }
  | { kind: "error"; content: string };

export type RunArgs = {
  initialHtml: string;
  systemPrompt: string;
  userMessage: string;
  provider: Provider;
  model: string;
  onEvent: (event: AgentEvent) => Promise<void> | void;
};

const ALLOWED_TOOLS = ["read", "write", "edit"] as const;

/* runCanvasAgent: hide everything Pi-specific behind one async function.
   Caller passes the current HTML, the system prompt, and the user's message;
   we provision a temp dir, drop canvas.html in it, run a Pi AgentSession,
   stream events back via onEvent, and finally return when the run ends.

   On every Pi write/edit we re-read canvas.html and emit "html_changed".
   The caller (the API route) is responsible for syncing those events to
   Convex (so the live preview updates mid-run via reactive queries). */
export async function runCanvasAgent(args: RunArgs): Promise<void> {
  const { initialHtml, systemPrompt, userMessage, provider, model, onEvent } = args;

  const tmpDir = path.join(os.tmpdir(), `canvas-${crypto.randomUUID()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const canvasFile = path.join(tmpDir, "canvas.html");
  await fs.writeFile(canvasFile, initialHtml, "utf8");

  let lastSyncedHtml = initialHtml;
  const syncHtmlIfChanged = async () => {
    try {
      const next = await fs.readFile(canvasFile, "utf8");
      if (next !== lastSyncedHtml) {
        lastSyncedHtml = next;
        await onEvent({ kind: "html_changed", html: next });
      }
    } catch {
      /* file may be momentarily missing during edit; ignore */
    }
  };

  await provisionProviderAuth(provider);

  /* Dynamic import so the Pi package only loads server-side at request time,
     not at build time (and can be replaced if Pi's import path shifts). */
  // @ts-expect-error — Pi package types may not be available at build until installed.
  const pi = await import("@earendil-works/pi-coding-agent");
  const {
    createAgentSession,
    SessionManager,
    AuthStorage,
    ModelRegistry,
  } = pi as any;

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const sessionManager = SessionManager.inMemory();

  const { session } = await createAgentSession({
    sessionManager,
    authStorage,
    modelRegistry,
    workingDirectory: tmpDir,
    cwd: tmpDir,
    tools: { allowed: ALLOWED_TOOLS as unknown as string[] },
    model,
    provider: providerToPiName(provider),
    systemPrompt,
  });

  await onEvent({ kind: "system_prompt", content: systemPrompt });

  const completion = new Promise<void>((resolve, reject) => {
    let assistantBuffer = "";

    const flushAssistant = async () => {
      const text = assistantBuffer.trim();
      assistantBuffer = "";
      if (text) await onEvent({ kind: "assistant_text", content: text });
    };

    session.subscribe(async (event: any) => {
      try {
        switch (event?.type) {
          case "message_update": {
            const delta =
              event.assistantMessageEvent?.delta ?? event.delta ?? "";
            if (typeof delta === "string") assistantBuffer += delta;
            break;
          }
          case "tool_execution_start":
          case "tool_call": {
            await flushAssistant();
            const tool = event.tool ?? event.name ?? "tool";
            const eventArgs = event.args ?? event.input ?? {};
            await onEvent({ kind: "tool_call", tool, args: eventArgs });
            break;
          }
          case "tool_result": {
            const tool = event.tool ?? event.name;
            const ok = event.ok !== false && !event.error;
            const output = event.output ?? event.result ?? event.error ?? null;
            await onEvent({ kind: "tool_result", ok, output });
            if (ok && (tool === "write" || tool === "edit")) {
              await syncHtmlIfChanged();
            }
            break;
          }
          case "agent_end":
          case "completion": {
            await flushAssistant();
            await syncHtmlIfChanged();
            resolve();
            break;
          }
          case "error": {
            await flushAssistant();
            const content =
              typeof event.error === "string"
                ? event.error
                : event.message ?? "Agent error";
            await onEvent({ kind: "error", content });
            reject(new Error(content));
            break;
          }
        }
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    void session.prompt(userMessage).catch((err: unknown) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  try {
    await completion;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function providerToPiName(provider: Provider): string {
  if (provider === "anthropic") return "anthropic";
  return "openai";
}

/* Provision provider credentials before the session starts.

   - openai-oauth: Tom's Codex subscription auth.json is baked into the
     CODEX_AUTH_JSON env var. We materialize it to ~/.codex/auth.json so Pi's
     AuthStorage finds it through its normal lookup path. (TODO: the exact
     filesystem location and refresh policy depend on Pi's published behavior;
     adjust on first install.)
   - openai-api: OPENAI_API_KEY env var; Pi reads env vars as a fallback.
   - anthropic: ANTHROPIC_API_KEY env var; same. */
async function provisionProviderAuth(provider: Provider): Promise<void> {
  if (provider !== "openai-oauth") return;
  const blob = process.env.CODEX_AUTH_JSON;
  if (!blob) {
    throw new Error("CODEX_AUTH_JSON env var is not set; OAuth provider unavailable");
  }
  const target = path.join(os.homedir(), ".codex", "auth.json");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, blob, "utf8");
}
