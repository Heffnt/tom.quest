// transport.mjs — how the run jobs reach the Convex site.
//
// The sweep, the backlog and the materializer each carried their own copy of
// this function, byte-identical in the first two. One copy is what makes the
// two things below true everywhere instead of in one job.
//
// A named cause. A network-level failure — a DNS answer that does not come, a
// connection reset, a TLS abort — reaches Node as a bare `fetch failed`, with
// the real code buried in `error.cause`. Every run job printed that bare
// string, so /var/log/tts read identically on a dead route and on a dropped
// packet, and no reading of the log could name what broke. The give-up error
// carries the cause chain.
//
// A bounded retry. Measured on the box over 2026-09-15..17: 202 of 2075 sweep
// passes (9.7%) died on their first request, and the sweep's own timestamped
// log dates them — 136 failure windows, of which 91 were a single missed pass
// and 120 were cleared inside four minutes, none of them overnight. A failure
// the next pass two minutes later does not see is transient by definition, so
// the request is worth trying again inside the pass rather than losing the
// pass. Three tries over about eight seconds; past that the job gives up and
// says so, because a real outage should not be hidden by waiting.
//
// Retrying a POST is safe here because redelivery is already the design: the
// sweep's spool re-sends the same ingest page on the next pass after any
// failure, so every route these jobs post to already tolerates seeing a body
// twice, and the /tts/job-ok and /tts/job-failed routes are keyed.

export const TRANSPORT_TRIES = 3;

export function transportBackoffMs(attempt) {
  return attempt === 0 ? 2000 : 6000;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// undici nests the real error one or two levels down, and a dual-stack attempt
// nests one per address family. The depth is bounded because a cause chain may
// be circular, and the truthiness test stays because a cause node carrying
// none of the three fields would otherwise put the word "undefined" in the log
// where the code belongs — worse to read than the short chain it is dropped
// from.
export function causeChain(error) {
  const labels = [];
  let cause = error?.cause;
  for (let depth = 0; cause && depth < 4; depth += 1) {
    const label = cause.code ?? cause.errno ?? cause.name;
    if (label) labels.push(String(label));
    cause = cause.cause;
  }
  return labels.join(" <- ");
}

const siteUrl = (config, route) => `${config.convexSiteUrl.replace(/\/+$/, "")}${route}`;

const isRunRoute = (route) => route.startsWith("/runs/");

const keyFor = (config, route) => (isRunRoute(route) ? config.sessionsKey : config.ttsKey);

const keyHeader = (route) => (isRunRoute(route) ? "X-Sessions-Key" : "X-TTS-Key");

const missing = (route) => new Error(`missing variables for ${isRunRoute(route) ? "run ingest" : "TTS event"}`);

// An HTTP answer, however bad, is an answer: it throws with its status and is
// never retried. Only a throw from fetch itself — no answer at all — is.
async function sendJson(url, init, route, {
  fetchImpl = fetch,
  sleep = defaultSleep,
  tries = TRANSPORT_TRIES,
  backoffMs = transportBackoffMs,
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (attempt + 1 < tries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      // A chain that names nothing still has to say so: "fetch failed ()" in
      // the log would read as a truncation rather than as what it is.
      //
      // THE MESSAGE IS THE WHOLE INTERFACE. The give-up error also carried
      // `transport: true` and `tries`, and nothing ever read either: every
      // caller logs the message and gives up its pass, and both facts are
      // already in the sentence. `cause` stays, because it is the chain
      // `causeChain` walks and the one thing a reader can go deeper into.
      const chain = causeChain(error);
      throw Object.assign(
        new Error(`${route} could not reach the site in ${tries} tries: ${String(error?.message ?? error)} (${chain || "cause unnamed"})`),
        { cause: error },
      );
    }
    if (!response.ok) throw Object.assign(new Error(`${route} failed with HTTP ${response.status}`), { status: response.status });
    return await response.json();
  }
}

export async function postJson(config, route, body, options = {}) {
  const key = keyFor(config, route);
  if (!config.convexSiteUrl || !key) throw missing(route);
  return await sendJson(siteUrl(config, route), {
    method: "POST",
    headers: { "Content-Type": "application/json", [keyHeader(route)]: key },
    body: JSON.stringify(body),
  }, route, options);
}

export async function getJson(config, route, options = {}) {
  const key = keyFor(config, route);
  if (!config.convexSiteUrl || !key) throw missing(route);
  return await sendJson(siteUrl(config, route), { headers: { [keyHeader(route)]: key } }, route, options);
}
