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
  return (await res.json()) as Manifest;
}

export async function fetchCloud(url: string): Promise<ParsedCloud> {
  const res = await fetch(url, { cache: "force-cache" });
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
