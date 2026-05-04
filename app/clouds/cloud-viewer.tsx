"use client";

import { useEffect, useMemo, useRef } from "react";
import type { ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import type { CloudKey, ColorMode, ParsedCloud, SplitPlane } from "./lib/types";

export type PointHover = {
  cloudKey: CloudKey;
  index: number;
  clientX: number;
  clientY: number;
  xyz: [number, number, number];
};

type CloudPointsProps = {
  cloudKey: CloudKey;
  cloud: ParsedCloud;
  colorMode: ColorMode;
  pointSize: number;
  visibleCount: number;
  onPointHover: (point: PointHover) => void;
  onPointLeave: () => void;
};

export function CloudPoints({
  cloudKey,
  cloud,
  colorMode,
  pointSize,
  visibleCount,
  onPointHover,
  onPointLeave,
}: CloudPointsProps) {
  const geometryRef = useRef<THREE.BufferGeometry>(null);

  // Position attribute: built once per cloud. xyz is already a Float32Array
  // view over the fetched ArrayBuffer, no copy.
  const positionAttr = useMemo(
    () => new THREE.BufferAttribute(cloud.xyz, 3),
    [cloud],
  );

  // Color attribute: rebuilt on (cloud, mode) change. We materialize a
  // Float32Array so vertexColors can read it directly without a per-frame
  // shader uniform table.
  const colorAttr = useMemo(() => {
    const channel = cloud.channels[colorMode.channel] as
      | Uint8Array
      | Uint16Array
      | undefined;
    const colors = new Float32Array(cloud.n * 3);
    if (!channel) {
      // Fallback: warm gray. Avoids a black cloud on a missing channel.
      colors.fill(0.5);
      return new THREE.BufferAttribute(colors, 3);
    }
    const palette = colorMode.palette;
    const fallbackR = 0.5;
    const fallbackG = 0.5;
    const fallbackB = 0.5;
    for (let i = 0; i < cloud.n; i++) {
      const idx = channel[i];
      const entry = palette[idx];
      if (entry) {
        colors[i * 3] = entry.color[0] / 255;
        colors[i * 3 + 1] = entry.color[1] / 255;
        colors[i * 3 + 2] = entry.color[2] / 255;
      } else {
        colors[i * 3] = fallbackR;
        colors[i * 3 + 1] = fallbackG;
        colors[i * 3 + 2] = fallbackB;
      }
    }
    return new THREE.BufferAttribute(colors, 3);
  }, [cloud, colorMode]);

  // The slider drives setDrawRange -- the GPU draws only the first N
  // points. Cheap because the underlying buffers don't change.
  useEffect(() => {
    const geom = geometryRef.current;
    if (!geom) return;
    const n = Math.max(0, Math.min(visibleCount, cloud.n));
    geom.setDrawRange(0, n);
  }, [visibleCount, cloud.n, positionAttr, colorAttr]);

  const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    const index = event.index;
    if (index === undefined || index >= visibleCount || index >= cloud.n) return;
    const offset = index * 3;
    onPointHover({
      cloudKey,
      index,
      clientX: event.nativeEvent.clientX,
      clientY: event.nativeEvent.clientY,
      xyz: [cloud.xyz[offset], cloud.xyz[offset + 1], cloud.xyz[offset + 2]],
    });
  };

  const handlePointerOut = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onPointLeave();
  };

  return (
    <points
      frustumCulled={false}
      onPointerMove={handlePointerMove}
      onPointerOut={handlePointerOut}
    >
      <bufferGeometry ref={geometryRef}>
        <primitive attach="attributes-position" object={positionAttr} />
        <primitive attach="attributes-color" object={colorAttr} />
      </bufferGeometry>
      <pointsMaterial size={pointSize} vertexColors sizeAttenuation />
    </points>
  );
}

type SplitPlaneOverlayProps = {
  splitPlane: SplitPlane;
  size: [number, number]; // [width, height] of the plane quad in world units
};

export function SplitPlaneOverlay({ splitPlane, size }: SplitPlaneOverlayProps) {
  // Build a plane geometry oriented perpendicular to the split axis.
  // PlaneGeometry's default normal is +Z, so we rotate to align with the
  // requested axis.
  const rotation = useMemo<[number, number, number]>(() => {
    if (splitPlane.axis === "x") return [0, Math.PI / 2, 0]; // normal -> +X
    if (splitPlane.axis === "y") return [Math.PI / 2, 0, 0]; // normal -> +Y
    return [0, 0, 0]; // axis === "z" -> normal -> +Z
  }, [splitPlane.axis]);

  const position = useMemo<[number, number, number]>(() => {
    const p: [number, number, number] = [0, 0, 0];
    p[splitPlane.axis_index] = splitPlane.value;
    return p;
  }, [splitPlane]);

  return (
    <mesh position={position} rotation={rotation}>
      <planeGeometry args={size} />
      <meshBasicMaterial
        color="#e8a040"
        opacity={0.12}
        transparent
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}
