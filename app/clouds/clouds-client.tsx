"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

import { CloudPoints, SplitPlaneOverlay } from "./cloud-viewer";
import { ControlPanel } from "./control-panel";
import { Legend } from "./legend";
import { fetchCloud, fetchManifest } from "./lib/parse-cloud";
import type { CloudKey, Manifest, ParsedCloud } from "./lib/types";

const MANIFEST_URL = "/data/clouds/manifest.json";

// THREE.Raycaster has no notion of "Points" thickness -- without a
// threshold, no click ever hits a Points object (points are mathematically
// dimensionless). Scaling the threshold with camera distance keeps clicks
// feeling "tight" up close and "forgiving" when zoomed out, where each
// rendered point covers more world units per pixel.
function DynamicRaycasterThreshold({ pointSize }: { pointSize: number }) {
  const { raycaster, camera, controls } = useThree();
  useEffect(() => {
    const update = () => {
      // Approximate distance from camera to the orbit target (or origin).
      const target = (controls as OrbitControlsImpl | null)?.target ?? new THREE.Vector3();
      const dist = camera.position.distanceTo(target);
      // Heuristic: ~3x the projected size of one point, with a floor so
      // raycasting still hits when the user is zoomed way in.
      raycaster.params.Points = {
        threshold: Math.max(pointSize * 3, dist * 0.005),
      };
    };
    update();
    // Re-tune on every animation frame so the threshold tracks zoom in/out.
    const id = setInterval(update, 100);
    return () => clearInterval(id);
  }, [raycaster, camera, controls, pointSize]);
  return null;
}

export default function CloudsClient() {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [clouds, setClouds] = useState<Partial<Record<CloudKey, ParsedCloud>>>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  // UI state
  const [cloudVisibility, setCloudVisibility] = useState<Record<CloudKey, boolean>>({
    train: true,
    test: true,
  });
  const [activeMode, setActiveMode] = useState<string>("gt_mid");
  const [pointCount, setPointCount] = useState<number>(150_000);
  const [pointSize, setPointSize] = useState<number>(0.06);
  const [showSplitPlane, setShowSplitPlane] = useState<boolean>(true);

  const orbitRef = useRef<OrbitControlsImpl | null>(null);

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

  const handleResetCamera = useCallback(() => {
    const ctrl = orbitRef.current;
    if (!ctrl) return;
    ctrl.target.set(cameraInit.target[0], cameraInit.target[1], cameraInit.target[2]);
    ctrl.object.position.set(cameraInit.position[0], cameraInit.position[1], cameraInit.position[2]);
    ctrl.update();
  }, [cameraInit]);

  // Recenter the orbit pivot at a point the user double-clicked.
  //
  // TODO(user): implement the recentering policy below. The simplest valid
  // option is "move target only" (camera stays put, scene appears to spin
  // around the new pivot). The polished option is "move target and camera
  // by the same delta" (the clicked point stays at the same screen position
  // and becomes the new pivot — what Blender / SketchFab / Figma do).
  //
  // See the comment block in the body for the trade-offs.
  const handlePickPoint = useCallback((worldPoint: THREE.Vector3) => {
    const ctrl = orbitRef.current;
    if (!ctrl) return;
    // ── YOUR CODE HERE (5–10 lines) ───────────────────────────────────
    // Trade-offs:
    //   (a) Just move target:
    //         ctrl.target.copy(worldPoint); ctrl.update();
    //       Pivot updates, but the scene appears to "shift" because the
    //       camera direction now points at a different spot.
    //   (b) Move target AND camera by the same delta:
    //         const delta = worldPoint.clone().sub(ctrl.target);
    //         ctrl.target.add(delta);
    //         ctrl.object.position.add(delta);
    //         ctrl.update();
    //       Clicked point stays put on screen and becomes the new pivot.
    //       This is what most users expect from "click to set rotation
    //       point" in pro 3D software.
    //   (c) Animate version of (b):
    //       Lerp target + position over ~250ms via useFrame for a smoother
    //       feel. More code, more state to manage.
    //
    // Replace the body below with your choice.
    const delta = worldPoint.clone().sub(ctrl.target);
    ctrl.target.add(delta);
    ctrl.object.position.add(delta);
    ctrl.update();
    // ── END YOUR CODE ────────────────────────────────────────────────
  }, []);

  // Keyboard shortcuts: F = frame all (reset camera), R = also reset.
  // Bound on the document so the user doesn't have to focus the canvas.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Skip when typing in an input/slider so shortcuts don't hijack
      // form interactions.
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.key === "f" || e.key === "F" || e.key === "r" || e.key === "R") {
        e.preventDefault();
        handleResetCamera();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleResetCamera]);

  // Per-cloud slider cap = the largest n among loaded clouds. The single
  // slider value is clamped per-cloud at render time.
  const pointCountMax = useMemo(() => {
    let max = 1000;
    for (const k of Object.keys(clouds) as CloudKey[]) {
      const c = clouds[k];
      if (c && c.n > max) max = c.n;
    }
    return max;
  }, [clouds]);

  // Plane size for the split overlay -- a bit larger than the scene extent
  // so it visually spans the cloud.
  const planeSize: [number, number] = useMemo(() => {
    const e = cameraInit.extent ?? 100;
    return [e * 1.4, e * 1.4];
  }, [cameraInit.extent]);

  const isLoading = !manifest || Object.keys(clouds).length === 0;

  return (
    <div className="relative w-full h-[calc(100vh-4rem)] bg-bg overflow-hidden">
      <Canvas
        camera={{
          position: cameraInit.position,
          fov: 55,
          near: 0.5,
          far: 5000,
        }}
        dpr={[1, 1.5]}
        gl={{ antialias: true }}
        style={{ background: "var(--color-bg)" }}
      >
        <OrbitControls
          ref={orbitRef as React.RefObject<OrbitControlsImpl>}
          target={cameraInit.target}
          enableDamping
          dampingFactor={0.08}
          makeDefault
        />
        <DynamicRaycasterThreshold pointSize={pointSize} />
        {colorMode &&
          (Object.keys(clouds) as CloudKey[]).map((key) => {
            const cloud = clouds[key];
            if (!cloud || !cloudVisibility[key]) return null;
            return (
              <CloudPoints
                key={key}
                cloud={cloud}
                colorMode={colorMode}
                pointSize={pointSize}
                visibleCount={Math.min(pointCount, cloud.n)}
                onPickPoint={handlePickPoint}
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
          pointCount={pointCount}
          setPointCount={setPointCount}
          pointCountMax={pointCountMax}
          pointSize={pointSize}
          setPointSize={setPointSize}
          showSplitPlane={showSplitPlane}
          setShowSplitPlane={setShowSplitPlane}
          onResetCamera={handleResetCamera}
        />
      )}

      {colorMode && <Legend mode={colorMode} />}

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
