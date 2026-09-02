import { SUPPORTED_MANIFEST_VERSION } from "./types";
import type { CloudHeader, DType, ParsedCloud, Manifest } from "./types";

const DTYPE_CTOR: Record<DType, new (buf: ArrayBuffer, offset: number, length: number) => ArrayBufferView> = {
  float32: Float32Array,
  uint8: Uint8Array,
  uint16: Uint16Array,
  uint32: Uint32Array,
  int32: Int32Array,
};

export async function fetchManifest(url: string): Promise<Manifest> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  const body: unknown = await res.json();
  return checkManifestVersion(body, url);
}

// The manifest is a static file written by another repository, so a format
// change reaches this page as a swapped file and never as a type error. Refuse
// anything but the one version these types describe: a named failure on load
// beats a viewer drawn from misread fields.
export function checkManifestVersion(body: unknown, url: string): Manifest {
  const version = (body as { version?: unknown } | null)?.version;
  if (version !== SUPPORTED_MANIFEST_VERSION) {
    throw new Error(
      `${url}: manifest version ${JSON.stringify(version)} is not supported ` +
        `(this page reads version ${SUPPORTED_MANIFEST_VERSION}); ` +
        `re-export the clouds or update app/clouds/lib/types.ts`,
    );
  }
  return body as Manifest;
}

export async function fetchCloud(url: string): Promise<ParsedCloud> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  return parseCloud(buf);
}

function parseCloud(buf: ArrayBuffer): ParsedCloud {
  const view = new DataView(buf);
  const headerLen = view.getUint32(0, true);
  const headerBytes = new Uint8Array(buf, 4, headerLen);
  const header: CloudHeader = JSON.parse(new TextDecoder().decode(headerBytes));
  const dataStart = 4 + headerLen;

  const channels: Record<string, ArrayBufferView> = {};
  for (const ch of header.channels) {
    const ctor = DTYPE_CTOR[ch.dtype];
    if (!ctor) throw new Error(`unknown dtype ${ch.dtype}`);
    const totalCount = ch.shape.reduce((a, b) => a * b, 1);
    channels[ch.name] = new ctor(buf, dataStart + ch.offset, totalCount);
  }

  const xyz = channels.xyz as Float32Array | undefined;
  if (!xyz) throw new Error("cloud missing xyz channel");

  return { n: header.n, channels, xyz };
}
