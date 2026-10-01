import { describe, expect, it, vi } from "vitest";

vi.mock("convex/react", () => ({ useQuery: () => undefined, useMutation: () => undefined }));
vi.mock("@/convex/_generated/api", () => ({ api: { push: { vapidPublicKey: "vapidPublicKey", saveSubscription: "saveSubscription", requestTest: "requestTest" } } }));
vi.mock("@/app/lib/auth", () => ({ useAuth: () => ({ isTom: true }) }));
vi.mock("@/app/components/tom-gate", () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock("@/app/jarvis/components/info", () => ({ default: () => null }));

import { base64UrlToBytes } from "./push-client";

describe("base64UrlToBytes", () => {
  it("decodes base64url with - and _ and no padding to the expected bytes", () => {
    // >÷©÷: base64url of the five bytes 0xfe, 0xef, 0xa9, 0xf7, 0xfa.
    expect(Array.from(base64UrlToBytes("_u-p9_o"))).toEqual([0xfe, 0xef, 0xa9, 0xf7, 0xfa]);
  });
});
