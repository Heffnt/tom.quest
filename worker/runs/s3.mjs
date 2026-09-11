// s3.mjs — dependency-free AWS Signature Version 4 for the run store.
//
// The signing sequence follows Amazon S3's header-authentication examples:
// https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
// The generic get-vanilla vector used by the tests is mirrored by botocore at
// tests/unit/auth/aws4_testsuite/get-vanilla/ in the boto/botocore repository.

import crypto from "node:crypto";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const sha256Hex = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const hmac = (key, value, encoding) => crypto.createHmac("sha256", key).update(value).digest(encoding);

function canonicalHeaderValue(value) {
  return String(value).trim().replace(/\s+/g, " ");
}

function encodePathname(pathname) {
  return String(pathname || "/")
    .split("/")
    .map((part) => encodeURIComponent(decodeURIComponent(part)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/") || "/";
}

function canonicalQuery(query) {
  const params = new URLSearchParams(String(query).replace(/^\?/, ""));
  return [...params.entries()]
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)])
    .sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

export function canonicalRequest({ method, pathname = "/", query = "", headers = {}, payloadHash = EMPTY_SHA256 }) {
  const entries = Object.entries(headers)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => [name.toLowerCase(), canonicalHeaderValue(value)])
    .sort(([a], [b]) => a.localeCompare(b));
  const canonicalHeaders = entries.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = entries.map(([name]) => name).join(";");
  const value = `${String(method).toUpperCase()}\n${encodePathname(pathname)}\n${canonicalQuery(query)}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  return { value, signedHeaders, canonicalHeaders };
}

export function stringToSign({ amzDate, region, service = "s3", canonical }) {
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  return { value: `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256Hex(canonical)}`, scope };
}

export function signingKey({ secret, date, region, service = "s3" }) {
  const dateKey = hmac(`AWS4${secret}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

export function signAwsRequest({
  method,
  url,
  headers = {},
  body = Buffer.alloc(0),
  keyId,
  secret,
  region,
  service = "s3",
  amzDate,
}) {
  if (!keyId || !secret) throw new Error("S3 credential is not configured");
  const target = url instanceof URL ? new URL(url) : new URL(String(url));
  const dateValue = amzDate ?? new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const payloadHash = headers["x-amz-content-sha256"] ?? headers["X-Amz-Content-Sha256"] ?? sha256Hex(body);
  const signingHeaders = { ...headers, host: target.host, "x-amz-date": dateValue };
  const canonical = canonicalRequest({ method, pathname: target.pathname, query: target.search, headers: signingHeaders, payloadHash });
  const toSign = stringToSign({ amzDate: dateValue, region, service, canonical: canonical.value });
  const signature = hmac(signingKey({ secret, date: dateValue.slice(0, 8), region, service }), toSign.value, "hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${keyId}/${toSign.scope}, SignedHeaders=${canonical.signedHeaders}, Signature=${signature}`;
  return {
    canonicalRequest: canonical.value,
    stringToSign: toSign.value,
    signature,
    signedHeaders: canonical.signedHeaders,
    headers: { ...signingHeaders, Authorization: authorization },
  };
}

function safeObjectKey(key) {
  const parts = String(key).split("/");
  if (!key || parts.some((part) => !part || part === "." || part === "..")) throw new Error("invalid S3 object key");
  return parts.map(encodeURIComponent).join("/");
}

export function objectUrl({ endpoint, bucket, key, forcePathStyle = true }) {
  if (!endpoint || !bucket) throw new Error("S3 endpoint and bucket are required");
  const target = new URL(endpoint);
  if (target.username || target.password || target.search || target.hash) throw new Error("invalid S3 endpoint");
  const base = target.pathname.replace(/\/+$/, "");
  const object = safeObjectKey(key);
  if (forcePathStyle) target.pathname = `${base}/${encodeURIComponent(bucket)}/${object}`;
  else {
    target.hostname = `${bucket}.${target.hostname}`;
    target.pathname = `${base}/${object}`;
  }
  return target;
}

function retryDelay(attempt) {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A verb-separated client: the uploader can PUT and the reader can GET/HEAD. */
export function createS3Client({
  endpoint,
  bucket,
  region,
  forcePathStyle = true,
  writeCredential,
  readCredential,
  fetch: fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  backoffMs = retryDelay,
  now = () => new Date(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is required for the S3 run store");
  if (!region) throw new Error("S3 region is required");

  async function request({ method, key, body = Buffer.alloc(0), checksumSha256 }) {
    const upper = String(method).toUpperCase();
    const credential = upper === "PUT" ? writeCredential : ["GET", "HEAD"].includes(upper) ? readCredential : null;
    if (!credential) throw new Error(upper === "PUT" ? "S3 uploader is not configured" : "S3 reader is not configured");
    const url = objectUrl({ endpoint, bucket, key, forcePathStyle });
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const contentHash = sha256Hex(bytes);
    const headers = { "x-amz-content-sha256": contentHash };
    if (upper === "PUT") headers["x-amz-checksum-sha256"] = checksumSha256 ?? Buffer.from(contentHash, "hex").toString("base64");
    const amzDate = now().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const signed = signAwsRequest({ method: upper, url, headers, body: bytes, keyId: credential.keyId, secret: credential.secret, region, amzDate });
    // Fetch owns Host; its value is still in the canonical request through the
    // URL, while every other signed header is sent byte-for-byte.
    const requestHeaders = { ...signed.headers };
    delete requestHeaders.host;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetchImpl(url, { method: upper, headers: requestHeaders, ...(upper === "PUT" ? { body: bytes } : {}) });
        if (response.ok || (upper === "HEAD" && response.status === 404)) return response;
        if (response.status < 500 || attempt === 2) throw Object.assign(new Error(`S3 ${upper} failed with HTTP ${response.status} for ${key}`), { status: response.status });
        lastError = new Error(`S3 ${upper} failed with HTTP ${response.status} for ${key}`);
      } catch (error) {
        if (typeof error?.status === "number" && error.status < 500) throw error;
        lastError = error;
        if (attempt === 2) break;
      }
      await sleep(backoffMs(attempt));
    }
    const suffix = typeof lastError?.status === "number" ? `HTTP ${lastError.status}` : "network error";
    throw new Error(`S3 ${upper} failed with ${suffix} for ${key}`);
  }

  return {
    hasReader: Boolean(readCredential?.keyId && readCredential?.secret),
    putObject: ({ key, body, checksumSha256 }) => request({ method: "PUT", key, body, checksumSha256 }),
    getObject: ({ key }) => request({ method: "GET", key }),
    headObject: ({ key }) => request({ method: "HEAD", key }),
  };
}

export { EMPTY_SHA256 };
