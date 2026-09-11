// Vectors: AWS's SigV4 test suite get-vanilla files mirrored in boto/botocore,
// and Amazon S3's "Example: GET Object" header-authentication documentation.
import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createS3Client, signAwsRequest } from "../s3.mjs";
import { openStore } from "../store.mjs";

const TEST_KEY_ID = "AKIDEXAMPLE";
const SUITE_SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const S3_DOC_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

describe("S3 SigV4", () => {
  it("matches AWS's get-vanilla canonical request, string, and signature", () => {
    const signed = signAwsRequest({ method: "GET", url: "https://example.amazonaws.com/", headers: {}, body: Buffer.alloc(0), keyId: TEST_KEY_ID, secret: SUITE_SECRET, region: "us-east-1", service: "service", amzDate: "20150830T123600Z" });
    expect(signed.canonicalRequest).toBe("GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(signed.stringToSign).toBe("AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63");
    expect(signed.signature).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });

  it("matches Amazon S3's documented GET Object signature", () => {
    const signed = signAwsRequest({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", headers: { range: "bytes=0-9", "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }, keyId: "AKIAIOSFODNN7EXAMPLE", secret: S3_DOC_SECRET, region: "us-east-1", amzDate: "20130524T000000Z" });
    expect(signed.signature).toBe("f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  it("keeps write and read credentials on their own verbs", async () => {
    const seen = [];
    const fetch = vi.fn(async (_url, init) => { seen.push([init.method, init.headers.Authorization]); return new Response("body", { status: 200 }); });
    const client = createS3Client({ endpoint: "https://objects.example.test", bucket: "bucket", region: "region", writeCredential: { keyId: "WRITE_TEST_KEY", secret: "write-test-secret" }, readCredential: { keyId: "READ_TEST_KEY", secret: "read-test-secret" }, fetch, now: () => new Date("2026-01-01T00:00:00Z") });
    await client.putObject({ key: "runs/a", body: Buffer.from("a") });
    await client.getObject({ key: "runs/a" });
    await client.headObject({ key: "runs/a" });
    expect(seen[0]).toEqual(["PUT", expect.stringContaining("WRITE_TEST_KEY")]);
    expect(seen.slice(1).every(([method, auth]) => ["GET", "HEAD"].includes(method) && auth.includes("READ_TEST_KEY") && !auth.includes("WRITE_TEST_KEY"))).toBe(true);
  });

  it("accepts an echoed checksum and refuses a mismatch", async () => {
    const matching = async (_url, init) => new Response(null, { status: 200, headers: { "x-amz-checksum-sha256": crypto.createHash("sha256").update(init.body).digest("base64") } });
    const config = { endpoint: "https://objects.example.test", bucket: "bucket", region: "region", writeCredential: { keyId: "WRITE_TEST_KEY", secret: "write-test-secret" }, fetch: matching };
    const stored = await openStore({ backend: "s3", s3: config }).put({ runtime: "claude", host: "laptop", threadId: "thread", sourceBytes: Buffer.from("run\n") });
    expect(stored).toMatchObject({ verified: true, key: expect.stringMatching(/^runs\//) });
    const mismatch = { ...config, fetch: async () => new Response(null, { status: 200, headers: { "x-amz-checksum-sha256": "not-the-checksum" } }) };
    await expect(openStore({ backend: "s3", s3: mismatch }).put({ runtime: "claude", host: "laptop", threadId: "thread", sourceBytes: Buffer.from("run\n") })).rejects.toThrow("checksum verification failed");
  });

  it("returns no store key when neither echo nor reader can verify", async () => {
    const stored = await openStore({ backend: "s3", s3: { endpoint: "https://objects.example.test", bucket: "bucket", region: "region", writeCredential: { keyId: "WRITE_TEST_KEY", secret: "write-test-secret" }, fetch: async () => new Response(null, { status: 200 }) } }).put({ runtime: "codex", host: "box", threadId: "thread", sourceBytes: Buffer.from("run\n") });
    expect(stored.verified).toBe(false);
    expect(stored.key).toBeUndefined();
  });

  it("never places credentials in a URL or a sanitized failure", async () => {
    const urls = []; const logs = [];
    const secret = "private-test-value";
    const client = createS3Client({ endpoint: "https://objects.example.test", bucket: "bucket", region: "region", writeCredential: { keyId: "WRITE_TEST_KEY", secret }, fetch: async (url) => { urls.push(String(url)); throw new Error(`transport ${secret}`); }, sleep: async () => {}, backoffMs: () => 0 });
    try { await client.putObject({ key: "runs/a", body: Buffer.from("a") }); } catch (error) { logs.push(error.message); }
    expect(JSON.stringify([urls, logs])).not.toContain(secret);
  });
});
