// Which roles every Tom-gated page and gated route handler admits, recorded
// before the gate code was refactored and required to hold unchanged after it.
// Its Convex twin is convex/accessRecord.test.ts.
//
// THREE LAYERS, each driven through its real code for each role (signed out,
// user, admin, agent, tom):
//   1. The page list: which pages the home list and navigation autocomplete
//      offer the role (rankPages).
//   2. The page render: each page client that sits behind the Tom gate,
//      rendered inside the real AuthProvider with Convex stood in. Recorded:
//      the restricted card's text, or "admitted"; every Convex query the page
//      subscribes to without "skip"; every mutation it fires on arrival.
//   3. The route handlers under /api/turing, with the real role guards and
//      only the Convex client and the cluster call stood in. Recorded: the
//      refusal's status and message, or "admitted".
//
// The record is literal on purpose: a test that re-derives its expectation
// from the gate code would pass whatever the gate code did.

import { Component, type ReactNode } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ROLES = ["guest", "user", "admin", "agent", "tom"] as const;
type Role = (typeof ROLES)[number];

const state = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_CONVEX_URL ??= "https://access-record.convex.cloud";
  return {
    role: "guest" as "guest" | "user" | "admin" | "agent" | "tom",
    queries: new Set<string>(),
    mutations: new Set<string>(),
  };
});

function viewerFor(role: Role) {
  if (role === "guest") return null;
  return {
    _id: `${role}-id`,
    name: role,
    email: `${role}@tom.quest`,
    role,
    isAdmin: role === "admin" || role === "tom",
    isTom: role === "tom",
    isAgent: role === "agent",
  };
}

vi.mock("@sentry/nextjs", () => ({ setUser: () => {} }));

vi.mock("@convex-dev/auth/react", () => ({
  ConvexAuthProvider: ({ children }: { children: ReactNode }) => children,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: state.role !== "guest" }),
  useAuthToken: () => (state.role === "guest" ? null : "token"),
  useAuthActions: () => ({ signIn: async () => {}, signOut: async () => {} }),
}));

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  const { getFunctionName } = await import("convex/server");
  const name = (ref: unknown) => getFunctionName(ref as never);
  return {
    ...actual,
    ConvexReactClient: class {},
    useQuery: (ref: unknown, args?: unknown) => {
      const fn = name(ref);
      if (fn === "users:viewer") return viewerFor(state.role);
      if (args === "skip") return undefined;
      state.queries.add(fn);
      // An empty todo list lets /jarvis reach the write it fires on arrival.
      return fn === "tts:listTodos" ? [] : undefined;
    },
    usePaginatedQuery: (ref: unknown, args?: unknown) => {
      if (args !== "skip") state.queries.add(name(ref));
      return { results: [], status: "LoadingFirstPage", isLoading: true, loadMore: () => {} };
    },
    useMutation: (ref: unknown) => {
      const fn = async () => {
        state.mutations.add(name(ref));
      };
      return Object.assign(fn, { withOptimisticUpdate: () => fn });
    },
    useAction: (ref: unknown) => async () => {
      state.mutations.add(name(ref));
    },
    useConvex: () => ({ query: async () => undefined, mutation: async () => undefined }),
    useConvexConnectionState: () => ({ isWebSocketConnected: true }),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
  useParams: () => ({}),
  redirect: () => {},
  notFound: () => {},
}));

// The route layer's two stand-ins: the Convex client that answers
// api.users.viewer for the bearer token, and the cluster.
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    async query() {
      return viewerFor(state.role);
    }
  },
}));

vi.mock("@/app/lib/turing", () => ({
  forwardToTuringApi: async () =>
    new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
  signWsToken: () => ({ token: "t" }),
}));

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <p>page body failed under the stand-ins</p> : this.props.children;
  }
}

afterEach(() => {
  cleanup();
  state.queries.clear();
  state.mutations.clear();
});

// ---------------------------------------------------------------------------
// 1. The page list.

describe("the page list", () => {
  it("offers each role the pages it offered before the gate refactor", async () => {
    const { rankPages } = await import("@/app/components/page-routes");
    const actual = Object.fromEntries(
      ROLES.map((role) => [role, rankPages("", role).map((page) => page.slug).sort()]),
    );
    expect(actual).toEqual({
      guest: ["bio", "boolback", "clouds", "game", "help", "perfume", "thmm", "transformer"],
      user: ["bio", "boolback", "canvas", "clouds", "game", "help", "perfume", "thmm", "transformer"],
      admin: ["bio", "boolback", "canvas", "clouds", "game", "help", "perfume", "thmm", "transformer", "turing"],
      agent: ["jarvis", "turing"],
      tom: [
        "agents", "bio", "boolback", "canvas", "clouds", "forge", "game", "help", "intent",
        "jarvis", "log", "logo", "perfume", "questions", "secrets", "thmm", "transformer", "turing",
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// 2. The page render.

type Rendered = { gate: string; queries: string[]; mutations: string[] };

const CARD = /(\S[^.]*) access is restricted to Tom\./;

async function renderAs(role: Role, load: () => Promise<{ default: () => ReactNode }>): Promise<Rendered> {
  state.role = role;
  state.queries.clear();
  state.mutations.clear();
  const { AuthProvider } = await import("@/app/lib/auth");
  const Page = (await load()).default;
  let container!: HTMLElement;
  await act(async () => {
    ({ container } = render(
      <AuthProvider>
        <Boundary>
          <Page />
        </Boundary>
      </AuthProvider>,
    ));
  });
  const card = container.textContent?.match(CARD);
  const out = {
    gate: card ? card[0] : "admitted",
    queries: [...state.queries].sort(),
    mutations: [...state.mutations].sort(),
  };
  cleanup();
  return out;
}

const PAGE_CLIENTS: Record<string, () => Promise<{ default: () => ReactNode }>> = {
  agents: () => import("@/app/agents/agents-client"),
  forge: () => import("@/app/forge/forge-client"),
  intent: () => import("@/app/intent/intent-client"),
  jarvis: () => import("@/app/jarvis/jarvis-client"),
  log: () => import("@/app/log/log-client"),
  questions: () => import("@/app/questions/questions-client"),
  secrets: () => import("@/app/secrets/secrets-client"),
};

const refused = (card: string): Rendered => ({ gate: card, queries: [], mutations: [] });
const admitted = (queries: string[], mutations: string[]): Rendered => ({ gate: "admitted", queries, mutations });

const PAGE_RECORD: Record<string, Record<Role, Rendered>> = {
  agents: {
    guest: refused("Agents access is restricted to Tom."),
    user: refused("Agents access is restricted to Tom."),
    admin: refused("Agents access is restricted to Tom."),
    agent: refused("Agents access is restricted to Tom."),
    tom: admitted(["claudeSessions:getDaemonHealth", "claudeSessions:listSessions", "jarvis/events:recent"], []),
  },
  forge: {
    guest: refused("Forge access is restricted to Tom."),
    user: refused("Forge access is restricted to Tom."),
    admin: refused("Forge access is restricted to Tom."),
    agent: refused("Forge access is restricted to Tom."),
    tom: admitted(["forge:listMine"], []),
  },
  intent: {
    guest: refused("Intent access is restricted to Tom."),
    user: refused("Intent access is restricted to Tom."),
    admin: refused("Intent access is restricted to Tom."),
    agent: refused("Intent access is restricted to Tom."),
    tom: admitted(["intent:agentView", "intent:lines", "jarvis/intent:decisions", "jarvis/intent:evalItems", "vocabulary:current"], []),
  },
  jarvis: {
    guest: refused("TTS access is restricted to Tom."),
    user: refused("TTS access is restricted to Tom."),
    admin: refused("TTS access is restricted to Tom."),
    agent: admitted(["tts:listMirror", "tts:listTimeNotes", "tts:listTodos", "ttsCode:listCodeBriefs", "ttsRulings:listRulings"], []),
    tom: admitted(["tts:listMirror", "tts:listTimeNotes", "tts:listTodos", "ttsCode:listCodeBriefs", "ttsRulings:listRulings"], ["tts:recordEvent"]),
  },
  log: {
    guest: refused("Log access is restricted to Tom."),
    user: refused("Log access is restricted to Tom."),
    admin: refused("Log access is restricted to Tom."),
    agent: refused("Log access is restricted to Tom."),
    tom: admitted(["dayLog:page", "dayLog:series", "dayLog:trainingDay"], []),
  },
  questions: {
    guest: refused("Questions access is restricted to Tom."),
    user: refused("Questions access is restricted to Tom."),
    admin: refused("Questions access is restricted to Tom."),
    agent: refused("Questions access is restricted to Tom."),
    tom: admitted(["userSettings:get"], []),
  },
  secrets: {
    guest: refused("Secrets access is restricted to Tom."),
    user: refused("Secrets access is restricted to Tom."),
    admin: refused("Secrets access is restricted to Tom."),
    agent: refused("Secrets access is restricted to Tom."),
    tom: admitted(["secrets:list"], []),
  },
};

describe("the page render", () => {
  it("admits, subscribes and writes for each role as before the gate refactor", async () => {
    const actual: Record<string, Record<Role, Rendered>> = {};
    for (const [slug, load] of Object.entries(PAGE_CLIENTS)) {
      const row = {} as Record<Role, Rendered>;
      for (const role of ROLES) row[role] = await renderAs(role, load);
      actual[slug] = row;
    }
    expect(actual).toEqual(PAGE_RECORD);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 3. The route handlers.

async function callRoute(role: Role, method: "GET" | "POST" | "DELETE", path: string): Promise<string> {
  state.role = role;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (role !== "guest") headers.Authorization = "Bearer token";
  const url = `http://localhost/api/turing/${path}`;
  const request = new NextRequest(url, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify({ job_name: "x" }),
  });
  let response: Response;
  if (path.startsWith("ws-credentials")) {
    const route = await import("@/app/api/turing/ws-credentials/route");
    response = await route.GET(request);
  } else {
    const route = await import("@/app/api/turing/[...path]/route");
    const ctx = { params: Promise.resolve({ path: path.split("?")[0].split("/") }) };
    response = await route[method](request, ctx);
  }
  if (response.status === 401 || response.status === 403) {
    const body = (await response.json()) as { error?: string };
    return `${response.status} ${body.error}`;
  }
  return "admitted";
}

describe("the /api/turing route handlers", () => {
  it("admit each role as before the gate refactor", async () => {
    const calls = [
      ["GET /api/turing/jobs", "GET", "jobs"],
      ["POST /api/turing/allocate", "POST", "allocate"],
      ["DELETE /api/turing/jobs/1", "DELETE", "jobs/1"],
      ["GET /api/turing/ws-credentials", "GET", "ws-credentials?session=s"],
    ] as const;
    const actual: Record<string, Record<Role, string>> = {};
    for (const [label, method, path] of calls) {
      const row = {} as Record<Role, string>;
      for (const role of ROLES) row[role] = await callRoute(role, method, path);
      actual[label] = row;
    }
    const AUTH = "401 Authentication required";
    const ADMIN = "403 Admin access required";
    const A = "admitted";
    expect(actual).toEqual({
      "GET /api/turing/jobs": { guest: AUTH, user: ADMIN, admin: A, agent: A, tom: A },
      "POST /api/turing/allocate": { guest: AUTH, user: ADMIN, admin: A, agent: ADMIN, tom: A },
      "DELETE /api/turing/jobs/1": { guest: AUTH, user: ADMIN, admin: A, agent: ADMIN, tom: A },
      "GET /api/turing/ws-credentials": { guest: AUTH, user: ADMIN, admin: A, agent: ADMIN, tom: A },
    });
  });
});
