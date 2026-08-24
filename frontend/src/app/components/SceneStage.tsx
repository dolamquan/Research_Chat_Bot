import * as THREE from "three";
import { Html } from "@react-three/drei";

import type { MechanismScene, SceneActor, SceneBeat } from "../types";

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

/** Everything the renderers need to know about one actor at one instant. */
type ActorState = {
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

function initialState(actor: SceneActor): ActorState {
  return {
    position: slotVec(actor.at),
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
 * Fold every beat that touches this actor into a single state.
 *
 * Beats compose rather than override: a particle stream can be travelling and
 * depleting at once, which is what makes combinations expressive enough to
 * cover papers this code has never seen.
 */
function actorStateAt(
  actor: SceneActor,
  beats: SceneBeat[],
  positions: Map<string, THREE.Vector3>,
  t: number,
): ActorState {
  const state = initialState(actor);
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
        const target = beat.target_id ? positions.get(beat.target_id) : null;
        if (target) state.position = state.position.clone().lerp(target, eased * 0.92);
        break;
      }
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
    }
  }

  return state;
}

// --- form renderers ---------------------------------------------------------
//
// One per ActorForm. Each takes the resolved state and draws recognisable
// geometry; none of them know what the actor represents.

function Particles({ actor, state }: { actor: SceneActor; state: ActorState }) {
  const color = toneColor(actor.tone);
  const n = Math.max(1, Math.min(actor.count, 28));
  const shown = Math.max(1, Math.round(n * state.fraction));
  return (
    <>
      {Array.from({ length: n }, (_, i) => {
        const visible = i < shown;
        const ring = Math.floor(i / 6);
        const angle = (i % 6) * (Math.PI / 3) + ring * 0.4;
        const radius = 0.34 + ring * 0.32;
        const jx = (noise(i + 1) - 0.5) * state.dispersion * 3;
        const jy = (noise(i + 41) - 0.5) * state.dispersion * 3;
        return (
          <mesh
            key={i}
            position={[
              Math.cos(angle) * radius + jx,
              Math.sin(angle) * radius + jy,
              (noise(i + 91) - 0.5) * 0.5 + state.divergence * (i % 2 ? 1 : -1),
            ]}
            scale={visible ? 1 : 0.001}
          >
            <sphereGeometry args={[0.14, 14, 14]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={visible ? 0.7 : 0}
              transparent
              opacity={state.opacity * (visible ? 1 : 0)}
              toneMapped={false}
            />
          </mesh>
        );
      })}
    </>
  );
}

function Strand({ actor, state }: { actor: SceneActor; state: ActorState }) {
  const color = toneColor(actor.tone);
  const segments = Math.max(6, Math.min(actor.count * 2, 26));
  return (
    <>
      {Array.from({ length: segments }, (_, i) => {
        const u = i / (segments - 1);
        const x = (u - 0.5) * 4.2;
        const y = Math.sin(u * Math.PI * 2.2) * 0.34;
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

function Lattice({ actor, state }: { actor: SceneActor; state: ActorState }) {
  const color = toneColor(actor.tone);
  const side = Math.max(2, Math.min(Math.round(Math.sqrt(actor.count)) || 3, 6));
  const cells: JSX.Element[] = [];
  for (let r = 0; r < side; r += 1) {
    for (let c = 0; c < side; c += 1) {
      const idx = r * side + c;
      const on = idx < side * side * state.fraction;
      cells.push(
        <mesh
          key={idx}
          position={[(c - (side - 1) / 2) * 0.52, (r - (side - 1) / 2) * 0.52, 0]}
        >
          <boxGeometry args={[0.42, 0.42, 0.1]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={on ? 0.35 + noise(idx) * 0.5 : 0.05}
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

function Blob({ actor, state }: { actor: SceneActor; state: ActorState }) {
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

function Field({ actor, state }: { actor: SceneActor; state: ActorState }) {
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

function Vessel({ actor, state }: { actor: SceneActor; state: ActorState }) {
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

function Beam({ actor, state }: { actor: SceneActor; state: ActorState }) {
  const color = toneColor(actor.tone);
  const length = 2.6 * (0.4 + 0.6 * Math.max(state.fraction, 0.2));
  return (
    <group rotation={[0, 0, -Math.PI / 2]}>
      <mesh position={[0, length / 2, 0]}>
        <cylinderGeometry args={[0.07, 0.07, length, 10]} />
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

function Marker({ actor, state }: { actor: SceneActor; state: ActorState }) {
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
  (props: { actor: SceneActor; state: ActorState }) => JSX.Element
> = {
  particles: Particles,
  strand: Strand,
  lattice: Lattice,
  blob: Blob,
  field: Field,
  vessel: Vessel,
  beam: Beam,
  marker: Marker,
};

function ActorView({
  actor,
  state,
  index,
}: {
  actor: SceneActor;
  state: ActorState;
  index: number;
}) {
  if (!state.entered || state.opacity <= 0.01) return null;
  const Form = FORMS[actor.form] ?? Blob;
  // Actors sharing a slot would otherwise stack their labels on the same
  // line, so each caption drops a little further than the one before it.
  const labelDrop = -1.05 - (index % 3) * 0.42;
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
          className="whitespace-nowrap font-mono text-[10px] tracking-wide text-zinc-300"
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
  if (!scene.described || scene.actors.length === 0) {
    return <UndescribedStage summary={scene.summary} />;
  }

  // `bind` needs to know where its target currently is, so resolve every
  // actor's position first, then resolve again with that map available. One
  // extra pass is enough: binding to something that is itself binding is not
  // a distinction the vocabulary can express.
  const bare = new Map<string, THREE.Vector3>();
  for (const actor of scene.actors) {
    bare.set(actor.actor_id, actorStateAt(actor, scene.beats, new Map(), t).position);
  }

  const caption = activeCaption(scene.beats, t);

  return (
    <group>
      {scene.actors.map((actor, index) => (
        <ActorView
          key={actor.actor_id}
          actor={actor}
          index={index}
          state={actorStateAt(actor, scene.beats, bare, t)}
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
          <div className="max-w-[22rem] rounded-md border border-zinc-700/80 bg-zinc-900/85 px-3 py-1.5 text-center text-[11px] leading-snug text-zinc-200">
            {caption}
          </div>
        </Html>
      ) : null}
    </group>
  );
}

export default SceneStage;
