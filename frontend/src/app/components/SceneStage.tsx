import * as THREE from "three";
import { Html } from "@react-three/drei";

import type { MechanismScene, SceneActor, SceneBeat } from "../types";
import {
  Link,
  normalizedValues,
  spread,
  stagger,
} from "./visualization/primitives/shared";

/**
 * Renders any scene the composer produced.
 *
 * There is deliberately no per-paper code here and no switch on subject
 * matter. An actor is drawn from its `form` and animated by whichever beats
 * are live at time `t`, so a signalling cascade and a residual connection go
 * through exactly the same path and simply describe different casts. Adding a
 * new kind of paper does not mean adding a new scene.
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

const SLOT_POSITIONS: Record<string, [number, number, number]> = {
  left: [-3.4, 0, 0],
  center: [0, 0, 0],
  right: [3.4, 0, 0],
  upper: [0, 1.7, 0],
  lower: [0, -1.7, 0],
  front: [0, 0, 1.6],
  back: [0, 0, -1.6],
  offstage: [-7.5, 0, 0],
  same: [0, 0, 0],
};

const ARRAY_BAR_HEIGHT = 1.6;

/**
 * Width of a labelled unit row. Grows with the unit count so adjacent labels
 * do not overprint ("thecapital"), but stays narrower than the slot spacing
 * so an actor never spills into its neighbour's space.
 */
export function unitRowWidth(n: number): number {
  return Math.min(Math.max(n * 0.75, 1.6), 4.6);
}

/** Correspondence rendering budget: more reads as mud, not as mapping. */
const MAX_LINK_PAIRS = 12;
const LINK_PRUNE = 0.18;
/** Links persist dimly after their beat, or the mapping vanishes mid-story. */
const LINK_RESIDUAL = 0.35;

function toneColor(tone: string): string {
  return TONE_COLORS[tone] ?? TONE_COLORS.neutral;
}

function slotVec(slot: string): THREE.Vector3 {
  const raw = SLOT_POSITIONS[slot] ?? SLOT_POSITIONS.center;
  return new THREE.Vector3(raw[0], raw[1], raw[2]);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function easeInOut(p: number): number {
  return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}

/** Stable per-unit jitter, so a swarm looks organic without reflowing each frame. */
function noise(seed: number): number {
  const x = Math.sin(seed * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

/** What a beat contributes at time `t`: 0 before it starts, 1 once it is done. */
function beatProgress(beat: SceneBeat, t: number): number {
  if (t <= beat.start) return 0;
  const span = Math.max(beat.duration, 0.001);
  return clamp01((t - beat.start) / span);
}

/**
 * Stored scenes reach this component with no validation layer between the
 * database and the renderer, and rows written before actors carried
 * `items`/`values` simply lack the keys (or, via the JSON fallback path, may
 * carry null). Normalising once here means no form component ever has to
 * remember `?? []`.
 */
export type SafeActor = SceneActor & { items: string[]; values: number[] };

export function safeActor(actor: SceneActor): SafeActor {
  return {
    ...actor,
    items: Array.isArray(actor.items)
      ? actor.items.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [],
    values: Array.isArray(actor.values)
      ? actor.values.filter((value): value is number => Number.isFinite(value))
      : [],
  };
}

function beatWeights(beat: SceneBeat): number[] {
  return Array.isArray(beat.weights)
    ? beat.weights.filter((value): value is number => Number.isFinite(value))
    : [];
}

/** Everything the renderers need to know about one actor at one instant. */
export type ActorState = {
  position: THREE.Vector3;
  opacity: number;
  scale: number;
  /** Fraction of the actor's units currently present (deplete / threshold). */
  fraction: number;
  /** How far a `spread_along` has propagated, 0 when none is running. */
  coverage: number;
  /** Lateral divergence from `split`, converging again on `merge`. */
  divergence: number;
  /** Random dispersal from `scatter`. */
  dispersion: number;
  /** Set while a `transform` is in flight, to cross-fade identity. */
  morph: number;
  /** Present so an actor that never `enter`s is still visible from the start. */
  entered: boolean;
};

function initialState(actor: SceneActor, startOffset?: THREE.Vector3): ActorState {
  const position = slotVec(actor.at);
  if (startOffset) position.add(startOffset);
  return {
    position,
    opacity: 1,
    scale: 1,
    fraction: 1,
    coverage: 0,
    divergence: 0,
    dispersion: 0,
    morph: 0,
    entered: true,
  };
}

/**
 * De-overlap actors that declare the same starting slot.
 *
 * The composer is asked to spread actors out, but nothing guarantees it, and
 * two actors sharing "center" render inside each other (bars inside a vessel,
 * labels overprinting). Same-slot actors fan apart: vertically for the
 * horizontal slots, horizontally for upper/lower, with a small z step so
 * coplanar geometry cannot z-fight.
 */
export function slotOffsets(
  actors: SceneActor[],
  beats: SceneBeat[] = [],
): Map<string, THREE.Vector3> {
  const offsets = new Map<string, THREE.Vector3>();
  const groups = new Map<string, SceneActor[]>();
  for (const actor of actors) {
    const slot = SLOT_POSITIONS[actor.at] ? actor.at : "center";
    const group = groups.get(slot) ?? [];
    group.push(actor);
    groups.set(slot, group);
  }

  // When the model dumped most of the cast on one slot AND told us who feeds
  // whom, ignore the declared slots and lay the cast out left-to-right in
  // dataflow order instead -- sources on the left, what they become on the
  // right. That is the arrangement a reader can follow as a mechanism.
  const largestGroup = Math.max(0, ...[...groups.values()].map((g) => g.length));
  const relational = beats.filter(
    (b) => (b.kind === "correspond" || b.kind === "bind") && b.target_id,
  );
  if (largestGroup * 2 > actors.length && relational.length > 0) {
    const order = dataflowOrder(actors, relational);
    const width = Math.min(2.4 * Math.max(actors.length - 1, 1), 7.6);
    actors.forEach((actor) => {
      const rank = order.get(actor.actor_id) ?? 0;
      const x = actors.length <= 1 ? 0 : (rank / (actors.length - 1) - 0.5) * width;
      const desired = new THREE.Vector3(x, (rank % 2) * 0.5 - 0.25, rank * 0.2);
      offsets.set(actor.actor_id, desired.sub(slotVec(actor.at)));
    });
    return offsets;
  }

  for (const [slot, group] of groups) {
    if (group.length <= 1) continue;
    const vertical = slot !== "upper" && slot !== "lower";
    group.forEach((actor, i) => {
      const fan = (i - (group.length - 1) / 2) * 1.9;
      offsets.set(
        actor.actor_id,
        new THREE.Vector3(vertical ? 0 : fan, vertical ? fan : 0, i * 0.3),
      );
    });
  }
  return offsets;
}

/** Topological rank of each actor over the relational beats (Kahn's). */
function dataflowOrder(
  actors: SceneActor[],
  relational: SceneBeat[],
): Map<string, number> {
  const ids = actors.map((a) => a.actor_id);
  const incoming = new Map<string, number>(ids.map((id) => [id, 0]));
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const beat of relational) {
    if (!incoming.has(beat.actor_id) || !incoming.has(beat.target_id)) continue;
    out.get(beat.actor_id)?.push(beat.target_id);
    incoming.set(beat.target_id, (incoming.get(beat.target_id) ?? 0) + 1);
  }
  const queue = ids.filter((id) => incoming.get(id) === 0);
  const order = new Map<string, number>();
  let rank = 0;
  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.set(id, rank++);
    for (const next of out.get(id) ?? []) {
      const remaining = (incoming.get(next) ?? 1) - 1;
      incoming.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  // A cycle leaves actors unranked; append them in declaration order so the
  // layout stays total rather than collapsing back onto one point.
  for (const id of ids) {
    if (!order.has(id)) order.set(id, rank++);
  }
  return order;
}

/**
 * Fold every beat that touches this actor into a single state.
 *
 * Beats compose rather than override: a particle stream can be travelling and
 * depleting at once, which is what makes combinations expressive enough to
 * cover papers this code has never seen.
 */
export function actorStateAt(
  actor: SceneActor,
  beats: SceneBeat[],
  others: Map<string, ActorState>,
  t: number,
  startOffset?: THREE.Vector3,
): ActorState {
  const state = initialState(actor, startOffset);
  const mine = beats.filter((b) => b.actor_id === actor.actor_id);

  // An actor with an `enter` beat does not exist before that beat fires.
  if (mine.some((b) => b.kind === "enter")) {
    state.entered = false;
    state.opacity = 0;
  }

  for (const beat of mine) {
    const p = beatProgress(beat, t);
    if (p <= 0) continue;
    const eased = easeInOut(p);
    const m = beat.magnitude || 1;

    switch (beat.kind) {
      case "enter":
        state.entered = true;
        state.opacity = eased;
        state.scale *= 0.6 + 0.4 * eased;
        break;
      case "travel": {
        const to = beat.to === "same" ? state.position : slotVec(beat.to);
        state.position = state.position.clone().lerp(to, eased);
        break;
      }
      case "bind": {
        const target = beat.target_id ? others.get(beat.target_id) : null;
        if (target) {
          state.position = state.position.clone().lerp(target.position, eased * 0.92);
        }
        break;
      }
      case "correspond":
        // Relational: drawn by CorrespondenceLinks, which can see both actors.
        break;
      case "split":
        state.divergence += eased * (0.6 + m);
        break;
      case "merge":
        state.divergence = Math.max(0, state.divergence - eased * (0.6 + m));
        break;
      case "spread_along":
        state.coverage = Math.max(state.coverage, eased);
        break;
      case "accumulate":
        state.fraction = Math.min(1, 0.15 + 0.85 * eased);
        break;
      case "deplete":
        state.fraction *= 1 - eased * m;
        break;
      case "oscillate":
        state.position = state.position
          .clone()
          .add(new THREE.Vector3(0, Math.sin(t * Math.PI * 4) * 0.4 * m, 0));
        break;
      case "transform":
        state.morph = eased;
        state.scale *= 1 + 0.18 * Math.sin(eased * Math.PI);
        break;
      case "amplify":
        state.scale *= 1 + eased * m * 0.8;
        break;
      case "threshold":
        // Only the portion above the cutoff survives.
        state.fraction = Math.min(state.fraction, Math.max(0.1, 1 - m) + 0.001);
        break;
      case "scatter":
        state.dispersion += eased * m;
        break;
      case "exit":
        state.opacity *= 1 - eased;
        state.position = state.position
          .clone()
          .lerp(slotVec(beat.to === "same" ? "offstage" : beat.to), eased);
        break;
      default:
        // A kind this build does not know (a newer backend, a stored row from
        // a future schema) is ignored rather than crashed on.
        break;
    }
  }

  return state;
}

// --- unit anchors -------------------------------------------------------------
//
// Where each unit of a form sits in the actor's LOCAL space, and how many
// units the form draws. Both the form renderers and the correspondence links
// read these tables, so a link terminates exactly where the geometry is --
// duplicating the layout math in two places is how they would drift apart.

function particleRowMode(actor: SafeActor, n: number): boolean {
  // With few, named units the ring becomes a labelled row: a ring has no
  // reading order, and a worked example's tokens are ordered.
  return actor.items.length > 0 && n <= 6;
}

function latticeSide(actor: SafeActor): number {
  return Math.max(2, Math.min(Math.round(Math.sqrt(actor.count)) || 3, 6));
}

export const FORM_UNITS: Record<string, (actor: SafeActor) => number> = {
  particles: (a) => Math.max(1, Math.min(a.count, 28)),
  strand: (a) => Math.max(6, Math.min(a.count * 2, 26)),
  array: (a) => Math.max(1, Math.min(a.values.length || a.count || 6, 16)),
  lattice: (a) => latticeSide(a) ** 2,
  blob: () => 1,
  field: () => 1,
  vessel: () => 1,
  beam: () => 1,
  marker: () => 1,
};

export const FORM_ANCHORS: Record<
  string,
  (actor: SafeActor, i: number, n: number) => [number, number, number]
> = {
  particles: (actor, i, n) => {
    if (particleRowMode(actor, n)) return [spread(i, n, unitRowWidth(n)), 0, 0];
    const ring = Math.floor(i / 6);
    const angle = (i % 6) * (Math.PI / 3) + ring * 0.4;
    const radius = 0.34 + ring * 0.32;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius, 0];
  },
  strand: (_actor, i, n) => {
    const u = n <= 1 ? 0 : i / (n - 1);
    return [(u - 0.5) * 4.2, Math.sin(u * Math.PI * 2.2) * 0.34, 0];
  },
  array: (_actor, i, n) => [spread(i, n, unitRowWidth(n)), 0, 0],
  lattice: (actor, i) => {
    const side = latticeSide(actor);
    const r = Math.floor(i / side);
    const c = i % side;
    return [(c - (side - 1) / 2) * 0.52, (r - (side - 1) / 2) * 0.52, 0];
  },
  blob: () => [0, 0, 0],
  field: () => [0, 0, 0],
  vessel: () => [0, 0, 0],
  beam: () => [0, 0, 0],
  marker: () => [0, 0, 0],
};

/** Bounding radius, so links terminate on a silhouette instead of inside it. */
export const FORM_EXTENT: Record<string, (actor: SafeActor) => number> = {
  particles: () => 0.16,
  strand: () => 0.15,
  array: () => 0.2,
  lattice: () => 0.24,
  blob: () => 0.85,
  field: () => 1.6,
  vessel: () => 1.15,
  beam: () => 0.4,
  marker: () => 0.3,
};

/** Unit `i`'s position in world space, given the actor's resolved state. */
export function worldAnchor(
  actor: SafeActor,
  state: ActorState,
  i: number,
  n: number,
): THREE.Vector3 {
  const anchor = (FORM_ANCHORS[actor.form] ?? FORM_ANCHORS.blob)(actor, i, n);
  return new THREE.Vector3(anchor[0], anchor[1], anchor[2])
    .multiplyScalar(state.scale)
    .add(state.position);
}

// --- form renderers ---------------------------------------------------------
//
// One per ActorForm. Each takes the resolved state and draws recognisable
// geometry; none of them know what the actor represents. Unit positions come
// from FORM_ANCHORS so correspondence links land exactly on the geometry.

function Particles({ actor, state }: { actor: SafeActor; state: ActorState }) {
  const color = toneColor(actor.tone);
  const n = FORM_UNITS.particles(actor);
  const shown = Math.max(1, Math.round(n * state.fraction));
  const row = particleRowMode(actor, n);
  const showLabels = row && state.opacity > 0.5;
  return (
    <>
      {Array.from({ length: n }, (_, i) => {
        const visible = i < shown;
        const [ax, ay] = FORM_ANCHORS.particles(actor, i, n);
        const jx = (noise(i + 1) - 0.5) * state.dispersion * 3;
        const jy = (noise(i + 41) - 0.5) * state.dispersion * 3;
        return (
          <group key={i} position={[ax + jx, ay + jy, row ? 0 : (noise(i + 91) - 0.5) * 0.5 + state.divergence * (i % 2 ? 1 : -1)]}>
            <mesh scale={visible ? (row ? 1.4 : 1) : 0.001}>
              <sphereGeometry args={[0.14, 14, 14]} />
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={visible ? (row ? 0.95 : 0.7) : 0}
                transparent
                opacity={state.opacity * (visible ? 1 : 0)}
                toneMapped={false}
              />
            </mesh>
            {showLabels && actor.items[i] ? (
              <Html
                center
                position={[0, 0.42 + (i % 2) * 0.32, 0]}
                distanceFactor={13}
                style={{ pointerEvents: "none" }}
                zIndexRange={[17, 0]}
              >
                <div
                  className="whitespace-nowrap font-mono text-[9px] tracking-wide text-zinc-300"
                  style={{ opacity: state.opacity }}
                >
                  {actor.items[i]}
                </div>
              </Html>
            ) : null}
          </group>
        );
      })}
    </>
  );
}

function Strand({ actor, state }: { actor: SafeActor; state: ActorState }) {
  const color = toneColor(actor.tone);
  const segments = FORM_UNITS.strand(actor);
  return (
    <>
      {Array.from({ length: segments }, (_, i) => {
        const u = segments <= 1 ? 0 : i / (segments - 1);
        const [x, y] = FORM_ANCHORS.strand(actor, i, segments);
        // `spread_along` lights the strand up progressively from one end.
        const covered = state.coverage > 0 && u <= state.coverage;
        return (
          <mesh key={i} position={[x, y, 0]}>
            <sphereGeometry args={[0.13, 12, 12]} />
            <meshStandardMaterial
              color={covered ? "#fbbf24" : color}
              emissive={covered ? "#fbbf24" : color}
              emissiveIntensity={covered ? 1.1 : 0.45}
              transparent
              opacity={state.opacity}
              toneMapped={false}
            />
          </mesh>
        );
      })}
    </>
  );
}

/**
 * An ordered list of real numbers as a bar row -- an embedding, a score row, a
 * distribution. Heights come from the paper's own `values`; when the model
 * supplied none, `normalizedValues` falls back to a deterministic ramp so the
 * form still reads as "an array" rather than vanishing.
 *
 * Bars keep constant geometry args and animate via scale/position: animated
 * `args` would dispose and rebuild the geometry on every frame.
 */
function ArrayForm({ actor, state }: { actor: SafeActor; state: ActorState }) {
  const color = toneColor(actor.tone);
  const negative = TONE_COLORS.inhibitor;
  const n = FORM_UNITS.array(actor);
  const values = normalizedValues(actor.values, n);
  const showLabels = actor.items.length > 0 && n <= 6 && state.opacity > 0.5;
  return (
    <>
      {values.slice(0, n).map((value, i) => {
        const grow = stagger(state.fraction >= 1 ? 1 : state.fraction, i, n, 0.6);
        const height = Math.max(0.08, Math.abs(value) * ARRAY_BAR_HEIGHT * grow);
        const [x] = FORM_ANCHORS.array(actor, i, n);
        return (
          <group key={i} position={[x, 0, 0]}>
            <mesh position={[0, height / 2 - 0.6, 0]} scale={[1, height, 1]}>
              <boxGeometry args={[0.3, 1, 0.3]} />
              <meshStandardMaterial
                color={value < 0 ? negative : color}
                emissive={value < 0 ? negative : color}
                emissiveIntensity={0.5}
                transparent
                opacity={state.opacity}
                toneMapped={false}
              />
            </mesh>
            {showLabels && actor.items[i] ? (
              <Html
                center
                position={[0, -0.9 - (i % 2) * 0.3, 0]}
                distanceFactor={13}
                style={{ pointerEvents: "none" }}
                zIndexRange={[17, 0]}
              >
                <div
                  className="whitespace-nowrap font-mono text-[9px] tracking-wide text-zinc-300"
                  style={{ opacity: state.opacity }}
                >
                  {actor.items[i]}
                </div>
              </Html>
            ) : null}
          </group>
        );
      })}
    </>
  );
}

function Lattice({ actor, state }: { actor: SafeActor; state: ActorState }) {
  const color = toneColor(actor.tone);
  const side = latticeSide(actor);
  // Real magnitudes drive per-cell brightness when the paper supplied them;
  // the noise sparkle is kept for old rows so stored scenes look unchanged.
  const magnitudes =
    actor.values.length > 0 ? normalizedValues(actor.values, side * side) : null;
  const cells: JSX.Element[] = [];
  for (let r = 0; r < side; r += 1) {
    for (let c = 0; c < side; c += 1) {
      const idx = r * side + c;
      const on = idx < side * side * state.fraction;
      const glow = magnitudes
        ? 0.1 + Math.abs(magnitudes[idx % magnitudes.length]) * 0.9
        : 0.35 + noise(idx) * 0.5;
      const [x, y] = FORM_ANCHORS.lattice(actor, idx, side * side);
      cells.push(
        <mesh key={idx} position={[x, y, 0]}>
          <boxGeometry args={[0.42, 0.42, 0.1]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={on ? glow : 0.05}
            transparent
            opacity={state.opacity * (on ? 1 : 0.22)}
            toneMapped={false}
          />
        </mesh>,
      );
    }
  }
  return <>{cells}</>;
}

function Blob({ actor, state }: { actor: SafeActor; state: ActorState }) {
  const color = toneColor(actor.tone);
  return (
    <mesh>
      <icosahedronGeometry args={[0.85, 2]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.4 + state.morph * 0.6}
        roughness={0.45}
        transparent
        opacity={state.opacity * 0.85}
        toneMapped={false}
      />
    </mesh>
  );
}

/**
 * The fallback for a form this build does not recognise. Deliberately a bare
 * wireframe rather than a convincing shape: drift between the backend
 * vocabulary and this registry should look broken, not plausible.
 */
function UnknownForm({ state }: { actor: SafeActor; state: ActorState }) {
  return (
    <mesh>
      <icosahedronGeometry args={[0.7, 1]} />
      <meshBasicMaterial
        color="#a1a1aa"
        wireframe
        transparent
        opacity={state.opacity * 0.6}
        toneMapped={false}
      />
    </mesh>
  );
}

function Field({ actor, state }: { actor: SafeActor; state: ActorState }) {
  const color = toneColor(actor.tone);
  const bands = 9;
  return (
    <>
      {Array.from({ length: bands }, (_, i) => {
        const u = i / (bands - 1);
        // Concentration falls off across the field; `fraction` scales the peak.
        const strength = (1 - u) * state.fraction;
        return (
          <mesh key={i} position={[(u - 0.5) * 4, 0, 0]}>
            <planeGeometry args={[0.44, 2.2]} />
            <meshBasicMaterial
              color={color}
              transparent
              opacity={state.opacity * (0.08 + strength * 0.5)}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        );
      })}
    </>
  );
}

function Vessel({ actor, state }: { actor: SafeActor; state: ActorState }) {
  const color = toneColor(actor.tone);
  return (
    <group>
      <mesh>
        <torusGeometry args={[1.15, 0.045, 12, 48]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.8}
          transparent
          opacity={state.opacity}
          toneMapped={false}
        />
      </mesh>
      <mesh>
        <circleGeometry args={[1.15, 40]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={state.opacity * 0.07}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

function Beam({ actor, state }: { actor: SafeActor; state: ActorState }) {
  const color = toneColor(actor.tone);
  // Constant geometry args; the animated length is applied through scale and
  // position so the cylinder is not disposed and rebuilt every frame.
  const factor = 0.4 + 0.6 * Math.max(state.fraction, 0.2);
  const length = 2.6 * factor;
  return (
    <group rotation={[0, 0, -Math.PI / 2]}>
      <mesh position={[0, length / 2, 0]} scale={[1, factor, 1]}>
        <cylinderGeometry args={[0.07, 0.07, 2.6, 10]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={1.1}
          transparent
          opacity={state.opacity}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[0, length + 0.18, 0]}>
        <coneGeometry args={[0.19, 0.4, 12]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={1.1}
          transparent
          opacity={state.opacity}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

function Marker({ actor, state }: { actor: SafeActor; state: ActorState }) {
  const color = toneColor(actor.tone);
  return (
    <group>
      <mesh>
        <octahedronGeometry args={[0.28, 0]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={1.2}
          transparent
          opacity={state.opacity}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[0, -0.55, 0]}>
        <cylinderGeometry args={[0.015, 0.015, 0.8, 6]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={state.opacity * 0.5}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

const FORMS: Record<
  string,
  (props: { actor: SafeActor; state: ActorState }) => JSX.Element
> = {
  particles: Particles,
  strand: Strand,
  array: ArrayForm,
  lattice: Lattice,
  blob: Blob,
  field: Field,
  vessel: Vessel,
  beam: Beam,
  marker: Marker,
};

// --- correspondence -----------------------------------------------------------

export type LinkPair = {
  from: THREE.Vector3;
  to: THREE.Vector3;
  weight: number;
};

/**
 * The unit-to-unit link endpoints for one `correspond` beat.
 *
 * Pairing is index-aligned over min(units, units); a singular endpoint (a
 * blob, a vessel) instead receives one link per unit of the other side -- a
 * fan -- because "five things become one thing" is still a correspondence.
 * Each end is pulled back along the link by the far form's extent so links
 * meet silhouettes rather than piercing them.
 */
export function correspondencePairs(
  beat: SceneBeat,
  actors: Map<string, SafeActor>,
  states: Map<string, ActorState>,
): LinkPair[] {
  const source = actors.get(beat.actor_id);
  const target = beat.target_id ? actors.get(beat.target_id) : undefined;
  const sourceState = states.get(beat.actor_id);
  const targetState = beat.target_id ? states.get(beat.target_id) : undefined;
  if (!source || !target || !sourceState || !targetState) return [];
  if (!sourceState.entered || sourceState.opacity <= 0.01) return [];
  if (!targetState.entered || targetState.opacity <= 0.01) return [];

  const a = (FORM_UNITS[source.form] ?? FORM_UNITS.blob)(source);
  const b = (FORM_UNITS[target.form] ?? FORM_UNITS.blob)(target);
  const n = Math.min(a === 1 || b === 1 ? Math.max(a, b) : Math.min(a, b), MAX_LINK_PAIRS);
  const weights = beatWeights(beat);

  const pairs: LinkPair[] = [];
  for (let i = 0; i < n; i += 1) {
    const weight = clamp01(weights.length > 0 ? weights[i % weights.length] : beat.magnitude || 1);
    if (weight < LINK_PRUNE) continue;
    const from = worldAnchor(source, sourceState, a === 1 ? 0 : i, a);
    const to = worldAnchor(target, targetState, b === 1 ? 0 : i, b);
    const direction = to.clone().sub(from);
    const length = direction.length();
    if (length < 1e-3) continue;
    direction.normalize();
    // Trim each end by the far side's silhouette, keeping >= 20% of the link.
    const fromTrim = (FORM_EXTENT[source.form] ?? FORM_EXTENT.blob)(source) * sourceState.scale;
    const toTrim = (FORM_EXTENT[target.form] ?? FORM_EXTENT.blob)(target) * targetState.scale;
    const usable = Math.max(length * 0.2, length - fromTrim - toTrim);
    const margin = (length - usable) / 2;
    pairs.push({
      from: from.clone().add(direction.clone().multiplyScalar(Math.min(fromTrim, margin))),
      to: to.clone().sub(direction.clone().multiplyScalar(Math.min(toTrim, margin))),
      weight,
    });
  }
  return pairs;
}

function CorrespondenceLinks({
  beats,
  actors,
  states,
  t,
}: {
  beats: SceneBeat[];
  actors: Map<string, SafeActor>;
  states: Map<string, ActorState>;
  t: number;
}) {
  return (
    <>
      {beats.map((beat, beatIndex) => {
        if (beat.kind !== "correspond") return null;
        const p = beatProgress(beat, t);
        if (p <= 0) return null;
        const finished = t > beat.start + beat.duration;
        const target = actors.get(beat.target_id);
        const color = toneColor(target?.tone ?? "neutral");
        const sourceOpacity = states.get(beat.actor_id)?.opacity ?? 0;
        const targetOpacity = states.get(beat.target_id)?.opacity ?? 0;
        const pairOpacity = Math.min(sourceOpacity, targetOpacity);
        const pairs = correspondencePairs(beat, actors, states);
        if (pairs.length === 0) return null;

        // The transformation happens *somewhere*: a translucent gate at the
        // bundle's midpoint gives the mapping a visible mechanism to pass
        // through, instead of lines appearing between unrelated objects.
        const mid = pairs
          .reduce(
            (acc, pair) => acc.add(pair.from).add(pair.to),
            new THREE.Vector3(),
          )
          .multiplyScalar(1 / (pairs.length * 2));
        const gateGlow = finished ? 0.25 : 0.5 + 0.5 * Math.sin(p * Math.PI);

        return (
          <group key={`c${beatIndex}`}>
            {pairs.map((pair, i) => {
              const reveal = stagger(p, i, pairs.length, 0.5);
              const hold = finished ? LINK_RESIDUAL : 1;
              const opacity = pairOpacity * reveal * pair.weight * hold;
              if (opacity <= 0.02) return null;
              return (
                <Link
                  key={`l${i}`}
                  from={pair.from}
                  to={pair.to}
                  color={color}
                  opacity={opacity}
                  thickness={0.012 + pair.weight * 0.02}
                />
              );
            })}
            <group position={mid.toArray()}>
              <mesh>
                <torusGeometry args={[0.55, 0.025, 10, 40]} />
                <meshStandardMaterial
                  color={color}
                  emissive={color}
                  emissiveIntensity={gateGlow * 1.4}
                  transparent
                  opacity={pairOpacity * (finished ? 0.35 : 0.85)}
                  toneMapped={false}
                />
              </mesh>
              <mesh>
                <circleGeometry args={[0.55, 32]} />
                <meshBasicMaterial
                  color={color}
                  transparent
                  opacity={pairOpacity * gateGlow * 0.12}
                  depthWrite={false}
                  side={THREE.DoubleSide}
                  toneMapped={false}
                />
              </mesh>
            </group>
            {/* While the beat plays, pulses travel the links: motion is what
                reads as "this becomes that", not the lines alone. */}
            {!finished && p > 0.05
              ? pairs
                  .filter((_, i) => i % Math.max(1, Math.ceil(pairs.length / 3)) === 0)
                  .map((pair, j) => {
                    const along = (p * 1.6 + j * 0.33) % 1;
                    const dot = pair.from.clone().lerp(pair.to, along);
                    return (
                      <mesh key={`p${j}`} position={dot.toArray()}>
                        <sphereGeometry args={[0.09, 10, 10]} />
                        <meshStandardMaterial
                          color={color}
                          emissive={color}
                          emissiveIntensity={1.6}
                          transparent
                          opacity={pairOpacity}
                          toneMapped={false}
                        />
                      </mesh>
                    );
                  })
              : null}
          </group>
        );
      })}
    </>
  );
}

function ActorView({
  actor,
  state,
  index,
}: {
  actor: SafeActor;
  state: ActorState;
  index: number;
}) {
  if (!state.entered || state.opacity <= 0.01) return null;
  const Form = FORMS[actor.form] ?? UnknownForm;
  // Every actor gets its own label line: with at most five actors, dropping
  // by the full index keeps names from overprinting even when two actors
  // meet at the same position mid-animation.
  const labelDrop = -1.05 - index * 0.38;
  return (
    <group position={state.position.toArray()} scale={state.scale}>
      <Form actor={actor} state={state} />
      <Html
        center
        position={[0, labelDrop, 0]}
        distanceFactor={13}
        style={{ pointerEvents: "none" }}
        zIndexRange={[18, 0]}
      >
        <div
          className="whitespace-nowrap rounded border border-zinc-700/50 bg-zinc-900/75 px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-zinc-200"
          style={{ opacity: state.opacity }}
        >
          {actor.label}
        </div>
      </Html>
    </group>
  );
}

/** Shown when the paper never describes a stage's internals. */
function UndescribedStage({ summary }: { summary: string }) {
  return (
    <group>
      <mesh rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[3.4, 2.2]} />
        <meshBasicMaterial color="#52525b" wireframe transparent opacity={0.4} />
      </mesh>
      <Html center distanceFactor={12} style={{ pointerEvents: "none" }} zIndexRange={[20, 0]}>
        <div className="max-w-[16rem] rounded-md border border-zinc-700 bg-zinc-900/90 px-3 py-2 text-center">
          <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
            not described in the paper
          </div>
          <div className="text-[11px] leading-snug text-zinc-400">{summary}</div>
        </div>
      </Html>
    </group>
  );
}

/** The caption of whichever beat is currently on screen. */
function activeCaption(beats: SceneBeat[], t: number): string {
  let caption = "";
  for (const beat of beats) {
    if (t >= beat.start && t <= beat.start + beat.duration && beat.caption) {
      caption = beat.caption;
    }
  }
  return caption;
}

export function SceneStage({ scene, t }: { scene: MechanismScene; t: number }) {
  if (!scene.described || !scene.actors || scene.actors.length === 0) {
    return <UndescribedStage summary={scene.summary} />;
  }

  const actors = scene.actors.map(safeActor);
  // Mirror of the backend's all-neutral repair, so scenes stored before it
  // existed also stop rendering as an all-grey cast.
  if (actors.length > 0 && actors.every((actor) => actor.tone === "neutral")) {
    const cycle = ["primary", "secondary", "signal", "product", "substrate"];
    actors.forEach((actor, i) => {
      actor.tone = cycle[i % cycle.length];
    });
  }
  const beats = scene.beats ?? [];
  const byId = new Map(actors.map((actor) => [actor.actor_id, actor]));

  // Actors that declare the same starting slot are fanned apart before any
  // beat runs (or, when the cast is piled on one slot with a known dataflow,
  // laid out left-to-right by who feeds whom).
  const offsets = slotOffsets(actors, beats);

  // `bind` and `correspond` need to know where other actors are, so resolve
  // every actor once with no context, then again with that map available. One
  // extra pass is enough: binding to something that is itself binding is not
  // a distinction the vocabulary can express.
  const bare = new Map<string, ActorState>();
  for (const actor of actors) {
    bare.set(
      actor.actor_id,
      actorStateAt(actor, beats, new Map(), t, offsets.get(actor.actor_id)),
    );
  }
  const states = new Map<string, ActorState>();
  for (const actor of actors) {
    states.set(
      actor.actor_id,
      actorStateAt(actor, beats, bare, t, offsets.get(actor.actor_id)),
    );
  }

  const caption = activeCaption(beats, t);

  return (
    <group>
      {/* A faint floor disc anchors the cast in space; without it the actors
          read as unrelated objects floating in a void. */}
      <mesh position={[0, -2.35, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[5.6, 48]} />
        <meshBasicMaterial
          color="#3f3f46"
          transparent
          opacity={0.08}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[0, -2.34, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[5.45, 5.6, 48]} />
        <meshBasicMaterial
          color="#52525b"
          transparent
          opacity={0.25}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      {/* Links render first so geometry draws over them. */}
      <CorrespondenceLinks beats={beats} actors={byId} states={states} t={t} />
      {actors.map((actor, index) => (
        <ActorView
          key={actor.actor_id}
          actor={actor}
          index={index}
          state={states.get(actor.actor_id) as ActorState}
        />
      ))}
      {caption ? (
        <Html
          center
          position={[0, 2.5, 0]}
          distanceFactor={14}
          style={{ pointerEvents: "none" }}
          zIndexRange={[19, 0]}
        >
          {/* w-max keeps the box shrink-wrapping to the sentence instead of
              collapsing to one word per line; max-w wraps long captions. */}
          <div className="w-max max-w-[26rem] rounded-md border border-zinc-700/80 bg-zinc-900/85 px-3 py-1.5 text-center text-[11px] leading-snug text-zinc-200">
            {caption}
          </div>
        </Html>
      ) : null}
    </group>
  );
}

export default SceneStage;
