// The whole reach of the `agent` role, in one list.
//
// `agent` is the role of the account a TTS session's headless browser signs in
// as (worker/bin/tts-browse --login). A session changes a tom.quest page and
// then looks at the result; every interesting page is role-gated, so it has to
// sign in as somebody.
//
// `agent` is NOT a rank on the guest -> user -> admin -> tom ladder. roleAccess
// gives it isAdmin: false and isTom: false, so every gate written before this
// role existed denies it, without being touched. This list is the only thing
// that opens anything, and it opens READS only: no name here admits a mutation,
// an action, or a non-GET request. A session may look; it may not act.
//
// The two names are the two surfaces tts-browse's own header calls out --
// "every /turing and /tts page is role-gated" -- and they reuse the labels
// requireTom already passes ("TTS", "Sessions", "Forge"), so there is one
// vocabulary of surface names and not two.
//
// Widening the role is adding a name here. Deliberately absent today:
// "Sessions", "Forge", "Jarvis" (Tom's own surfaces), the /turing terminal and
// GPU-pool writes, and /canvas -- whose agent route spends LLM credits, and
// which `agent` would otherwise inherit for free by being signed in at all.
export const AGENT_READABLE_SURFACES = ["TTS", "Turing"] as const;

export type AgentReadableSurface = (typeof AGENT_READABLE_SURFACES)[number];

/** Whether the `agent` role may READ the surface named `label`. */
export function isAgentReadableSurface(label: string): boolean {
  return (AGENT_READABLE_SURFACES as readonly string[]).includes(label);
}

// The Turing surface needs a second, narrower list, because "Turing" as a page
// and "the Turing API" are not the same size.
//
// app/api/turing/[...path] is a catch-all onto the FastAPI service, and its
// GETs reach well past the dashboard: /file and /dirs read the cluster
// filesystem under TURING_FILE_ROOT, /cmt-file reads a second tree, and
// /sessions/{name}/output is the scrollback of Tom's terminal sessions. Those
// are reads, so a method check alone would hand every one of them to `agent`.
//
// These three are what the /turing page itself fetches, and they are therefore
// the whole of what "look at /turing" means: /gpu-report and /jobs from
// turing-client, /gpu-types from the allocate form. Anything else -- including
// every path added to the FastAPI service in future -- stays shut until it is
// named here.
export const AGENT_TURING_READS = ["/gpu-report", "/jobs", "/gpu-types"] as const;

/**
 * Whether the `agent` role may GET `upstreamPath` through the Turing proxy.
 * `upstreamPath` is the path alone, with any query string already stripped.
 */
export function isAgentTuringRead(upstreamPath: string): boolean {
  return (AGENT_TURING_READS as readonly string[]).includes(upstreamPath);
}
