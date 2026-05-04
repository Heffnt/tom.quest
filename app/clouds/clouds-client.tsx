"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";

import { CloudPoints, SplitPlaneOverlay, type PointHover } from "./cloud-viewer";
import { ControlPanel } from "./control-panel";
import { FlyCamera, type FlyCameraHandle } from "./fly-camera";
import { Legend } from "./legend";
import { MetricsPanel } from "./metrics-panel";
import { PointHoverTooltip } from "./point-hover-tooltip";
import { fetchCloud, fetchManifest } from "./lib/parse-cloud";
import type { CloudKey, Manifest, ParsedCloud } from "./lib/types";

const MANIFEST_URL = "/data/clouds/manifest.json";

export default function CloudsClient() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [clouds, setClouds] = useState<Partial<Record<CloudKey, ParsedCloud>>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  // UI state
  const [cloudVisibility, setCloudVisibility] = useState<Record<CloudKey, boolean>>({
    train: true,
    test: true,
  });
  const [activeMode, setActiveMode] = useState<string>("pred_pointnet");
  const [pointRatio, setPointRatio] = useState<number>(0.3);
  const [pointSize, setPointSize] = useState<number>(0.06);
  const [moveSpeed, setMoveSpeed] = useState<number>(30);
  const [lookSpeed, setLookSpeed] = useState<number>(0.0025);
  const [showSplitPlane, setShowSplitPlane] = useState<boolean>(true);
  const [showTooltip, setShowTooltip] = useState<boolean>(true);
  const [hoveredPoint, setHoveredPoint] = useState<PointHover | null>(null);

  const flyRef = useRef<FlyCameraHandle | null>(null);

  // --- load manifest + binary clouds in parallel ---------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const m = await fetchManifest(MANIFEST_URL);
        if (cancelled) return;
        setManifest(m);
        const entries = await Promise.all(
          (Object.keys(m.clouds) as CloudKey[]).map(async (key) => {
            const url = `/data/clouds/${m.clouds[key].url}`;
            const cloud = await fetchCloud(url);
            return [key, cloud] as const;
          }),
        );
        if (cancelled) return;
        setClouds(Object.fromEntries(entries));
      } catch (e) {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const colorMode = useMemo(() => {
    if (!manifest) return null;
    return manifest.color_modes.find((m) => m.id === activeMode) ?? manifest.color_modes[0];
  }, [manifest, activeMode]);

  // Frame the camera around the loaded clouds. Computed once when clouds
  // arrive; the slider/mode changes don't reset framing.
  const cameraInit = useMemo(() => {
    const train = clouds.train;
    const test = clouds.test;
    const sources: ParsedCloud[] = [];
    if (train) sources.push(train);
    if (test) sources.push(test);
    if (sources.length === 0) return { position: [50, 50, 50] as [number, number, number], target: [0, 0, 0] as [number, number, number] };
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const src of sources) {
      const xyz = src.xyz;
      // Sample to keep this fast; full scan of 500k pts is also fine but unnecessary.
      const stride = Math.max(1, Math.floor(src.n / 50_000));
      for (let i = 0; i < src.n; i += stride) {
        const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
      }
    }
    const center: [number, number, number] = [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ];
    const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    // Offset camera off-axis at ~1.2x the longest extent so the cloud fills
    // roughly 60% of the viewport at fov=55.
    const d = extent * 0.7;
    const position: [number, number, number] = [
      center[0] + d * 0.7,
      center[1] - d * 0.5,
      center[2] + d * 1.2,
    ];
    return { position, target: center, extent };
  }, [clouds]);

  const handleResetCamera = () => flyRef.current?.reset();
  const handleSetShowTooltip = (next: boolean) => {
    setShowTooltip(next);
    if (!next) setHoveredPoint(null);
  };

  // Plane size for the split overlay -- a bit larger than the scene extent
  // so it visually spans the cloud.
  const planeSize: [number, number] = useMemo(() => {
    const e = cameraInit.extent ?? 100;
    return [e * 1.4, e * 1.4];
  }, [cameraInit.extent]);

  const isLoading = !manifest || Object.keys(clouds).length === 0;
  const hoveredCloud = hoveredPoint ? clouds[hoveredPoint.cloudKey] : undefined;

  return (
    <div className="relative w-full h-[calc(100vh-4rem)] bg-bg overflow-hidden">
      <Canvas
        camera={{
          position: cameraInit.position,
          fov: 55,
          near: 0.5,
          far: 5000,
          up: [0, 0, 1],
        }}
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
        style={{ background: "var(--color-bg)" }}
      >
        <FlyCamera
          ref={flyRef}
          initialPosition={cameraInit.position}
          initialTarget={cameraInit.target}
          moveSpeed={moveSpeed}
          setMoveSpeed={setMoveSpeed}
          lookSpeed={lookSpeed}
        />
        {colorMode &&
          (Object.keys(clouds) as CloudKey[]).map((key) => {
            const cloud = clouds[key];
            if (!cloud || !cloudVisibility[key]) return null;
            return (
              <CloudPoints
                key={key}
                cloudKey={key}
                cloud={cloud}
                colorMode={colorMode}
                pointSize={pointSize}
                visibleCount={Math.round(pointRatio * cloud.n)}
                onPointHover={(point) => {
                  if (showTooltip) setHoveredPoint(point);
                }}
                onPointLeave={() => setHoveredPoint(null)}
              />
            );
          })}
        {manifest && showSplitPlane && (
          <SplitPlaneOverlay splitPlane={manifest.split_plane} size={planeSize} />
        )}
      </Canvas>

      {manifest && colorMode && (
        <ControlPanel
          cloudVisibility={cloudVisibility}
          setCloudVisibility={setCloudVisibility}
          cloudMeta={manifest.clouds}
          colorModes={manifest.color_modes}
          activeMode={activeMode}
          setActiveMode={setActiveMode}
          pointRatio={pointRatio}
          setPointRatio={setPointRatio}
          cloudSizes={Object.fromEntries(
            (Object.keys(clouds) as CloudKey[]).map((k) => [k, clouds[k]?.n ?? 0]),
          )}
          pointSize={pointSize}
          setPointSize={setPointSize}
          moveSpeed={moveSpeed}
          setMoveSpeed={setMoveSpeed}
          lookSpeed={lookSpeed}
          setLookSpeed={setLookSpeed}
          showSplitPlane={showSplitPlane}
          setShowSplitPlane={setShowSplitPlane}
          showTooltip={showTooltip}
          setShowTooltip={handleSetShowTooltip}
          onResetCamera={handleResetCamera}
        />
      )}

      {colorMode && (
        <div className="absolute bottom-4 right-4 z-10 flex flex-row items-end gap-3">
          <MetricsPanel mode={colorMode} />
          <Legend mode={colorMode} />
        </div>
      )}

      {showTooltip && manifest && colorMode && hoveredPoint && hoveredCloud && (
        <PointHoverTooltip
          point={hoveredPoint}
          cloud={hoveredCloud}
          manifest={manifest}
          activeMode={colorMode}
        />
      )}

      <a
        href="https://data.ign.fr/benchmarks/UrbanAnalysis/"
        target="_blank"
        rel="noopener noreferrer"
        className="absolute top-4 right-4 z-10 rounded-md border border-border bg-surface/80 backdrop-blur-md px-3 py-1.5 text-xs font-mono text-text-muted hover:text-accent hover:border-accent/40 transition-colors animate-settle"
      >
        <span className="text-text-faint">dataset:</span>{" "}
        IQmulus &amp; TerraMobilita Contest <span aria-hidden>↗</span>
      </a>

      {isLoading && !loadError && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-text-muted text-sm font-mono animate-settle">
            loading point clouds…
          </div>
        </div>
      )}

      {loadError && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="max-w-md rounded-lg border border-error/40 bg-surface p-4 text-sm">
            <div className="font-display text-base text-error mb-2">Failed to load</div>
            <div className="text-text-muted font-mono">{loadError}</div>
          </div>
        </div>
      )}
    </div>
  );
}
