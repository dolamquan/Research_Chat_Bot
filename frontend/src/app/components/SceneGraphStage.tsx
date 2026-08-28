import * as THREE from "three";
import { Html } from "@react-three/drei";

import type { MechanismGraph, SceneGraphNode, SceneGraphTrack } from "../types";
import { normalizedValues } from "./visualization/primitives/shared";

/**
 * The generic interpreter for the parametric scene graph -- the fully dynamic
 * tier. It knows eight geometry atoms, six instance layouts, and nine
 * animatable properties, and nothing else: every picture is the model's
 * *composition* of those, not a hand-written scene. Pure and hook-free like
 * `SceneStage`: a function of (graph, t), re-rendered by the parent clock.
 *
 * Stored graphs reach this component with no validation layer between the
 * database and the renderer, so every list read is defensive and every
 * numeric read is clamped. Unknown enum values fall back visibly (wireframe
 * geometry) rather than plausibly.
 */

const TONE_COLORS: Record<string, string> = {
  primary: "#6ee7d8",
  secondary: "#a5b4fc",
  signal: "#fbbf24",
  inhibitor: "#fca5a5",
  substrate: "#94a3b8",
  product: "#f0abfc",
  neutral: "#52525b",
};

const MAX_ITEM_LABELS = 12; // drei <Html> portals are DOM-expensive

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function easeInOut(p: number): number {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}

function finite(values: unknown, fallback: number[] = []): number[] {
  return Array.isArray(values)
    ? values.filter((v): v is number => Number.isFinite(v))
    : fallback;
}

/** Evaluate one keyframe track at time t: piecewise interpolation. */
export function trackValue(track: SceneGraphTrack, t: number): number | null {
  const times = finite(track.times);
  const keys = finite(track.keys);
  const n = Math.min(times.length, keys.length);
  if (n === 0) return null;
  if (t <= times[0]) return keys[0];
  if (t >= times[n - 1]) return keys[n - 1];
  for (let i = 0; i < n - 1; i += 1) {
    if (t > times[i + 1]) continue;
    const span = Math.max(times[i + 1] - times[i], 1e-6);
    const f = clamp01((t - times[i]) / span);
    const eased =
      track.easing === "linear"
        ? f
        : track.easing === "pulse"
          ? Math.sin(f * Math.PI / 2) // fast attack, used for glows
          : easeInOut(f);
    return keys[i] + (keys[i + 1] - keys[i]) * eased;
  }
  return keys[n - 1];
}

/** Local-space offset of instance `i` of `n` under a layout rule. */
export function instanceOffset(
  layout: string,
  i: number,
  n: number,
  spacing: number,
): [number, number, number] {
  const gap = Math.max(0.05, spacing || 0.8);
  if (n <= 1 || layout === "single") return [0, 0, 0];
  const centered = i - (n - 1) / 2;
  switch (layout) {
    case "row":
      return [centered * gap, 0, 0];
    case "column":
      return [0, centered * gap, 0];
    case "ring": {
      const radius = Math.max(0.6, (gap * n) / (2 * Math.PI));
      const angle = (i / n) * Math.PI * 2;
      return [Math.cos(angle) * radius, Math.sin(angle) * radius, 0];
    }
    case "arc": {
      const radius = Math.max(0.8, (gap * (n - 1)) / Math.PI);
      const angle = Math.PI * (1 - i / (n - 1));
      return [Math.cos(angle) * radius, Math.sin(angle) * radius * 0.6, 0];
    }
    case "grid": {
      const side = Math.ceil(Math.sqrt(n));
      const r = Math.floor(i / side);
      const c = i % side;
      return [(c - (side - 1) / 2) * gap, (r - (side - 1) / 2) * gap, 0];
    }
    default:
      return [centered * gap, 0, 0];
  }
}

/** Constant-args unit geometry per kind; size is applied through scale. */
function UnitGeometry({ kind }: { kind: string }) {
  switch (kind) {
    case "box":
      return <boxGeometry args={[1, 1, 1]} />;
    case "sphere":
      return <sphereGeometry args={[0.5, 16, 16]} />;
    case "cylinder":
      return <cylinderGeometry args={[0.5, 0.5, 1, 14]} />;
    case "cone":
      return <coneGeometry args={[0.5, 1, 14]} />;
    case "torus":
      return <torusGeometry args={[0.5, 0.06, 10, 40]} />;
    case "plane":
      return <planeGeometry args={[1, 1]} />;
    case "ring":
      return <ringGeometry args={[0.36, 0.5, 32]} />;
    case "capsule":
      return <capsuleGeometry args={[0.25, 0.5, 4, 12]} />;
    default:
      // Unknown geometry from a newer backend: visible drift, not a guess.
      return <icosahedronGeometry args={[0.5, 1]} />;
  }
}

const KNOWN_GEOMETRY = new Set([
  "box", "sphere", "cylinder", "cone", "torus", "plane", "ring", "capsule",
]);

/** How the node's `size` list maps onto a scale vector, per geometry. */
function sizeScale(kind: string, size: number[]): [number, number, number] {
  const s0 = size[0] ?? 0.5;
  const s1 = size[1] ?? s0;
  const s2 = size[2] ?? size[0] ?? 0.5;
  switch (kind) {
    case "box":
      return [s0, s1, s2];
    case "plane":
      return [s0, s1, 1];
    case "cylinder":
    case "cone":
    case "capsule":
      return [s0, s1, s0];
    default:
      // sphere, torus, ring, unknown: uniform from the first dimension.
      return [s0 * 2, s0 * 2, s0 * 2];
  }
}

type NodeAnimation = Partial<Record<string, number>>;

function GraphNodeView({
  node,
  childrenOf,
  animations,
  labelBudget,
}: {
  node: SceneGraphNode;
  childrenOf: Map<string, SceneGraphNode[]>;
  animations: Map<string, NodeAnimation>;
  labelBudget: { remaining: number };
}) {
  const anim = animations.get(node.node_id) ?? {};
  const basePos = finite(node.position);
  const baseRot = finite(node.rotation_deg);
  const position: [number, number, number] = [
    anim.position_x ?? basePos[0] ?? 0,
    anim.position_y ?? basePos[1] ?? 0,
    anim.position_z ?? basePos[2] ?? 0,
  ];
  const rotation: [number, number, number] = [
    THREE.MathUtils.degToRad(baseRot[0] ?? 0),
    THREE.MathUtils.degToRad(anim.rotation_y ?? baseRot[1] ?? 0),
    THREE.MathUtils.degToRad(anim.rotation_z ?? baseRot[2] ?? 0),
  ];
  const scale = Math.max(0.001, anim.scale ?? 1);
  const opacity = clamp01(anim.opacity ?? node.opacity ?? 1);
  const emissive = Math.max(0, anim.emissive ?? node.emissive ?? 0.4);
  const progress = clamp01(anim.progress ?? 1);

  if (opacity <= 0.01) return null;

  const color = TONE_COLORS[node.tone] ?? TONE_COLORS.neutral;
  const negative = TONE_COLORS.inhibitor;
  const count = Math.max(1, Math.min(Math.round(node.count) || 1, 64));
  const shown = Math.max(count > 1 ? 0 : 1, Math.ceil(progress * count));
  const values = finite(node.values);
  const magnitudes = values.length > 0 ? normalizedValues(values, count) : null;
  const items = Array.isArray(node.items)
    ? node.items.filter((s): s is string => typeof s === "string" && s.length > 0)
    : [];
  const showItems = items.length > 0 && count <= 8;
  const wire = !KNOWN_GEOMETRY.has(node.geometry);
  const [sx, sy, sz] = sizeScale(node.geometry, finite(node.size));
  const flat = node.geometry === "plane" || node.geometry === "ring";

  return (
    <group position={position} rotation={rotation} scale={scale}>
      {Array.from({ length: count }, (_, i) => {
        const visible = i < shown;
        const offset = instanceOffset(node.layout, i, count, node.spacing);
        const magnitude = magnitudes ? magnitudes[i % magnitudes.length] : null;
        const heightScale =
          magnitude !== null && (node.geometry === "box" || node.geometry === "cylinder")
            ? Math.max(0.1, Math.abs(magnitude))
            : 1;
        const instanceColor = magnitude !== null && magnitude < 0 ? negative : color;
        return (
          <group key={i} position={offset}>
            <mesh
              scale={[sx, sy * heightScale, sz]}
              position={[0, heightScale < 1 ? (-sy * (1 - heightScale)) / 2 : 0, 0]}
            >
              <UnitGeometry kind={node.geometry} />
              <meshStandardMaterial
                color={instanceColor}
                emissive={instanceColor}
                emissiveIntensity={visible ? emissive : 0}
                transparent
                opacity={opacity * (visible ? 1 : 0)}
                wireframe={wire}
                side={flat ? THREE.DoubleSide : THREE.FrontSide}
                toneMapped={false}
              />
            </mesh>
            {showItems && items[i] && visible && labelBudget.remaining > 0
              ? (labelBudget.remaining -= 1) >= 0 && (
                  <Html
                    center
                    position={[0, sy * 0.5 + 0.34 + (i % 2) * 0.3, 0]}
                    distanceFactor={13}
                    style={{ pointerEvents: "none" }}
                    zIndexRange={[17, 0]}
                  >
                    <div
                      className="whitespace-nowrap font-mono text-[9px] tracking-wide text-zinc-300"
                      style={{ opacity }}
                    >
                      {items[i]}
                    </div>
                  </Html>
                )
              : null}
          </group>
        );
      })}
      {node.label ? (
        <Html
          center
          position={[0, -Math.max(sy * 0.5, 0.5) - 0.55, 0]}
          distanceFactor={13}
          style={{ pointerEvents: "none" }}
          zIndexRange={[18, 0]}
        >
          <div
            className="whitespace-nowrap rounded border border-zinc-700/50 bg-zinc-900/75 px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-zinc-200"
            style={{ opacity }}
          >
            {node.label}
          </div>
        </Html>
      ) : null}
      {(childrenOf.get(node.node_id) ?? []).map((child) => (
        <GraphNodeView
          key={child.node_id}
          node={child}
          childrenOf={childrenOf}
          animations={animations}
          labelBudget={labelBudget}
        />
      ))}
    </group>
  );
}

export function SceneGraphStage({
  graph,
  t,
}: {
  graph: MechanismGraph;
  t: number;
}) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  if (!graph.described || nodes.length === 0) return null;

  const known = new Set(nodes.map((n) => n.node_id));
  const childrenOf = new Map<string, SceneGraphNode[]>();
  const roots: SceneGraphNode[] = [];
  for (const node of nodes) {
    if (node.parent_id && known.has(node.parent_id) && node.parent_id !== node.node_id) {
      const siblings = childrenOf.get(node.parent_id) ?? [];
      siblings.push(node);
      childrenOf.set(node.parent_id, siblings);
    } else {
      roots.push(node);
    }
  }
  // A stored cycle (a -> b -> a) leaves both off the root list; render them
  // as roots rather than dropping them silently.
  const reachable = new Set<string>();
  const walk = (node: SceneGraphNode) => {
    if (reachable.has(node.node_id)) return;
    reachable.add(node.node_id);
    (childrenOf.get(node.node_id) ?? []).forEach(walk);
  };
  roots.forEach(walk);
  for (const node of nodes) {
    if (!reachable.has(node.node_id)) {
      childrenOf.delete(node.parent_id);
      roots.push(node);
      walk(node);
    }
  }

  const animations = new Map<string, NodeAnimation>();
  for (const track of Array.isArray(graph.tracks) ? graph.tracks : []) {
    if (!known.has(track.node_id)) continue;
    const value = trackValue(track, t);
    if (value === null) continue;
    const anim = animations.get(track.node_id) ?? {};
    anim[track.prop] = value;
    animations.set(track.node_id, anim);
  }

  const labelBudget = { remaining: MAX_ITEM_LABELS };
  const caption = typeof graph.caption === "string" ? graph.caption : "";

  return (
    <group>
      <mesh position={[0, -2.35, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[5.6, 48]} />
        <meshBasicMaterial color="#3f3f46" transparent opacity={0.08} depthWrite={false} toneMapped={false} />
      </mesh>
      {roots.map((node) => (
        <GraphNodeView
          key={node.node_id}
          node={node}
          childrenOf={childrenOf}
          animations={animations}
          labelBudget={labelBudget}
        />
      ))}
      {caption ? (
        <Html
          center
          position={[0, 2.6, 0]}
          distanceFactor={14}
          style={{ pointerEvents: "none" }}
          zIndexRange={[19, 0]}
        >
          <div className="w-max max-w-[26rem] rounded-md border border-zinc-700/80 bg-zinc-900/85 px-3 py-1.5 text-center text-[11px] leading-snug text-zinc-200">
            {caption}
          </div>
        </Html>
      ) : null}
    </group>
  );
}

export default SceneGraphStage;
