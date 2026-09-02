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
  // Absent whenever the exporter had no scored run for the mode: every ground
  // truth mode, and also the prediction modes it exports without a metrics
  // block (in the committed manifest: pred_pointnet, pred_pointnet2,
  // pred_floor_pole, pred_ransac_floor). Read it as optional for every mode,
  // never as "present iff prediction".
  metrics?: MetricEntry[];
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

// The only manifest layout the types below describe. manifest.json is written
// by another repository (ML_Final_Project), so a format change can land here
// as a file swap with no code change; fetchManifest refuses any other value
// rather than rendering a page from fields it has guessed at.
export const SUPPORTED_MANIFEST_VERSION = 1;

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
