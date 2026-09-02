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

  /* Dynamic import so the Pi package only loads server-side at request time,
     not at build time (and can be replaced if Pi's import path shifts). */
  const pi = await import("@earendil-works/pi-coding-agent");
  const {
    createAgentSession,
    SessionManager,
    AuthStorage,
    ModelRegistry,
    getAgentDir,
  } = pi as any;

  const authStorage = provisionProviderAuth(
    AuthStorage,
    getAgentDir,
    provider,
  );
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

/* Pi keys credentials by ITS provider id, not by ours. The two OpenAI ids are
   different providers to Pi, not spellings of one: "openai-codex" is the
   ChatGPT-subscription provider reached over OAuth, and "openai" is the
   plain API-key provider. Sending "openai" for our openai-oauth option makes
   Pi look for an API key, find none, and report the provider unconfigured. */
export function providerToPiName(provider: Provider): string {
  switch (provider) {
    case "anthropic":
      return "anthropic";
    case "openai-oauth":
      return "openai-codex";
    case "openai-api":
      return "openai";
  }
}

/* The env var holding one Pi auth.json: an object keyed by Pi provider id.
   Its value has to come from a login Pi performed for this deployment, e.g.

     {"openai-codex":{"type":"oauth","refresh":"...","access":"...","expires":1756800000000}}

   The name is deliberately not CODEX_AUTH_JSON, which read as "a copy of the
   codex command-line tool's ~/.codex/auth.json" and invited exactly the value
   that must never be put here. See rejectCodexCliShape below. */
export const PI_AUTH_ENV = "PI_AGENT_AUTH_JSON";

export type PiCredential =
  | { type: "api_key"; key: string }
  | { type: "oauth"; refresh: string; access: string; expires: number };

/* Refuse a blob in the shape of the codex command-line tool's own auth.json
   ({"tokens":{"access_token","refresh_token",...},"last_refresh":...}).

   The reason is token rotation, and it is not a file-permissions problem that
   copying the file elsewhere would solve. When an OAuth access token expires,
   Pi posts the refresh token to auth.openai.com and stores the NEW refresh
   token the response carries; OpenAI invalidates the old one. So a refresh
   token lifted out of ~/.codex/auth.json is a refresh token the codex
   command-line tool is still holding, and the first refresh here signs that
   tool out with no error message on either side. Nothing this code does to
   the file on disk can prevent that, because the rotation happens at OpenAI.
   The only fix is a separate login, whose refresh token nothing else holds. */
function rejectCodexCliShape(parsed: Record<string, unknown>): void {
  const tokens = parsed.tokens;
  const looksLikeCodexCli =
    (typeof tokens === "object" &&
      tokens !== null &&
      "refresh_token" in (tokens as Record<string, unknown>)) ||
    "last_refresh" in parsed ||
    "OPENAI_API_KEY" in parsed;
  if (!looksLikeCodexCli) return;
  throw new Error(
    `${PI_AUTH_ENV} holds the codex command-line tool's own auth.json. ` +
      "Refreshing that credential here rotates the refresh token at OpenAI " +
      "and signs that tool out. Run a separate Pi login for this deployment " +
      `and set ${PI_AUTH_ENV} to the resulting auth.json instead.`,
  );
}

/* Read one provider's credential out of the env blob. Pure, so the shapes it
   accepts and rejects are testable without the Pi package. */
export function parsePiAuthBlob(blob: string, piProvider: string): PiCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    throw new Error(`${PI_AUTH_ENV} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${PI_AUTH_ENV} is not a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  rejectCodexCliShape(record);

  const entry = record[piProvider];
  if (entry === undefined) {
    throw new Error(
      `${PI_AUTH_ENV} has no "${piProvider}" entry; its keys are Pi provider ids`,
    );
  }
  if (typeof entry !== "object" || entry === null) {
    throw new Error(`${PI_AUTH_ENV} entry "${piProvider}" is not an object`);
  }
  const credential = entry as Record<string, unknown>;
  if (credential.type === "api_key" && typeof credential.key === "string") {
    return { type: "api_key", key: credential.key };
  }
  if (
    credential.type === "oauth" &&
    typeof credential.refresh === "string" &&
    typeof credential.access === "string" &&
    typeof credential.expires === "number"
  ) {
    return {
      type: "oauth",
      refresh: credential.refresh,
      access: credential.access,
      expires: credential.expires,
    };
  }
  throw new Error(
    `${PI_AUTH_ENV} entry "${piProvider}" is neither an api_key credential ` +
      "nor an oauth credential with refresh, access and expires",
  );
}

/* Build the credential store the session runs on.

   Location: Pi reads and writes ONE auth.json, at getAgentDir()/auth.json —
   $PI_CODING_AGENT_DIR when that variable is set, otherwise ~/.pi/agent. We
   call Pi's own getAgentDir() rather than recomputing the path, so the
   override is honoured by construction and cannot drift. Pi never reads
   ~/.codex; writing there, as this function used to, produced a provider that
   silently failed to authenticate.

   Refresh: whoever owns that auth.json owns rotation of what is in it, and Pi
   rotates its own file under a lock. A credential already stored there came
   from a Pi login, so we leave it alone and let Pi refresh it in place, which
   is also what makes a rotated token survive the next cold start. Only when
   the file has nothing for this provider do we seed it from the env blob.

   AuthStorage.create keeps the credential in memory even when it cannot
   persist, so on a read-only filesystem (a Vercel function's home directory)
   the run still works and rotation simply lasts one run. drainErrors clears
   the recorded write failure so it is not re-reported later; the values in it
   are storage errors, never credentials. */
export function provisionProviderAuth(
  AuthStorage: {
    create: (authPath?: string) => {
      has: (provider: string) => boolean;
      set: (provider: string, credential: PiCredential) => void;
      drainErrors: () => unknown[];
    };
  },
  getAgentDir: () => string,
  provider: Provider,
) {
  const piProvider = providerToPiName(provider);
  const authStorage = AuthStorage.create();
  if (authStorage.has(piProvider)) return authStorage;

  const blob = process.env[PI_AUTH_ENV];
  if (!blob) {
    /* The API-key providers have a second source: Pi falls back to
       OPENAI_API_KEY and ANTHROPIC_API_KEY. Only OAuth has nowhere else to
       look, so only OAuth fails here. */
    if (provider === "openai-oauth") {
      throw new Error(
        `No "${piProvider}" credential in ${path.join(getAgentDir(), "auth.json")} ` +
          `and ${PI_AUTH_ENV} is not set; the OAuth provider is unavailable`,
      );
    }
    return authStorage;
  }

  authStorage.set(piProvider, parsePiAuthBlob(blob, piProvider));
  authStorage.drainErrors();
  return authStorage;
}
