#!/usr/bin/env node
// vercel-build.mjs — the Vercel build command, which differs by environment.
//
// THE PROBLEM THIS SOLVES. Vercel built every environment with
// `npx convex deploy --cmd 'pnpm build'`. On a PREVIEW build the Convex CLI
// refuses, by design:
//
//   Detected a non-production build environment and "CONVEX_DEPLOY_KEY" for a
//   production Convex deployment. This is probably unintentional.
//
// It is right to refuse. tom.quest has ONE Convex deployment (prod) by ratified
// policy, so CONVEX_DEPLOY_KEY is a production key, and a preview build running
// `convex deploy` would push the functions of an unmerged PR branch straight to
// production — exactly what "function and schema changes go live only on
// explicit deploy" forbids. The CLI's guard was the only thing stopping it.
//
// The consequence was that the Vercel check failed on EVERY session PR (23-28
// were all red on 2026-08-30, while main was green). A permanently red check
// carries no signal: a PR that genuinely breaks the build looks exactly like
// the standing failure.
//
// SO: production deploys Convex and then builds, exactly as before. Every other
// environment builds Next.js ALONE — which is the half that can actually fail
// on a PR, and now the half the check reports on.
//
// A preview build points at prod Convex, because that is the only deployment
// there is. That is the same posture `next dev` already has (AGENTS.md: "next
// dev runs locally against prod Convex"), not a new one — and it is why the
// preview is a real, clickable copy of the PR's UI.

import { spawnSync } from "node:child_process";

// Vercel sets VERCEL=1 on every build and VERCEL_ENV to one of
// production | preview | development.
const onVercel = process.env.VERCEL === "1" || process.env.VERCEL === "true";
const env = process.env.VERCEL_ENV;

// Fail loudly rather than guessing. If we are on Vercel and cannot tell which
// environment this is, the two branches below differ by "does production get
// its Convex functions deployed" — and silently choosing the wrong one ships a
// frontend whose backend was never updated. That is the silent-default this
// repo's fail-loud rule exists to refuse.
if (onVercel && env === undefined) {
  console.error(
    "vercel-build: running on Vercel but VERCEL_ENV is unset, so this build " +
      "cannot tell production from preview. Refusing to guess.",
  );
  process.exit(1);
}

// Kept byte-identical to the command this replaces (AGENTS.md, Deployment):
// push Convex functions to prod, then build Next.js.
const PRODUCTION = "npx convex deploy --cmd 'pnpm build'";
const PREVIEW = "pnpm build";

const command = env === "production" ? PRODUCTION : PREVIEW;
console.log(
  `vercel-build: VERCEL_ENV=${env ?? "(none — local run)"} → ${command}`,
);

const result = spawnSync(command, { stdio: "inherit", shell: true });
process.exit(result.status ?? 1);
