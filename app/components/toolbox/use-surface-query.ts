"use client";

// A page's one way to read a query. The query runs only when this viewer may
// read `surface` (app/lib/auth canReadSurface: Tom always, the agent account
// only for the surfaces convex/agentSurfaces.ts lists), and is skipped
// otherwise, so a Tom-only query on an agent-readable page answers undefined
// for the headless browser instead of throwing out of the render.

import { useQuery, type OptionalRestArgsOrSkip } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useAuth } from "@/app/lib/auth";

export function useSurfaceQuery<Q extends FunctionReference<"query">>(
  surface: string,
  query: Q,
  args: Q["_args"],
): Q["_returnType"] | undefined {
  const { canReadSurface } = useAuth();
  const rest = (canReadSurface(surface) ? [args] : ["skip"]) as OptionalRestArgsOrSkip<Q>;
  return useQuery(query, ...rest);
}
