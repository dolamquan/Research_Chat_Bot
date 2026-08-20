import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

import type { ProcessStep } from "../types";
import { primitiveColor } from "./diagramPalette";

/**
 * A stage's internal machinery, assembled from that stage's own storyboard
 * primitives. Two stages only look alike when the paper says they do the same
 * thing — a projection stage gets matrix grids, an attention stage gets a
 * weight fan, a softmax stage gets a distribution bank.
 *
 * Glyphs are static geometry carrying the meaning; ChainModule animates them
 * uniformly so an activation visibly sweeps along the chain.
 */

const SHARED_BOX = new THREE.BoxGeometry(1, 1, 1);

type GlyphProps = {
  step: ProcessStep;
  color: string;
};

/** Deterministic pseudo-random so a given stage always looks the same. */
function seeded(a: number, b: number): number {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function values(step: ProcessStep, fallback: number): number[] {
  const list = (step.values ?? []).filter((value) => Number.isFinite(value));
  if (list.length > 0) return list.slice(0, 6);
  return Array.from({ length: fallback }, (_, i) => 0.35 + seeded(i, 7) * 0.65);
}

/** A learned projection: a wireframe grid the data crosses. */
function MatrixGlyph({ color }: GlyphProps) {
  return (
    <group>
      <mesh rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[0.64, 0.64, 4, 4]} />
        <meshBasicMaterial
          color={color}
          wireframe
          transparent
          opacity={0.6}
          toneMapped={false}
        />
      </mesh>
      <mesh geometry={SHARED_BOX} scale={[0.05, 0.68, 0.68]}>
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.5}
          transparent
          opacity={0.28}
          metalness={0.85}
          roughness={0.18}
        />
      </mesh>
    </group>
  );
}

/** Weighted links fanning from one query — attention. */
function AttentionGlyph({ step, color }: GlyphProps) {
  const weights = values(step, 4);
  const max = Math.max(...weights, 0.001);
  const key = weights.join(",");

  const tubes = useMemo(() => {
    const origin = new THREE.Vector3(0, 0.32, 0);
    return weights.map((weight, index) => {
      const target = new THREE.Vector3(
        0,
        -0.3,
        (index - (weights.length - 1) / 2) * 0.2,
      );
      const curve = new THREE.QuadraticBezierCurve3(
        origin,
        origin.clone().lerp(target, 0.5).add(new THREE.Vector3(0.15, 0, 0)),
        target,
      );
      return new THREE.TubeGeometry(
        curve,
        10,
        0.01 + 0.03 * (weight / max),
        5,
        false,
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, max]);

  return (
    <group>
      <mesh position={[0, 0.32, 0]}>
        <sphereGeometry args={[0.08, 10, 10]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={1.1}
          toneMapped={false}
        />
      </mesh>
      {tubes.map((tube, index) => (
        <mesh key={index} geometry={tube}>
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.35 + 0.75 * (weights[index] / max)}
            transparent
            opacity={0.45 + 0.5 * (weights[index] / max)}
            toneMapped={false}
          />
        </mesh>
      ))}
      {weights.map((_, index) => (
        <mesh
          key={`k-${index}`}
          geometry={SHARED_BOX}
          position={[0, -0.34, (index - (weights.length - 1) / 2) * 0.2]}
          scale={[0.12, 0.07, 0.12]}
        >
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.5}
            metalness={0.6}
            roughness={0.3}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}

/** Bars of differing height — distributions, normalisation, activations. */
function BarBankGlyph({
  step,
  color,
  clip = false,
}: GlyphProps & { clip?: boolean }) {
  const raw = values(step, 5);
  const scale = Math.max(...raw.map(Math.abs), 0.001);
  return (
    <group>
      {raw.map((value, index) => {
        const negative = clip && value < 0;
        const height = (Math.abs(value) / scale) * (negative ? 0.12 : 0.62);
        return (
          <mesh
            key={index}
            geometry={SHARED_BOX}
            position={[
              0,
              -0.33 + height / 2,
              (index - (raw.length - 1) / 2) * 0.17,
            ]}
            scale={[0.11, Math.max(height, 0.02), 0.11]}
          >
            <meshStandardMaterial
              color={negative ? "#fca5a5" : color}
              emissive={negative ? "#fca5a5" : color}
              emissiveIntensity={negative ? 0.35 : 0.75}
              metalness={0.6}
              roughness={0.25}
              toneMapped={false}
            />
          </mesh>
        );
      })}
    </group>
  );
}

/** A row of discrete packets — tokens, documents, candidates. */
function StreamGlyph({ step, color }: GlyphProps) {
  const count = Math.min(Math.max(step.items.length || step.count || 4, 2), 6);
  return (
    <group>
      {Array.from({ length: count }, (_, index) => (
        <mesh
          key={index}
          geometry={SHARED_BOX}
          position={[0, 0, (index - (count - 1) / 2) * 0.19]}
          scale={[0.13, 0.21, 0.13]}
        >
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.7}
            metalness={0.55}
            roughness={0.3}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}

/** A column of cells — one embedding / feature vector. */
function VectorGlyph({ step, color }: GlyphProps) {
  const cells = values(step, 5);
  const scale = Math.max(...cells.map(Math.abs), 0.001);
  return (
    <group>
      {cells.map((value, index) => (
        <mesh
          key={index}
          geometry={SHARED_BOX}
          position={[0, (index - (cells.length - 1) / 2) * 0.16, 0]}
          scale={[0.14, 0.13, 0.14]}
        >
          <meshStandardMaterial
            color={value < 0 ? "#fca5a5" : color}
            emissive={value < 0 ? "#fca5a5" : color}
            emissiveIntensity={0.3 + 0.8 * (Math.abs(value) / scale)}
            metalness={0.6}
            roughness={0.25}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}

/** Diverging or converging rods — parallel branches. */
function BranchGlyph({
  step,
  color,
  merge = false,
}: GlyphProps & { merge?: boolean }) {
  const branches = Math.min(Math.max(step.count || 4, 2), 6);
  return (
    <group rotation={[0, merge ? Math.PI : 0, 0]}>
      <mesh
        geometry={SHARED_BOX}
        scale={[0.26, 0.07, 0.07]}
        position={[-0.2, 0, 0]}
      >
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.7}
          metalness={0.8}
          roughness={0.2}
          toneMapped={false}
        />
      </mesh>
      {Array.from({ length: branches }, (_, index) => (
        <mesh
          key={index}
          geometry={SHARED_BOX}
          position={[0.15, 0, (index - (branches - 1) / 2) * 0.17]}
          scale={[0.36, 0.05, 0.05]}
        >
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.55}
            metalness={0.75}
            roughness={0.25}
            toneMapped={false}
          />
        </mesh>
      ))}
    </group>
  );
}

/** Two inputs fusing into one — residual adds, concatenation. */
function CombineGlyph({ color }: GlyphProps) {
  return (
    <group>
      {[-0.19, 0.19].map((z) => (
        <mesh
          key={z}
          geometry={SHARED_BOX}
          position={[-0.16, 0, z]}
          scale={[0.3, 0.06, 0.06]}
        >
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.6}
            metalness={0.8}
            roughness={0.2}
            toneMapped={false}
          />
        </mesh>
      ))}
      <mesh position={[0.11, 0, 0]}>
        <sphereGeometry args={[0.12, 12, 12]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={1.2}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

/** A survivor gate — scoring then discarding. */
function GateGlyph({ step, color }: GlyphProps) {
  const scores = values(step, 5);
  const cutoff = [...scores].sort((a, b) => b - a)[
    Math.max(0, Math.ceil(scores.length / 2) - 1)
  ];
  return (
    <group>
      {scores.map((score, index) => {
        const kept = score >= cutoff;
        return (
          <mesh
            key={index}
            geometry={SHARED_BOX}
            position={[0, kept ? 0.08 : -0.3, (index - (scores.length - 1) / 2) * 0.18]}
            scale={[0.12, kept ? 0.18 : 0.1, 0.12]}
          >
            <meshStandardMaterial
              color={kept ? color : "#52525b"}
              emissive={kept ? color : "#52525b"}
              emissiveIntensity={kept ? 0.85 : 0.1}
              transparent
              opacity={kept ? 1 : 0.45}
              metalness={0.6}
              roughness={0.3}
              toneMapped={false}
            />
          </mesh>
        );
      })}
    </group>
  );
}

/** A spinning ring — iteration. */
function LoopGlyph({ color }: GlyphProps) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.rotation.x = clock.getElapsedTime() * 1.6;
  });
  return (
    <mesh ref={ref} rotation={[0, 0, Math.PI / 2]}>
      <torusGeometry args={[0.27, 0.045, 8, 20]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.8}
        metalness={0.75}
        roughness={0.2}
        toneMapped={false}
      />
    </mesh>
  );
}

/** Two representations measured against each other. */
function CompareGlyph({ color }: GlyphProps) {
  return (
    <group>
      {[-0.21, 0.21].map((z) => (
        <mesh key={z} geometry={SHARED_BOX} position={[0, 0, z]} scale={0.17}>
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={0.6}
            metalness={0.6}
            roughness={0.3}
            toneMapped={false}
          />
        </mesh>
      ))}
      <mesh geometry={SHARED_BOX} scale={[0.05, 0.05, 0.4]}>
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Glyph(props: GlyphProps) {
  switch (props.step.primitive) {
    case "matrix_transform":
      return <MatrixGlyph {...props} />;
    case "attention_links":
      return <AttentionGlyph {...props} />;
    case "distribution":
    case "normalize":
      return <BarBankGlyph {...props} />;
    case "nonlinearity":
      return <BarBankGlyph {...props} clip />;
    case "token_stream":
      return <StreamGlyph {...props} />;
    case "vector_array":
      return <VectorGlyph {...props} />;
    case "split_parallel":
      return <BranchGlyph {...props} />;
    case "merge_parallel":
      return <BranchGlyph {...props} merge />;
    case "elementwise_combine":
      return <CombineGlyph {...props} />;
    case "filter_select":
      return <GateGlyph {...props} />;
    case "loop_repeat":
      return <LoopGlyph {...props} />;
    case "compare":
      return <CompareGlyph {...props} />;
    default:
      return (
        <mesh>
          <octahedronGeometry args={[0.14]} />
          <meshStandardMaterial
            color={props.color}
            emissive={props.color}
            emissiveIntensity={0.6}
            toneMapped={false}
          />
        </mesh>
      );
  }
}

export const MAX_MODULES = 4;

/**
 * Consecutive repeats of the same primitive add clutter without adding
 * information, so they collapse into a single module.
 */
export function chainModules(steps: ProcessStep[]): ProcessStep[] {
  const collapsed: ProcessStep[] = [];
  for (const step of steps) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && previous.primitive === step.primitive) continue;
    collapsed.push(step);
  }
  return collapsed.slice(0, MAX_MODULES);
}

/** How wide a chassis must be to hold this stage's machinery. */
export function chassisWidthFor(steps: ProcessStep[] | undefined): number {
  const count = steps ? chainModules(steps).length : 0;
  if (count <= 0) return 3.1;
  return THREE.MathUtils.clamp(1.5 + count * 0.62, 2.6, 3.8);
}

/**
 * One module: static glyph geometry plus a per-frame activation sweep applied
 * to every descendant material, so the stage visibly works through its steps.
 */
function ChainModule({
  step,
  color,
  intensity,
  x,
  index,
  total,
}: {
  step: ProcessStep;
  color: string;
  intensity: number;
  x: number;
  index: number;
  total: number;
}) {
  const group = useRef<THREE.Group>(null);
  const bases = useRef<Map<THREE.Material, number> | null>(null);

  useFrame(({ clock }) => {
    const root = group.current;
    if (!root) return;

    if (bases.current === null) {
      bases.current = new Map();
      root.traverse((child) => {
        const material = (child as THREE.Mesh).material as
          | THREE.MeshStandardMaterial
          | undefined;
        if (material && "emissiveIntensity" in material) {
          bases.current!.set(material, material.emissiveIntensity);
        }
      });
    }

    // A single activation travels down the chain and repeats.
    const cycle = total * 0.55 + 0.7;
    const local = (clock.getElapsedTime() * 0.6 - index * 0.5) % cycle;
    const phase =
      local < 0 || local > 1 ? 0 : Math.sin(local * Math.PI) ** 0.7;

    root.position.y = phase * 0.05;
    bases.current.forEach((base, material) => {
      (material as THREE.MeshStandardMaterial).emissiveIntensity =
        base * intensity * (0.3 + 1.5 * phase);
    });
  });

  return (
    <group ref={group} position={[x, 0, 0]}>
      <Glyph step={step} color={color} />
    </group>
  );
}

export function MechanismChain({
  steps,
  intensity,
  width,
}: {
  steps: ProcessStep[];
  intensity: number;
  width: number;
}) {
  const modules = chainModules(steps);
  const usable = width * 0.7;
  const spacing = modules.length > 1 ? usable / (modules.length - 1) : 0;

  return (
    // Scaled so the machinery fills the chassis rather than floating inside it.
    <group scale={1.5}>
      {/* rail the modules are mounted on */}
      <mesh geometry={SHARED_BOX} scale={[width * 0.86, 0.026, 0.026]}>
        <meshStandardMaterial color="#d4d4d8" metalness={0.95} roughness={0.2} />
      </mesh>
      {modules.map((step, index) => (
        <ChainModule
          key={`${step.primitive}-${index}`}
          step={step}
          color={primitiveColor(step.primitive)}
          intensity={intensity}
          index={index}
          total={modules.length}
          x={modules.length > 1 ? -usable / 2 + index * spacing : 0}
        />
      ))}
    </group>
  );
}
