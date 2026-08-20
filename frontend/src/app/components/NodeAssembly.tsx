import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { RoundedBox } from "@react-three/drei";

import type { DiagramNode, DiffState, ProcessStep } from "../types";
import { diffTint, nodeStroke } from "./diagramPalette";
import { MechanismChain, chassisWidthFor } from "./MechanismChain";

/**
 * Each stage renders as a translucent chassis containing a glowing internal
 * mechanism whose form reflects what the stage does — a plate stack for
 * layered operations, a lattice for data stores, a rotor for loops — so the
 * geometry itself carries information rather than being a plain block.
 */

export const CHASSIS_W = 3.1;
export const CHASSIS_H = 1.25;
export const CHASSIS_D = 1.25;

type MechanismProps = {
  color: string;
  intensity: number;
  degree: number;
  seed: number;
};

/** Stacked plates — layered transforms (component / operation). */
function PlateStack({ color, intensity, degree }: MechanismProps) {
  const plates = Math.min(4 + Math.floor(degree / 2), 8);
  const group = useRef<THREE.Group>(null);
  const spacing = (CHASSIS_W * 0.74) / plates;

  useFrame(({ clock }) => {
    if (!group.current) return;
    const t = clock.getElapsedTime();
    group.current.children.forEach((child, index) => {
      const mesh = child as THREE.Mesh;
      // A pulse travels along the stack, reading as signal propagation.
      const wave = 0.5 + 0.5 * Math.sin(t * 2 - index * 0.7);
      mesh.position.x = (index - (plates - 1) / 2) * spacing;
      mesh.scale.y = 0.94 + wave * 0.1;
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.emissiveIntensity = intensity * (0.35 + 0.8 * wave);
    });
  });

  return (
    <group>
      {/* spine the plates are mounted on */}
      <mesh rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.035, 0.035, CHASSIS_W * 0.86, 10]} />
        <meshStandardMaterial
          color="#d4d4d8"
          metalness={0.95}
          roughness={0.2}
        />
      </mesh>
      <group ref={group}>
        {Array.from({ length: plates }, (_, index) => (
          <mesh key={index}>
            <boxGeometry args={[0.055, CHASSIS_H * 0.66, CHASSIS_D * 0.7]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={intensity}
              roughness={0.18}
              metalness={0.65}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>
    </group>
  );
}

/** A 3D lattice of cells — stored/indexed data. */
function Lattice({ color, intensity, seed }: MechanismProps) {
  const cells = useMemo(() => {
    const list: [number, number, number, number][] = [];
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 2; y++) {
        for (let z = 0; z < 2; z++) {
          const jitter = Math.abs(Math.sin((x + 1) * (y + 2) * (z + 3) + seed));
          list.push([
            (x - 2) * 0.5,
            (y - 0.5) * 0.42,
            (z - 0.5) * 0.42,
            0.4 + jitter * 0.6,
          ]);
        }
      }
    }
    return list;
  }, [seed]);

  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!group.current) return;
    const t = clock.getElapsedTime();
    group.current.children.forEach((child, index) => {
      const mesh = child as THREE.Mesh;
      const material = mesh.material as THREE.MeshStandardMaterial;
      // Cells pulse in a travelling wave, reading as active memory.
      material.emissiveIntensity =
        intensity * (0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * 1.6 - index * 0.5)));
    });
  });

  return (
    <group ref={group}>
      {cells.map(([x, y, z, weight], index) => (
        <mesh key={index} position={[x, y, z]}>
          <boxGeometry args={[0.26, 0.26, 0.26]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={intensity * weight}
            roughness={0.3}
            metalness={0.5}
          />
        </mesh>
      ))}
    </group>
  );
}

/** A spinning rotor — iteration / looping. */
function Rotor({ color, intensity }: MechanismProps) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.rotation.x = clock.getElapsedTime() * 1.1;
  });
  return (
    <group ref={ref} rotation={[0, 0, Math.PI / 2]}>
      <mesh>
        <torusGeometry args={[0.42, 0.07, 10, 28]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={intensity}
          roughness={0.2}
          metalness={0.7}
        />
      </mesh>
      {[0, 1, 2].map((index) => (
        <mesh key={index} rotation={[0, 0, (index * Math.PI * 2) / 3]}>
          <boxGeometry args={[0.78, 0.05, 0.14]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={intensity * 0.6}
            roughness={0.3}
            metalness={0.6}
          />
        </mesh>
      ))}
    </group>
  );
}

/** A caged core — held state. */
function CoreSphere({ color, intensity }: MechanismProps) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const pulse = 0.5 + 0.5 * Math.sin(clock.getElapsedTime() * 2.1);
    const material = ref.current.material as THREE.MeshStandardMaterial;
    material.emissiveIntensity = intensity * (0.55 + 0.75 * pulse);
    ref.current.scale.setScalar(0.94 + pulse * 0.09);
  });
  return (
    <group>
      <mesh ref={ref}>
        <icosahedronGeometry args={[0.36, 1]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={intensity}
          roughness={0.15}
          metalness={0.4}
        />
      </mesh>
      <mesh>
        <icosahedronGeometry args={[0.54, 0]} />
        <meshBasicMaterial color={color} wireframe transparent opacity={0.28} />
      </mesh>
    </group>
  );
}

/** A funnel of rings — a stream entering or leaving the system. */
function StreamRings({ color, intensity }: MechanismProps) {
  const group = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!group.current) return;
    const t = clock.getElapsedTime();
    group.current.children.forEach((child, index) => {
      const mesh = child as THREE.Mesh;
      const phase = (t * 0.5 + index / 5) % 1;
      mesh.position.x = (phase - 0.5) * 2.3;
      const material = mesh.material as THREE.MeshStandardMaterial;
      material.emissiveIntensity =
        intensity * (0.3 + 0.9 * Math.sin(phase * Math.PI));
      const scale = 0.55 + 0.45 * Math.sin(phase * Math.PI);
      mesh.scale.setScalar(scale);
    });
  });
  return (
    <group ref={group}>
      {Array.from({ length: 5 }, (_, index) => (
        <mesh key={index} rotation={[0, 0, Math.PI / 2]}>
          <torusGeometry args={[0.34, 0.045, 8, 22]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={intensity}
            roughness={0.25}
            metalness={0.6}
          />
        </mesh>
      ))}
    </group>
  );
}

/** Two diverging arms — a branch point. */
function Switch({ color, intensity }: MechanismProps) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    // The arm sweeps between the two branches.
    ref.current.rotation.z =
      Math.sin(clock.getElapsedTime() * 1.3) * 0.42 - 0.1;
  });
  return (
    <group>
      <mesh>
        <sphereGeometry args={[0.13, 12, 12]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={intensity * 1.3}
        />
      </mesh>
      <group ref={ref}>
        <mesh position={[0.32, 0, 0]}>
          <boxGeometry args={[0.62, 0.07, 0.1]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={intensity}
            metalness={0.6}
            roughness={0.3}
          />
        </mesh>
      </group>
      {[-0.34, 0.34].map((y) => (
        <mesh key={y} position={[0.72, y, 0]}>
          <boxGeometry args={[0.1, 0.1, 0.1]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={intensity * 0.5}
          />
        </mesh>
      ))}
    </group>
  );
}

function Mechanism({ kind, ...props }: MechanismProps & { kind: string }) {
  switch (kind) {
    case "input":
    case "output":
      return <StreamRings {...props} />;
    case "data":
      return <Lattice {...props} />;
    case "loop":
      return <Rotor {...props} />;
    case "state":
      return <CoreSphere {...props} />;
    case "decision":
      return <Switch {...props} />;
    default:
      return <PlateStack {...props} />;
  }
}

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

/**
 * A machined cage: twelve struts plus corner blocks. Explicit geometry reads
 * far crisper than edge-detection outlines on a smoothed box.
 */
function Frame({
  color,
  opacity,
  width,
}: {
  color: string;
  opacity: number;
  width: number;
}) {
  const struts = useMemo(() => {
    const w = width;
    const h = CHASSIS_H;
    const d = CHASSIS_D;
    const t = 0.045;
    const list: { position: [number, number, number]; scale: [number, number, number] }[] = [];
    // four rails along the length
    for (const y of [-h / 2, h / 2]) {
      for (const z of [-d / 2, d / 2]) {
        list.push({ position: [0, y, z], scale: [w, t, t] });
      }
    }
    // four uprights
    for (const x of [-w / 2, w / 2]) {
      for (const z of [-d / 2, d / 2]) {
        list.push({ position: [x, 0, z], scale: [t, h, t] });
      }
    }
    // four cross members
    for (const x of [-w / 2, w / 2]) {
      for (const y of [-h / 2, h / 2]) {
        list.push({ position: [x, y, 0], scale: [t, t, d] });
      }
    }
    return list;
  }, [width]);

  const corners = useMemo(() => {
    const list: [number, number, number][] = [];
    for (const x of [-width / 2, width / 2]) {
      for (const y of [-CHASSIS_H / 2, CHASSIS_H / 2]) {
        for (const z of [-CHASSIS_D / 2, CHASSIS_D / 2]) {
          list.push([x, y, z]);
        }
      }
    }
    return list;
  }, [width]);

  return (
    <group>
      {struts.map((strut, index) => (
        <mesh
          key={index}
          geometry={UNIT_BOX}
          position={strut.position}
          scale={strut.scale}
        >
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={opacity * 1.1}
            metalness={0.9}
            roughness={0.22}
            toneMapped={false}
          />
        </mesh>
      ))}
      {corners.map((position, index) => (
        <mesh key={index} geometry={UNIT_BOX} position={position} scale={0.11}>
          <meshStandardMaterial
            color="#d4d4d8"
            metalness={0.95}
            roughness={0.18}
            emissive={color}
            emissiveIntensity={opacity * 0.4}
          />
        </mesh>
      ))}
    </group>
  );
}

/** A thin emissive plane sweeping the chassis — an instrument taking a reading. */
function ScanPlane({
  color,
  active,
  width,
}: {
  color: string;
  active: boolean;
  width: number;
}) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.getElapsedTime() * 0.55;
    const cycle = (t % 2) / 2; // 0..1
    ref.current.position.x = (cycle - 0.5) * width;
    const material = ref.current.material as THREE.MeshBasicMaterial;
    material.opacity = active
      ? 0.3 * Math.sin(cycle * Math.PI) ** 0.6
      : 0.09 * Math.sin(cycle * Math.PI) ** 0.6;
  });
  return (
    <mesh ref={ref} rotation={[0, Math.PI / 2, 0]}>
      <planeGeometry args={[CHASSIS_D * 0.92, CHASSIS_H * 0.92]} />
      <meshBasicMaterial
        color={color}
        transparent
        opacity={0.15}
        side={THREE.DoubleSide}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}

/** Emissive sockets where edges dock into the chassis. */
function Ports({ color, intensity }: { color: string; intensity: number }) {
  return (
    <group>
      {[-1, 1].map((side) => (
        <mesh
          key={side}
          position={[0, 0, (side * CHASSIS_D) / 2]}
          rotation={[side > 0 ? 0 : Math.PI, 0, 0]}
        >
          <cylinderGeometry args={[0.16, 0.2, 0.07, 16]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={intensity * 1.4}
            roughness={0.3}
            metalness={0.7}
          />
        </mesh>
      ))}
    </group>
  );
}

export function NodeAssembly({
  node,
  degree,
  selected,
  hovered,
  dimmed,
  spawnDelay,
  storyboard,
  diffState,
}: {
  node: DiagramNode;
  degree: number;
  selected: boolean;
  hovered: boolean;
  dimmed: boolean;
  spawnDelay: number;
  /** This stage's own process steps, when the paper has been read for it. */
  storyboard?: ProcessStep[];
  /** How this stage differs from the diagram it was modified from. */
  diffState?: DiffState;
}) {
  // Two colour channels: the cage says how this stage differs from the
  // original, the machinery keeps saying what the stage does. Overloading
  // `kind` would change which mechanism geometry renders.
  const color = nodeStroke(node.kind);
  const cageColor = diffTint(diffState) ?? color;
  const removed = diffState === "removed";
  const seed = useMemo(
    () => node.id.split("").reduce((total, ch) => total + ch.charCodeAt(0), 0),
    [node.id],
  );

  const root = useRef<THREE.Group>(null);
  const detail = useRef<THREE.Group>(null);
  const coarse = useRef<THREE.Group>(null);
  const mountedAt = useRef<number | null>(null);
  const worldPosition = useRef(new THREE.Vector3());

  useFrame(({ clock, camera }) => {
    if (!root.current) return;

    // Level of detail: the internal machinery only resolves when the camera is
    // close enough for it to read, keeping wide shots uncluttered.
    root.current.getWorldPosition(worldPosition.current);
    const near = camera.position.distanceTo(worldPosition.current) < 26;
    if (detail.current) detail.current.visible = near;
    if (coarse.current) coarse.current.visible = !near;

    if (mountedAt.current === null) mountedAt.current = clock.getElapsedTime();
    // Staggered assembly: each chassis rises and settles into place.
    const elapsed = clock.getElapsedTime() - mountedAt.current - spawnDelay;
    const p = THREE.MathUtils.clamp(elapsed / 0.75, 0, 1);
    const eased = 1 - Math.pow(1 - p, 3);
    root.current.scale.setScalar(eased * (0.86 + 0.14 * eased));
    root.current.position.y = (1 - eased) * -1.6;
    root.current.visible = p > 0;
  });

  // Stages with more internal steps need a longer chassis, so silhouettes
  // differ per stage rather than every block being identical.
  const width = chassisWidthFor(storyboard);
  const emissive = dimmed ? 0.05 : selected ? 1.6 : hovered ? 1.0 : 0.6;
  const shellOpacity = removed ? 0.03 : dimmed ? 0.05 : 0.1;
  const edgeOpacity = removed
    ? 0.22
    : dimmed
      ? 0.1
      : (selected ? 0.95 : hovered ? 0.7 : 0.4) +
        (diffState === "added" || diffState === "changed" ? 0.25 : 0);

  return (
    <group ref={root}>
      {/* glass shell + machined cage */}
      <RoundedBox
        args={[width, CHASSIS_H, CHASSIS_D]}
        radius={0.14}
        smoothness={4}
      >
        <meshPhysicalMaterial
          color={cageColor}
          transparent
          opacity={shellOpacity}
          roughness={0.06}
          metalness={0}
          clearcoat={1}
          clearcoatRoughness={0.04}
          ior={1.45}
          depthWrite={false}
        />
      </RoundedBox>
      <Frame color={cageColor} opacity={edgeOpacity} width={width} />
      {!dimmed && !removed && (
        <ScanPlane color={cageColor} active={selected || hovered} width={width} />
      )}

      {/* Internal machinery: built from this stage's own storyboard when the
          paper has been read for it, otherwise a form implied by its kind. */}
      {!dimmed && !removed && (
        <>
          <group ref={detail}>
            {storyboard && storyboard.length > 0 ? (
              <MechanismChain
                steps={storyboard}
                intensity={emissive}
                width={width}
              />
            ) : (
              <Mechanism
                kind={node.kind}
                color={color}
                intensity={emissive}
                degree={degree}
                seed={seed}
              />
            )}
          </group>
          {/* Far-away stand-in: one glowing core bar per stage. */}
          <group ref={coarse} visible={false}>
            <mesh geometry={UNIT_BOX} scale={[width * 0.62, 0.34, 0.34]}>
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={emissive * 0.9}
                metalness={0.7}
                roughness={0.25}
                toneMapped={false}
              />
            </mesh>
          </group>
        </>
      )}

      <Ports
        color={cageColor}
        intensity={dimmed || removed ? 0.05 : emissive * 0.7}
      />

      {/* pedestal + emissive base ring anchor the chassis to the floor */}
      <group position={[0, -CHASSIS_H / 2 - 0.06, 0]}>
        <mesh>
          <cylinderGeometry args={[0.38, 0.5, 0.09, 24]} />
          <meshStandardMaterial
            color="#1c1c20"
            roughness={0.55}
            metalness={0.6}
            transparent
            opacity={dimmed ? 0.2 : 1}
          />
        </mesh>
        <mesh position={[0, 0.055, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.4, 0.52, 28]} />
          <meshBasicMaterial
            color={cageColor}
            transparent
            opacity={
              dimmed
                ? 0.08
                : diffState === "added"
                  ? 0.95
                  : selected
                    ? 0.9
                    : 0.42
            }
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
      </group>
    </group>
  );
}
