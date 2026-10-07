// What the error pages (app/error.tsx, app/global-error.tsx) show about a
// thrown error: which call failed, the message the server gave, when, which
// build threw it and which record deployment that build talks to.
//
// A Convex query that fails in the browser throws an Error whose message the
// client library builds as
//   [CONVEX Q(sessions:list)] [Request ID: 5a1f...] Server Error
//   Could not find public function for 'sessions:list'. Did you forget to run `npx convex dev` or `npx convex deploy`?
//
//     Called by client
// (convex/dist/esm/browser/logging.js, createHybridErrorStacktrace). The
// prefix names the function type (Q query, M mutation, A action) and path;
// the rest is the server's own text. "Could not find public function" is the
// record refusing a function this build calls and the deployed record does
// not have. scripts/vercel-build.mjs decides which side is out of date: a
// preview build deploys no functions, so it is ahead of the record; a
// production build deploys its functions before it is served, so a
// production page that meets this is behind (loaded before a newer record
// deployment removed the function).

import { displayForm } from "@/shared/clock.mjs";

type BuildInfo = {
  /** Commit short sha, from VERCEL_GIT_COMMIT_SHA (or local git) at build time. */
  sha: string | null;
  /** Branch, from VERCEL_GIT_COMMIT_REF (or local git) at build time. */
  branch: string | null;
  /** Vercel's environment: production, preview or development. */
  deployEnv: string | null;
};

type ErrorDiagnosis = {
  kind: "unknown-function" | "convex-function" | "page";
  /** One line naming what failed. */
  headline: string;
  /** "query sessions:list", or the route for a non-Convex error. */
  failed: string;
  /** The request: Convex request id, Next's server digest, and the route. */
  request: string;
  /** The error message as the server (or the throwing code) gave it. */
  message: string;
  /** Time of the error, New York. */
  time: string;
  build: string;
  record: string;
  /** What the reader can do. */
  action: string;
};

const FUNCTION_TYPES: Record<string, string> = {
  Q: "query",
  M: "mutation",
  A: "action",
};

const CONVEX_PREFIX = /^\[CONVEX ([QMA])\(([^)]*)\)\]\s*/;
const REQUEST_ID = /^\[Request ID: ([^\]]+)\]\s*/;
const UNKNOWN_FUNCTION = /Could not find public function for '([^']+)'/;
const CALLED_BY_CLIENT = /\s*Called by client\s*$/;

export function readBuildInfo(): BuildInfo {
  // Each read is a literal process.env.NAME so Next inlines the value that
  // next.config.ts's `env` block set at build time.
  const sha = process.env.BUILD_COMMIT_SHA || null;
  return {
    sha: sha ? sha.slice(0, 7) : null,
    branch: process.env.BUILD_BRANCH || null,
    deployEnv: process.env.BUILD_DEPLOY_ENV || null,
  };
}

export function readRecordHost(): string | null {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  // String slicing, not new URL(): this runs inside the error pages, which
  // must not throw on a malformed value.
  return url ? url.replace(/^[a-z]+:\/\//i, "").split("/")[0] : null;
}

// A ConvexError's data is any Convex value, and a Convex Int64 arrives as a
// bigint, which JSON.stringify refuses; written as its digits instead.
function dataText(data: unknown): string {
  return typeof data === "string"
    ? data
    : JSON.stringify(data, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

function formatBuild(build: BuildInfo): string {
  const parts = [
    build.sha ?? "commit unknown",
    build.branch ? `on ${build.branch}` : "branch unknown",
  ];
  if (build.deployEnv) parts.push(`(${build.deployEnv})`);
  return parts.join(" ");
}

export function diagnoseError(
  error: Error & { digest?: string; data?: unknown },
  context: { route: string; at: number; build: BuildInfo; recordHost: string | null },
): ErrorDiagnosis {
  let rest = String(error?.message ?? error ?? "");
  let requestId: string | null = null;

  const prefix = rest.match(CONVEX_PREFIX);
  if (prefix) rest = rest.slice(prefix[0].length);
  const request = rest.match(REQUEST_ID);
  if (request) {
    requestId = request[1];
    rest = rest.slice(request[0].length);
  }
  rest = rest.replace(CALLED_BY_CLIENT, "").trim();
  // A ConvexError thrown by a function carries its payload in `data`.
  if (error?.data !== undefined && error.data !== null) {
    const data = dataText(error.data);
    if (!rest.includes(data)) rest = rest ? `${rest}\n${data}` : data;
  }

  const unknown = rest.match(UNKNOWN_FUNCTION);

  const recordHost = context.recordHost ?? "record host unknown";
  const build = formatBuild(context.build);
  const requestParts = [
    requestId ? `request ${requestId}` : null,
    error?.digest ? `digest ${error.digest}` : null,
    `route ${context.route}`,
  ].filter(Boolean);

  const base = {
    request: requestParts.join(", "),
    message: rest || "(the error carried no message)",
    time: `${displayForm(context.at)} Eastern`,
    build,
    record: recordHost,
  };

  if (prefix) {
    const functionName = prefix[2];
    const call = `${FUNCTION_TYPES[prefix[1]]} ${functionName}`;
    if (unknown) {
      return {
        ...base,
        kind: "unknown-function",
        headline: `The record has no function ${functionName}`,
        failed: call,
        action: unknownFunctionAction(functionName, recordHost, context.build),
      };
    }
    return {
      ...base,
      kind: "convex-function",
      headline: `${call} failed on the record`,
      failed: call,
      action: `Retry runs ${functionName} again; the message above is the record's own account of why it failed.`,
    };
  }
  return {
    ...base,
    kind: "page",
    headline: `Rendering ${context.route} failed`,
    failed: `route ${context.route}`,
    action: error?.digest
      ? `Retry renders the page again; the server hides its message in production builds, and the digest above finds it in the Vercel log.`
      : `Retry renders the page again.`,
  };
}

function unknownFunctionAction(name: string, recordHost: string, build: BuildInfo): string {
  const ahead = `the build is ahead of the record, and retrying fails until a merge of ${build.branch ?? "this build's branch"} to main deploys ${name}`;
  const behind = `this page was loaded from an older build than the record, which no longer has ${name}; reloading the page loads the current build`;
  if (build.deployEnv === "preview") {
    return `This preview build calls ${name}, which the record at ${recordHost} does not have, and a preview build deploys no functions: ${ahead}.`;
  }
  if (build.deployEnv === "production") {
    return `A production build deploys its functions before it is served, so ${behind}.`;
  }
  return `The record at ${recordHost} does not have ${name}. Either ${ahead}, or ${behind}.`;
}

/** The diagnosis as plain text, for the copy button. */
export function diagnosisText(d: ErrorDiagnosis): string {
  return [
    d.headline,
    `failed: ${d.failed}`,
    `request: ${d.request}`,
    `message: ${d.message}`,
    `time: ${d.time}`,
    `build: ${d.build}`,
    `record: ${d.record}`,
    d.action,
  ].join("\n");
}
