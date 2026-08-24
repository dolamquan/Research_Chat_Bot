import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
  Edges,
  Environment,
  Grid,
  Html,
  Lightformer,
  MeshReflectorMaterial,
  OrbitControls,
} from "@react-three/drei";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";

import type { Diagram, DiagramEdge, DiagramGroup, DiagramNode, DiffState, MechanismScene, ProcessStep } from "../types";
import { diffTint, edgeStroke, nodeStroke } from "./diagramPalette";
import { CHASSIS_D, CHASSIS_H, CHASSIS_W, NodeAssembly } from "./NodeAssembly";
import { ProcessTheater, type TheaterControl } from "./ProcessTheater";

// 2D layout units (COLUMN_GAP=220, LAYER_GAP=130) -> world units.
// Depth (flow axis) gets more room than width so layers read clearly in 3D.
const SX = 1 / 55;
// Layers sit closer together than the 2D layout implies, so a long chain stays
// compact enough for the chassis detail to read at the default framing.
const SZ = 1 / 46;
const NODE_W = CHASSIS_W;
const NODE_H = CHASSIS_H;
const NODE_D = CHASSIS_D;
const BASE_Y = 1.35; // chassis center height above the floor

function nodePosition(node: DiagramNode): THREE.Vector3 {
  // 2D flows top-down (+y); in 3D the flow runs into the scene (+z).
  return new THREE.Vector3(node.x * SX, BASE_Y, node.y * SZ);
}

function buildCurve(
  source: THREE.Vector3,
  target: THREE.Vector3,
  back: boolean,
): THREE.QuadraticBezierCurve3 {
  const mid = source.clone().add(target).multiplyScalar(0.5);
  const dist = source.distanceTo(target);
  if (back) {
    mid.y += 2.4 + dist * 0.22;
    mid.x += Math.sign(mid.x || 1) * (2.6 + dist * 0.12);
  } else {
    mid.y += 0.45 + dist * 0.1;
  }
  return new THREE.QuadraticBezierCurve3(source, mid, target);
}

function Node3D({
  node,
  degree,
  selected,
  dimmed,
  hideLabel,
  storyboard,
  diffState,
  highlighted,
  onClick,
}: {
  node: DiagramNode;
  degree: number;
  selected: boolean;
  dimmed: boolean;
  hideLabel?: boolean;
  storyboard?: ProcessStep[];
  diffState?: DiffState;
  highlighted?: boolean;
  onClick: (node: DiagramNode) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const color = nodeStroke(node.kind);
  const position = useMemo(() => nodePosition(node), [node]);
  // Well-connected components read as bigger.
  const scale = 1 + Math.min(degree, 4) * 0.08;

  useEffect(() => {
    document.body.style.cursor = hovered ? "pointer" : "auto";
    return () => {
      document.body.style.cursor = "auto";
    };
  }, [hovered]);

  return (
    <group
      position={position}
      scale={scale}
      onClick={(event) => {
        event.stopPropagation();
        onClick(node);
      }}
      onPointerOver={(event) => {
        event.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={() => setHovered(false)}
    >
      <NodeAssembly
        node={node}
        degree={degree}
        selected={selected}
        hovered={hovered}
        dimmed={dimmed}
        spawnDelay={node.layer * 0.09}
        storyboard={storyboard}
        diffState={diffState}
      />
      {highlighted && (
        <mesh position={[0, -CHASSIS_H / 2 - 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.72, 0.95, 32]} />
          <meshBasicMaterial
            color="#fbbf24"
            transparent
            opacity={0.85}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
      )}
      {!dimmed && !hideLabel && (
        <Html
          center
          position={[0, CHASSIS_H + 0.62, 0]}
          distanceFactor={13}
          style={{ pointerEvents: "none" }}
          zIndexRange={[10, 0]}
        >
          <div
            className="flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] font-medium text-zinc-100 backdrop-blur-sm"
            style={{
              backgroundColor: "rgba(20,20,23,0.82)",
              borderColor: diffTint(diffState) ?? (selected ? color : "rgba(63,63,70,0.9)"),
              boxShadow: selected ? `0 0 12px ${color}55` : undefined,
              textDecoration: diffState === "removed" ? "line-through" : undefined,
            }}
          >
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: color }}
            />
            {node.label}
            <span className="font-mono text-[9px] text-zinc-500">
              L{node.layer}
            </span>
          </div>
        </Html>
      )}
    </group>
  );
}

function FlowDot({
  curve,
  color,
  offset,
  reverse,
}: {
  curve: THREE.QuadraticBezierCurve3;
  color: string;
  offset: number;
  reverse: boolean;
}) {
  const ref = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    let t = (((clock.getElapsedTime() * 0.28 + offset) % 1) + 1) % 1;
    if (reverse) t = 1 - t;
    ref.current?.position.copy(curve.getPoint(t));
  });
  return (
    <group ref={ref}>
      <mesh>
        <sphereGeometry args={[0.075, 12, 12]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      {/* soft halo so bloom picks the packet up as a light source */}
      <mesh>
        <sphereGeometry args={[0.17, 12, 12]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.28}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

function Edge3D({
  edge,
  curve,
  dimmed,
  diffState,
}: {
  edge: DiagramEdge;
  curve: THREE.QuadraticBezierCurve3;
  dimmed: boolean;
  diffState?: DiffState;
}) {
  const color = diffTint(diffState) ?? edgeStroke(edge.kind);
  const weak = edge.back || edge.kind === "reference" || diffState === "removed";

  const tube = useMemo(
    () => new THREE.TubeGeometry(curve, 40, weak ? 0.028 : 0.042, 8, false),
    [curve, weak],
  );

  // Arrow cone just before the target node's face.
  const arrow = useMemo(() => {
    const length = curve.getLength();
    const t = Math.max(0.55, 1 - 1.5 / Math.max(length, 0.001));
    const point = curve.getPoint(t);
    const tangent = curve.getTangent(t).normalize();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      tangent,
    );
    return { point, quaternion };
  }, [curve]);

  const midpoint = useMemo(() => curve.getPoint(0.5), [curve]);

  return (
    <group>
      <mesh geometry={tube}>
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={dimmed ? 0.05 : 0.8}
          roughness={0.25}
          metalness={0.6}
          transparent
          opacity={dimmed ? 0.08 : weak ? 0.4 : 0.72}
          toneMapped={false}
        />
      </mesh>
      <mesh position={arrow.point} quaternion={arrow.quaternion}>
        <coneGeometry args={[0.16, 0.45, 12]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={dimmed ? 0.05 : 0.4}
          transparent
          opacity={dimmed ? 0.08 : 1}
        />
      </mesh>
      {!dimmed &&
        diffState !== "removed" &&
        [0, 0.5].map((lead) => (
          <FlowDot
            key={lead}
            curve={curve}
            color={color}
            offset={
              (((midpoint.x * 7919 + midpoint.z * 104729) % 1) + lead + 1) % 1
            }
            reverse={false}
          />
        ))}
      {edge.label && !dimmed && (
        <Html
          center
          position={midpoint}
          distanceFactor={15}
          style={{ pointerEvents: "none" }}
          zIndexRange={[5, 0]}
        >
          <div className="whitespace-nowrap rounded bg-zinc-900/75 px-1.5 py-0.5 text-[10px] text-zinc-400">
            {edge.label}
          </div>
        </Html>
      )}
    </group>
  );
}

function Group3D({ group, nodes }: { group: DiagramGroup; nodes: DiagramNode[] }) {
  const members = nodes.filter((node) => node.group === group.id);
  if (members.length === 0) return null;

  const xs = members.map((node) => node.x * SX);
  const zs = members.map((node) => node.y * SZ);
  const minX = Math.min(...xs) - NODE_W / 2 - 0.7;
  const maxX = Math.max(...xs) + NODE_W / 2 + 0.7;
  const minZ = Math.min(...zs) - NODE_D / 2 - 0.9;
  const maxZ = Math.max(...zs) + NODE_D / 2 + 0.9;
  const height = 3.0;

  return (
    <group>
      <mesh position={[(minX + maxX) / 2, height / 2 + 0.02, (minZ + maxZ) / 2]}>
        <boxGeometry args={[maxX - minX, height, maxZ - minZ]} />
        <meshPhysicalMaterial
          color="#6ee7d8"
          transparent
          opacity={0.045}
          roughness={0.1}
          clearcoat={1}
          depthWrite={false}
        />
        <Edges threshold={15}>
          <lineBasicMaterial
            color="#6ee7d8"
            transparent
            opacity={0.35}
            toneMapped={false}
          />
        </Edges>
      </mesh>
      <Html
        position={[minX + 0.4, height + 0.35, minZ + 0.4]}
        distanceFactor={15}
        style={{ pointerEvents: "none" }}
        zIndexRange={[5, 0]}
      >
        <div className="whitespace-nowrap rounded bg-zinc-900/80 px-1.5 py-0.5 text-[10px] font-semibold text-teal-200/90">
          {group.label}
          {group.repeat ? ` · ${group.repeat}` : ""}
        </div>
      </Html>
    </group>
  );
}

function CameraFly({ focus }: { focus: THREE.Vector3 | null }) {
  const { camera, controls } = useThree() as {
    camera: THREE.Camera;
    controls: { target: THREE.Vector3; update: () => void } | null;
  };
  const animRef = useRef<{
    toPosition: THREE.Vector3;
    toTarget: THREE.Vector3;
    until: number;
  } | null>(null);

  useEffect(() => {
    if (!focus) {
      animRef.current = null;
      return;
    }
    animRef.current = {
      toPosition: focus.clone().add(new THREE.Vector3(0, 6.2, 14.5)),
      toTarget: focus.clone().add(new THREE.Vector3(0, 3.3, 0)),
      until: performance.now() + 1500,
    };
  }, [focus]);

  useFrame((_, delta) => {
    const anim = animRef.current;
    if (!anim || !controls) return;
    const k = 1 - Math.pow(0.002, delta);
    camera.position.lerp(anim.toPosition, k);
    controls.target.lerp(anim.toTarget, k);
    controls.update();
    if (performance.now() > anim.until) animRef.current = null;
  });
  return null;
}

function CameraRig({ center, radius }: { center: THREE.Vector3; radius: number }) {
  const { camera } = useThree();
  useEffect(() => {
    // Diagonal three-quarter view so the flow axis reads as depth.
    camera.position.set(
      center.x + radius * 0.95,
      center.y + radius * 0.6,
      center.z + radius * 0.85,
    );
    camera.lookAt(center);
    camera.updateProjectionMatrix();
  }, [camera, center, radius]);
  return null;
}

export function Visualizer3D({
  diagram,
  selectedNodeId,
  focusNodeId,
  processSteps,
  processScene,
  storyboards,
  diffStates,
  edgeDiffStates,
  highlightNodeIds,
  dimUnchanged,
  loopPlayback,
  theaterControl,
  onNodeClick,
  onCanvasReady,
  onPointerMissed,
  onStepChange,
  onPlaybackComplete,
}: {
  diagram: Diagram;
  selectedNodeId: string | null;
  focusNodeId?: string | null;
  processSteps?: ProcessStep[] | null;
  processScene?: MechanismScene | null;
  /** Per-node storyboards, used to build each chassis's internal machinery. */
  storyboards?: Record<string, ProcessStep[]>;
  diffStates?: Record<string, DiffState>;
  edgeDiffStates?: Record<string, DiffState>;
  highlightNodeIds?: string[];
  dimUnchanged?: boolean;
  loopPlayback?: boolean;
  theaterControl?: { current: TheaterControl };
  onNodeClick: (node: DiagramNode) => void;
  onCanvasReady?: (canvas: HTMLCanvasElement) => void;
  onPointerMissed?: () => void;
  onStepChange?: (index: number) => void;
  onPlaybackComplete?: () => void;
}) {
  const focusNode = focusNodeId
    ? diagram.nodes.find((node) => node.id === focusNodeId) ?? null
    : null;
  const focusPosition = useMemo(
    () => (focusNode ? nodePosition(focusNode) : null),
    [focusNode],
  );
  const laneMarkers = useMemo(() => {
    const byLayer = new Map<number, { z: number; minX: number; maxX: number }>();
    for (const node of diagram.nodes) {
      const z = node.y * SZ;
      const x = node.x * SX;
      const lane = byLayer.get(node.layer);
      if (lane) {
        lane.minX = Math.min(lane.minX, x);
        lane.maxX = Math.max(lane.maxX, x);
      } else {
        byLayer.set(node.layer, { z, minX: x, maxX: x });
      }
    }
    return [...byLayer.entries()].map(([layer, lane]) => ({
      layer,
      z: lane.z,
      width: lane.maxX - lane.minX + CHASSIS_W + 2.4,
    }));
  }, [diagram]);

  const { center, radius, degrees, curves } = useMemo(() => {
    const positions = new Map(
      diagram.nodes.map((node) => [node.id, nodePosition(node)]),
    );

    const degreeMap = new Map<string, number>();
    for (const edge of diagram.edges) {
      degreeMap.set(edge.source, (degreeMap.get(edge.source) ?? 0) + 1);
      degreeMap.set(edge.target, (degreeMap.get(edge.target) ?? 0) + 1);
    }

    const curveList = diagram.edges
      .map((edge) => {
        const source = positions.get(edge.source);
        const target = positions.get(edge.target);
        if (!source || !target) return null;
        return { edge, curve: buildCurve(source, target, edge.back) };
      })
      .filter(Boolean) as { edge: DiagramEdge; curve: THREE.QuadraticBezierCurve3 }[];

    const box = new THREE.Box3();
    for (const position of positions.values()) box.expandByPoint(position);
    const boxCenter = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    // Fit the true diagonal so nothing clips, with a small margin.
    const fitRadius = Math.max(size.length() * 0.92, 9);

    return {
      center: boxCenter,
      radius: fitRadius,
      degrees: degreeMap,
      curves: curveList,
    };
  }, [diagram]);

  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      camera={{ fov: 42, near: 0.1, far: 600 }}
      onCreated={(state) => onCanvasReady?.(state.gl.domElement)}
      onPointerMissed={() => onPointerMissed?.()}
    >
      <color attach="background" args={["#0c0c0e"]} />
      <fog attach="fog" args={["#0c0c0e", radius * 1.9, radius * 5.5]} />

      <ambientLight intensity={0.28} />
      <directionalLight position={[10, 18, 8]} intensity={0.85} />
      <pointLight position={[-12, 8, -6]} intensity={26} color="#6ee7d8" />
      <pointLight position={[14, 6, 10]} intensity={18} color="#a5b4fc" />

      {/* Studio reflections built from light shapes — no external HDR asset. */}
      <Environment resolution={128} frames={1}>
        <Lightformer
          intensity={2.4}
          form="rect"
          position={[0, 6, -8]}
          scale={[14, 4, 1]}
          color="#dfe7ff"
        />
        <Lightformer
          intensity={1.5}
          form="rect"
          rotation-y={Math.PI / 2}
          position={[-9, 3, 0]}
          scale={[10, 3, 1]}
          color="#6ee7d8"
        />
        <Lightformer
          intensity={1.2}
          form="rect"
          rotation-y={-Math.PI / 2}
          position={[9, 3, 0]}
          scale={[10, 3, 1]}
          color="#c4b5fd"
        />
        <Lightformer
          intensity={1.8}
          form="circle"
          rotation-x={Math.PI / 2}
          position={[0, 10, 0]}
          scale={8}
          color="#ffffff"
        />
      </Environment>

      <CameraRig center={center} radius={radius} />
      <CameraFly focus={focusPosition} />
      <OrbitControls
        makeDefault
        target={[center.x, center.y, center.z]}
        maxPolarAngle={Math.PI * 0.49}
        minDistance={4}
        maxDistance={radius * 4}
        enableDamping
      />

      {/* Polished floor: the whole assembly reflects into it. */}
      <mesh
        position={[center.x, -0.02, center.z]}
        rotation={[-Math.PI / 2, 0, 0]}
      >
        <planeGeometry args={[radius * 7, radius * 7]} />
        <MeshReflectorMaterial
          resolution={512}
          mixBlur={1.1}
          mixStrength={22}
          blur={[320, 90]}
          mirror={0.62}
          depthScale={1.1}
          minDepthThreshold={0.4}
          maxDepthThreshold={1.35}
          color="#0e0e11"
          metalness={0.72}
          roughness={0.92}
        />
      </mesh>

      <Grid
        position={[center.x, 0.005, center.z]}
        args={[radius * 6, radius * 6]}
        cellSize={1.5}
        cellColor="#1f1f24"
        sectionSize={7.5}
        sectionColor="#33333b"
        fadeDistance={radius * 3.0}
        fadeStrength={1.6}
      />

      {/* One lane marker per depth layer, so the flow axis is legible. */}
      {laneMarkers.map((lane) => (
        <mesh
          key={lane.layer}
          position={[center.x, 0.012, lane.z]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <planeGeometry args={[lane.width, 0.035]} />
          <meshBasicMaterial
            color="#6ee7d8"
            transparent
            opacity={0.16}
            toneMapped={false}
          />
        </mesh>
      ))}

      {diagram.groups.map((group) => (
        <Group3D key={group.id} group={group} nodes={diagram.nodes} />
      ))}

      {curves.map(({ edge, curve }, index) => (
        <Edge3D
          key={`${edge.source}-${edge.target}-${index}`}
          edge={edge}
          curve={curve}
          dimmed={focusNode !== null}
          diffState={edgeDiffStates?.[`${edge.source}->${edge.target}`]}
        />
      ))}

      {diagram.nodes.map((node) => (
        <Node3D
          key={`${node.id}-${diffStates?.[node.id] ?? "base"}`}
          node={node}
          degree={degrees.get(node.id) ?? 0}
          selected={selectedNodeId === node.id}
          dimmed={
            (focusNode !== null && focusNode.id !== node.id) ||
            (Boolean(dimUnchanged) &&
              focusNode === null &&
              diffStates?.[node.id] === "unchanged")
          }
          hideLabel={focusNode !== null && focusNode.id === node.id}
          storyboard={storyboards?.[node.id]}
          diffState={diffStates?.[node.id]}
          highlighted={highlightNodeIds?.includes(node.id)}
          onClick={onNodeClick}
        />
      ))}

      <EffectComposer multisampling={4}>
        <Bloom
          mipmapBlur
          intensity={0.85}
          luminanceThreshold={0.55}
          luminanceSmoothing={0.3}
        />
        <Vignette darkness={0.55} offset={0.28} />
      </EffectComposer>

      {focusNode && focusPosition && processSteps && processSteps.length > 0 && (
        <ProcessTheater
          key={focusNode.id}
          position={focusPosition}
          steps={processSteps}
          scene={processScene}
          loop={loopPlayback ?? true}
          control={theaterControl}
          onStepChange={onStepChange}
          onComplete={onPlaybackComplete}
        />
      )}
    </Canvas>
  );
}
