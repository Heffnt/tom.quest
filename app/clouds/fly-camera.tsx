"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

export type FlyCameraHandle = {
  reset: () => void;
};

type Props = {
  initialPosition: [number, number, number];
  initialTarget: [number, number, number];
  moveSpeed?: number;  // world units / second per direction key
  setMoveSpeed?: Dispatch<SetStateAction<number>>;
  lookSpeed?: number;  // radians per pixel of drag
};

const WORLD_UP = new THREE.Vector3(0, 0, 1);
const PITCH_LIMIT = Math.PI / 2 - 0.02; // avoid gimbal at straight up/down
const MIN_MOVE_SPEED = 5;
const MAX_MOVE_SPEED = 150;
const MAX_WHEEL_DELTA_PX = 200;
const WHEEL_SPEED_SENSITIVITY = 0.002;

function clampMoveSpeed(speed: number): number {
  return THREE.MathUtils.clamp(speed, MIN_MOVE_SPEED, MAX_MOVE_SPEED);
}

export const FlyCamera = forwardRef<FlyCameraHandle, Props>(function FlyCamera(
  { initialPosition, initialTarget, moveSpeed = 30, setMoveSpeed, lookSpeed = 0.0025 },
  ref,
) {
  const { camera, gl } = useThree();
  const keys = useRef<Set<string>>(new Set());
  const dragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const yaw = useRef(0);
  const pitch = useRef(0);

  // Reset is the single source of truth for "where does the camera start."
  const reset = useCallback(() => {
    camera.up.copy(WORLD_UP);
    camera.position.set(initialPosition[0], initialPosition[1], initialPosition[2]);
    const dx = initialTarget[0] - initialPosition[0];
    const dy = initialTarget[1] - initialPosition[1];
    const dz = initialTarget[2] - initialPosition[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    yaw.current = Math.atan2(dy, dx);
    pitch.current = Math.asin(THREE.MathUtils.clamp(dz / len, -1, 1));
  }, [camera, initialPosition, initialTarget]);

  useImperativeHandle(ref, () => ({ reset }), [reset]);

  // Re-initialize whenever the framing changes (e.g. clouds finish loading).
  useEffect(() => {
    reset();
  }, [reset]);

  // Pointer + keyboard wiring.
  useEffect(() => {
    const canvas = gl.domElement;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging.current = true;
      lastMouse.current = { x: e.clientX, y: e.clientY };
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      canvas.style.cursor = "grabbing";
    };
    const stopDrag = (e: PointerEvent) => {
      dragging.current = false;
      canvas.style.cursor = "";
      try { canvas.releasePointerCapture(e.pointerId); } catch {}
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - lastMouse.current.x;
      const dy = e.clientY - lastMouse.current.y;
      lastMouse.current = { x: e.clientX, y: e.clientY };
      yaw.current -= dx * lookSpeed;
      pitch.current = THREE.MathUtils.clamp(
        pitch.current - dy * lookSpeed, -PITCH_LIMIT, PITCH_LIMIT,
      );
    };
    const onWheel = (e: WheelEvent) => {
      if (!setMoveSpeed) return;
      e.preventDefault();
      const wheelUnit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
      const deltaPixels = e.deltaY * wheelUnit;
      const clampedDelta = THREE.MathUtils.clamp(
        deltaPixels,
        -MAX_WHEEL_DELTA_PX,
        MAX_WHEEL_DELTA_PX,
      );
      setMoveSpeed((current) => {
        const nextSpeed = current * Math.exp(-clampedDelta * WHEEL_SPEED_SENSITIVITY);
        return clampMoveSpeed(nextSpeed);
      });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      // Stop the page from scrolling when the user holds Space to fly up.
      if (e.code === "Space") e.preventDefault();
      keys.current.add(e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keys.current.delete(e.code);
    };
    // Drop all held keys when the tab loses focus -- otherwise keyup
    // never fires and the camera drifts forever after Alt-Tab.
    const onBlur = () => keys.current.clear();

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", stopDrag);
    canvas.addEventListener("pointercancel", stopDrag);
    canvas.addEventListener("pointerleave", stopDrag);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", stopDrag);
      canvas.removeEventListener("pointercancel", stopDrag);
      canvas.removeEventListener("pointerleave", stopDrag);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [gl, lookSpeed, setMoveSpeed]);

  // Scratch vectors -- allocated once, reused every frame to keep GC quiet.
  const scratch = useRef({
    dir: new THREE.Vector3(),
    horiz: new THREE.Vector3(),
    right: new THREE.Vector3(),
    move: new THREE.Vector3(),
    target: new THREE.Vector3(),
  });

  useFrame((_, deltaSec) => {
    // Clamp delta so a long hidden tab doesn't teleport the camera on resume.
    const dt = Math.min(deltaSec, 0.1);
    const s = scratch.current;
    const k = keys.current;

    // Look direction from (yaw, pitch) in z-up world frame.
    const cosP = Math.cos(pitch.current);
    s.dir.set(
      cosP * Math.cos(yaw.current),
      cosP * Math.sin(yaw.current),
      Math.sin(pitch.current),
    );

    // Horizontal forward (project look onto xy plane). When looking
    // straight up/down, fall back to yaw so WASD still works.
    s.horiz.set(s.dir.x, s.dir.y, 0);
    if (s.horiz.lengthSq() < 1e-6) {
      s.horiz.set(Math.cos(yaw.current), Math.sin(yaw.current), 0);
    }
    s.horiz.normalize();
    s.right.crossVectors(s.horiz, WORLD_UP).normalize();

    // Compose movement direction from key states.
    s.move.set(0, 0, 0);
    if (k.has("KeyW") || k.has("ArrowUp"))    s.move.add(s.horiz);
    if (k.has("KeyS") || k.has("ArrowDown"))  s.move.sub(s.horiz);
    if (k.has("KeyD") || k.has("ArrowRight")) s.move.add(s.right);
    if (k.has("KeyA") || k.has("ArrowLeft"))  s.move.sub(s.right);
    if (k.has("Space"))                       s.move.add(WORLD_UP);
    if (k.has("ShiftLeft") || k.has("ShiftRight")) s.move.sub(WORLD_UP);

    if (s.move.lengthSq() > 0) {
      s.move.normalize().multiplyScalar(moveSpeed * dt);
      camera.position.add(s.move);
    }

    // Apply orientation: lookAt(position + look_direction).
    s.target.copy(camera.position).add(s.dir);
    camera.up.copy(WORLD_UP);
    camera.lookAt(s.target);
  });

  return null;
});
