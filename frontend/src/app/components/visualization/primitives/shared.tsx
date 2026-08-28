import * as THREE from "three";
import { Html } from "@react-three/drei";

import type { SceneEntity } from "../sceneTypes";

/**
 * Geometry and colour shared by every primitive renderer.
 *
 * Each primitive owns its own motion, but they all draw from one palette and
 * one set of easing helpers so a scene composed of several primitives reads as
 * a single diagram rather than a collage.
 */

export const PALETTE = {
  primary: "#5eead4",
  secondary: "#a5b4fc",
  accent: "#fbbf24",
  warm: "#fb7185",
  cool: "#67e8f9",
  muted: "#52525b",
  text: "#e4e4e7",
} as const;

/** Distinct colour per index, stable across renders. */
const CYCLE = [
  PALETTE.primary,
  PALETTE.accent,
  PALETTE.secondary,
  PALETTE.warm,
  PALETTE.cool,
];

export function seriesColor(index: number): string {
  return CYCLE[((index % CYCLE.length) + CYCLE.length) % CYCLE.length];
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function easeInOut(x: number): number {
  const p = clamp01(x);
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}

/** Staggered 0..1 ramp for element `i` of `n`, so groups act in sequence. */
export function stagger(t: number, i: number, n: number, width = 0.45): number {
  const start = (i / Math.max(1, n - 1)) * (1 - width);
  return easeInOut(clamp01((t - start) / width));
}

/** A 0..1 ramp across a slice of the step's timeline. */
export function phase(t: number, from: number, to: number): number {
  return clamp01((t - from) / Math.max(1e-6, to - from));
}

/**
 * Values scaled into a drawable height.
 *
 * Falls back to a deterministic ramp when the step carries no values, so a
 * primitive still shows structure rather than nothing. The ramp is derived
 * from the index -- never random -- so repeated renders are identical.
 */
export function normalizedValues(values: number[], count: number): number[] {
  if (values.length > 0) {
    const peak = Math.max(...values.map(Math.abs), 1e-6);
    return values.map((v) => v / peak);
  }
  const n = Math.max(1, Math.min(count || 6, 16));
  return Array.from({ length: n }, (_, i) => 0.35 + 0.6 * Math.abs(Math.sin(i * 1.1)));
}

/** How many units to draw when the step does not say. */
export function unitCount(count: number, items: string[], fallback = 6): number {
  if (items.length > 0) return Math.min(items.length, 16);
  if (count > 0) return Math.min(count, 16);
  return fallback;
}

export function Caption({
  text,
  position = [0, -2.1, 0],
}: {
  text: string;
  position?: [number, number, number];
}) {
  if (!text) return null;
  return (
    <Html center position={position} distanceFactor={12} style={{ pointerEvents: "none" }}>
      <div className="max-w-[18rem] whitespace-nowrap text-center font-mono text-[10px] uppercase tracking-widest text-zinc-400">
        {text}
      </div>
    </Html>
  );
}

/** A clickable label for an entity; clicking opens its evidence. */
export function EntityLabel({
  entity,
  position,
  onSelect,
}: {
  entity: SceneEntity | undefined;
  position: [number, number, number];
  onSelect?: (entityId: string) => void;
}) {
  if (!entity) return null;
  const uncertain = entity.evidence_ids.length === 0;
  return (
    <Html center position={position} distanceFactor={12} zIndexRange={[18, 0]}>
      <button
        type="button"
        onClick={() => onSelect?.(entity.id)}
        title={uncertain ? "No supporting evidence cited" : "Show supporting evidence"}
        className={[
          "whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium",
          "cursor-pointer bg-zinc-900/85 backdrop-blur-sm transition-colors",
          uncertain
            ? "border-dashed border-amber-500/60 text-amber-200/90"
            : "border-zinc-600 text-zinc-200 hover:border-teal-400 hover:text-teal-200",
        ].join(" ")}
      >
        {entity.label}
        {uncertain ? " ?" : ""}
      </button>
    </Html>
  );
}

/** Evenly spaced x positions centred on the origin. */
export function spread(index: number, total: number, width = 5.4): number {
  if (total <= 1) return 0;
  return (index / (total - 1) - 0.5) * width;
}

export function Cell({
  position,
  color,
  scale = 1,
  opacity = 1,
  shape = "box",
}: {
  position: [number, number, number];
  color: string;
  scale?: number;
  opacity?: number;
  shape?: "box" | "sphere";
}) {
  return (
    <mesh position={position} scale={Math.max(0.001, scale)}>
      {shape === "box" ? (
        <boxGeometry args={[0.42, 0.42, 0.42]} />
      ) : (
        <sphereGeometry args={[0.22, 16, 16]} />
      )}
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.55}
        transparent
        opacity={opacity}
        toneMapped={false}
      />
    </mesh>
  );
}

/** A straight glowing connector between two points. */
export function Link({
  from,
  to,
  color,
  opacity,
  thickness = 0.03,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  color: string;
  opacity: number;
  thickness?: number;
}) {
  const mid = from.clone().add(to).multiplyScalar(0.5);
  const direction = to.clone().sub(from);
  const length = direction.length();
  if (length < 1e-4) return null;
  const quaternion = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    direction.clone().normalize(),
  );
  return (
    <mesh position={mid.toArray()} quaternion={quaternion}>
      <cylinderGeometry args={[thickness, thickness, length, 6]} />
      <meshBasicMaterial
        color={color}
        transparent
        opacity={Math.max(0, Math.min(1, opacity))}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}
