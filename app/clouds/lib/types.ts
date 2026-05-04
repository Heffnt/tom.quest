// Types mirror the manifest.json + binary header schema produced by
// ML_Final_Project's pipeline/export/web_export.py.

export type DType = "float32" | "uint8" | "uint16" | "uint32" | "int32";

export type ChannelDesc = {
  name: string;
  dtype: DType;
  shape: number[];
  offset: number;
};

export type CloudHeader = {
  n: number;
  channels: ChannelDesc[];
};

export type PaletteEntry = {
  id: number;
  name: string;
  color: [number, number, number]; // 0..255
};

export type MetricEntry = {
  label: string;
  value: number;
};

export type ColorMode = {
  id: string;
  label: string;
  channel: string;
  palette: PaletteEntry[];
  metrics?: MetricEntry[]; // absent for GT modes
};

export type CloudMetaEntry = {
  url: string;
  n: number;       // points actually packed in the binary
  n_full: number;  // points in the original split before downsampling
};

export type SplitPlane = {
  axis: "x" | "y" | "z";
  axis_index: 0 | 1 | 2;
  value: number; // already in centered (post-centroid) world coordinates
};

export type Manifest = {
  version: number;
  centroid: [number, number, number];
  split_plane: SplitPlane;
  clouds: Record<string, CloudMetaEntry>;
  color_modes: ColorMode[];
};

// One decoded cloud. `channels` holds typed-array views over the same
// underlying ArrayBuffer the binary was fetched into -- zero copies.
export type ParsedCloud = {
  n: number;
  channels: Record<string, ArrayBufferView>;
  xyz: Float32Array;
};

export type CloudKey = "train" | "test";
