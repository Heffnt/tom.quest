// tts-vercel-lib — the pure half of tts-vercel: argument parsing, URL
// building, deployment selection, and log shaping. Separated from the CLI so
// each piece is testable without a Vercel token or a network (see
// tts-vercel-lib.test.mjs); the executable half does nothing but read the
// token, fetch, and print.
//
// READ-ONLY BY CONSTRUCTION, and that is the point of the split. `request()`
// in the CLI takes no method and no body parameter — every call it can make is
// a GET — and the only paths reachable are the four listed in READ_PATHS
// below. A session cannot talk this helper into promoting a deployment,
// cancelling a build, or rewriting a project's environment, because there is
// no argument that would carry the verb. The token's own scope is a second,
// independent limit (worker.env.example says to mint a read-only one), but the
// helper does not depend on Tom having minted it correctly.

/** Every Vercel REST path this helper may touch. All GET, all observation. */
export const READ_PATHS = {
  projects: "/v9/projects",
  deployments: "/v6/deployments",
  deployment: (id) => `/v13/deployments/${encodeURIComponent(id)}`,
  events: (id) => `/v3/deployments/${encodeURIComponent(id)}/events`,
};

export const API_ORIGIN = "https://api.vercel.com";

export function usageText() {
  return [
    "usage: tts-vercel <status|log|inspect|projects> [options]",
    "",
    "  status              recent deployments for the project, newest first",
    "  log                 build log of one deployment (the failing one by default)",
    "  inspect             one deployment's full record as JSON",
    "  projects            list projects visible to the token (to find --project)",
    "",
    "  --branch B          git branch to select a deployment by (default: the",
    "                      current branch in cwd, else the production deployment)",
    "  --deployment ID     select one deployment explicitly; skips branch lookup",
    "  --project NAME      project name or id (default: $VERCEL_PROJECT_ID, else",
    "                      the repo directory name)",
    "  --limit N           how many deployments (status) or log lines (log)",
    "  --all               with `log`, print every line instead of errors only",
    "  --json              raw JSON instead of the formatted digest",
  ].join("\n");
}

/**
 * Parse argv (already sliced past node + script). Throws Error on bad usage so
 * the CLI can print usage and exit 2; returning a sentinel would let a typo
 * silently run the default verb.
 */
export function parseArgs(argv) {
  const opts = {
    verb: null,
    branch: null,
    deployment: null,
    project: null,
    limit: null,
    all: false,
    json: false,
  };
  const VERBS = new Set(["status", "log", "inspect", "projects"]);
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") opts.all = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--branch") opts.branch = argv[++i] ?? null;
    else if (a === "--deployment") opts.deployment = argv[++i] ?? null;
    else if (a === "--project") opts.project = argv[++i] ?? null;
    else if (a === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) throw new Error("--limit needs a positive integer");
      opts.limit = n;
    } else if (a === "--help" || a === "-h") throw new Error("help");
    else if (a.startsWith("-")) throw new Error(`unknown flag ${a}`);
    else rest.push(a);
  }
  if (rest.length > 1) throw new Error(`expected one verb, got ${rest.join(" ")}`);
  opts.verb = rest[0] ?? "status";
  if (!VERBS.has(opts.verb)) throw new Error(`unknown verb ${opts.verb}`);
  for (const [flag, value] of [
    ["--branch", opts.branch],
    ["--deployment", opts.deployment],
    ["--project", opts.project],
  ]) {
    if (value === null && argv.includes(flag)) throw new Error(`${flag} needs a value`);
  }
  return opts;
}

/**
 * Build one absolute API URL. `teamId` is appended when set because a project
 * owned by a Vercel team is invisible to a token that does not name it — the
 * request succeeds with an empty list rather than failing, which is the
 * confusing shape this parameter exists to avoid.
 */
export function buildUrl(path, query = {}, teamId) {
  const url = new URL(path, API_ORIGIN);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  if (teamId) url.searchParams.set("teamId", teamId);
  return url.toString();
}

/** Vercel's readyState values, worst-to-best for reporting purposes. */
export const FAILED_STATES = new Set(["ERROR", "CANCELED"]);

export function deploymentState(d) {
  return d?.readyState ?? d?.state ?? "UNKNOWN";
}

export function deploymentBranch(d) {
  return d?.meta?.githubCommitRef ?? d?.meta?.gitBranch ?? null;
}

export function deploymentId(d) {
  return d?.uid ?? d?.id ?? null;
}

/**
 * Choose which deployment the caller meant.
 *
 * Order matters and encodes what a session is actually doing when it runs
 * this: it just pushed a branch and CI went red. So a branch match wins over
 * recency, and among branch matches a FAILED one wins over a newer successful
 * one — re-running a build after a fix leaves both on the branch, and the
 * failure is the thing being diagnosed. Without that preference the helper
 * would answer a question nobody asked ("the newest build passed") while the
 * red check that blocks the merge stays unread.
 */
export function pickDeployment(deployments, { branch, preferFailed = true } = {}) {
  const list = Array.isArray(deployments) ? deployments.filter(Boolean) : [];
  if (list.length === 0) return null;
  const byNewest = [...list].sort((a, b) => (b?.created ?? 0) - (a?.created ?? 0));
  const scoped = branch ? byNewest.filter((d) => deploymentBranch(d) === branch) : byNewest;
  if (scoped.length === 0) return null;
  if (preferFailed) {
    const failed = scoped.find((d) => FAILED_STATES.has(deploymentState(d)));
    if (failed) return failed;
  }
  return scoped[0];
}

function eventText(e) {
  const raw = e?.payload?.text ?? e?.text ?? "";
  return typeof raw === "string" ? raw.replace(/\[[0-9;]*m/g, "").replace(/\s+$/, "") : "";
}

/**
 * Reduce a build-log event stream to the lines worth reading.
 *
 * `errorsOnly` keeps stderr plus any line that names a failure, and then keeps
 * CONTEXT_LINES of preceding output with each hit. The context is not
 * decoration: a bare "Command \"pnpm build\" exited with 1" names no file, and
 * the TypeScript error that caused it is three lines above on stdout. A filter
 * that dropped those would send the session back to Tom just as reliably as
 * having no log at all.
 */
export const CONTEXT_LINES = 4;

const FAILURE_RE =
  /\b(error|failed|failure|exited with|cannot find|not found|unresolved|Type error|ELIFECYCLE|panic)\b/i;

export function filterLogEvents(events, { errorsOnly = true, limit = null } = {}) {
  const all = (Array.isArray(events) ? events : [])
    .map((e) => ({ type: e?.type ?? "stdout", created: e?.created ?? 0, text: eventText(e) }))
    .filter((e) => e.text !== "");
  let chosen = all;
  if (errorsOnly) {
    const keep = new Set();
    all.forEach((e, i) => {
      if (e.type === "stderr" || FAILURE_RE.test(e.text)) {
        for (let j = Math.max(0, i - CONTEXT_LINES); j <= i; j++) keep.add(j);
      }
    });
    // Nothing matched — a build can fail with a clean log (a timeout, a
    // cancelled queue entry). Falling back to the whole tail beats printing
    // nothing and implying the log was empty.
    chosen = keep.size === 0 ? all : all.filter((_, i) => keep.has(i));
  }
  if (limit && chosen.length > limit) chosen = chosen.slice(-limit);
  return chosen;
}

export function formatLogEvents(events) {
  if (events.length === 0) return "(no build log events)";
  return events.map((e) => `${e.type === "stderr" ? "! " : "  "}${e.text}`).join("\n");
}

export function formatDeployments(deployments) {
  if (!deployments || deployments.length === 0) return "(no deployments)";
  return deployments
    .map((d) => {
      const when = d?.created ? new Date(d.created).toISOString().replace(".000Z", "Z") : "?";
      const branch = deploymentBranch(d) ?? "-";
      const msg = (d?.meta?.githubCommitMessage ?? "").split("\n")[0].slice(0, 60);
      return [
        deploymentState(d).padEnd(9),
        when,
        branch.padEnd(24).slice(0, 24),
        deploymentId(d) ?? "-",
        msg,
      ].join("  ");
    })
    .join("\n");
}

/** Human-readable one-liner for a selected deployment, printed before its log. */
export function describeDeployment(d) {
  return [
    `deployment ${deploymentId(d)}`,
    `state      ${deploymentState(d)}`,
    `branch     ${deploymentBranch(d) ?? "-"}`,
    `url        ${d?.url ? `https://${d.url}` : "-"}`,
  ].join("\n");
}
