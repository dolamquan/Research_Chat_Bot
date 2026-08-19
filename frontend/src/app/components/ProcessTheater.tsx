import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { Html, RoundedBox } from "@react-three/drei";

import type { ProcessStep } from "../types";

/** Animated diorama that plays a node's process storyboard in the 3D scene. */

const STEP_SECONDS = 4.2;
const LOOP_GAP_SECONDS = 0.8;

const TEAL = "#6ee7d8";
const AMBER = "#fbbf24";
const PURPLE = "#a5b4fc";
const PINK = "#f0abfc";
const RED = "#fca5a5";
const DIM = "#52525b";

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Progress remapped into the [start, end] window of a step. */
function phase(t: number, start: number, end: number): number {
  return clamp01((t - start) / (end - start));
}

/** Deterministic pseudo-random in [0,1) from integers. */
function hash(...values: number[]): number {
  let h = 2166136261;
  for (const value of values) {
    h = Math.imul(h ^ Math.floor(value * 1013), 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** Real extracted numbers for this step, when the model supplied them. */
function stepValues(step: ProcessStep): number[] {
  return (step.values ?? []).filter((value) => Number.isFinite(value));
}

function formatValue(value: number): string {
  const rounded = Math.abs(value) >= 10 ? value.toFixed(0) : value.toFixed(2);
  return rounded.replace(/\.00$/, "");
}

/** Signed magnitude -> color, so negatives read differently from positives. */
function valueColor(value: number, scale: number): THREE.Color {
  const magnitude = Math.min(Math.abs(value) / (scale || 1), 1);
  return value < 0
    ? new THREE.Color().setHSL(0.98, 0.55, 0.42 + 0.22 * magnitude)
    : new THREE.Color().setHSL(0.47, 0.55, 0.4 + 0.25 * magnitude);
}

function NumberTag({
  value,
  position,
  highlight = false,
}: {
  value: number;
  position: [number, number, number];
  highlight?: boolean;
}) {
  return (
    <Html
      center
      position={position}
      distanceFactor={9}
      style={{ pointerEvents: "none" }}
      zIndexRange={[20, 0]}
    >
      <div
        className={`whitespace-nowrap rounded px-1 font-mono text-[9px] ${
          highlight ? "bg-amber-500/20 text-amber-200" : "text-zinc-400"
        }`}
      >
        {formatValue(value)}
      </div>
    </Html>
  );
}

function ChipLabel({ text, y = -0.55 }: { text: string; y?: number }) {
  return (
    <Html
      center
      position={[0, y, 0]}
      distanceFactor={9}
      style={{ pointerEvents: "none" }}
      zIndexRange={[20, 0]}
    >
      <div className="whitespace-nowrap rounded bg-zinc-900/85 px-1.5 py-0.5 text-[10px] text-zinc-200">
        {text}
      </div>
    </Html>
  );
}

function DetailLabel({ text, position }: { text: string; position: [number, number, number] }) {
  if (!text) return null;
  return (
    <Html
      center
      position={position}
      distanceFactor={10}
      style={{ pointerEvents: "none" }}
      zIndexRange={[20, 0]}
    >
      <div className="whitespace-nowrap rounded-md border border-zinc-700 bg-zinc-900/90 px-2 py-0.5 font-mono text-[10px] text-amber-200/90">
        {text}
      </div>
    </Html>
  );
}

function Chip({
  color,
  label,
  opacity = 1,
  width = 1.25,
}: {
  color: string;
  label?: string;
  opacity?: number;
  width?: number;
}) {
  return (
    <group>
      <RoundedBox args={[width, 0.55, 0.28]} radius={0.1} smoothness={3}>
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.35}
          transparent
          opacity={opacity}
        />
      </RoundedBox>
      {label ? <ChipLabel text={label} /> : null}
    </group>
  );
}

// ---------------------------------------------------------------- primitives

function TokenStream({ step, t }: { step: ProcessStep; t: number }) {
  const labels = step.items.length > 0 ? step.items : [];
  const n = labels.length || Math.min(step.count, 6) || 4;
  return (
    <group>
      {Array.from({ length: n }, (_, i) => {
        const p = easeInOut(phase(t, i * 0.08, 0.55 + i * 0.08));
        const targetX = (i - (n - 1) / 2) * 1.55;
        const x = THREE.MathUtils.lerp(-6.5, targetX, p);
        return (
          <group key={i} position={[x, 0, 0]}>
            <Chip color={TEAL} label={labels[i]} opacity={0.25 + 0.75 * p} />
          </group>
        );
      })}
      <DetailLabel text={step.detail} position={[0, 1.35, 0]} />
    </group>
  );
}

function VectorArray({ step, t }: { step: ProcessStep; t: number }) {
  const values = stepValues(step);
  const hasValues = values.length > 0;
  const n = Math.min(step.count || step.items.length || 4, 8);
  const cells = hasValues ? values.length : 6;
  const scale = hasValues ? Math.max(...values.map(Math.abs), 0.001) : 1;

  return (
    <group>
      {Array.from({ length: n }, (_, i) => {
        const x = (i - (n - 1) / 2) * 0.9;
        const front = i === Math.floor((n - 1) / 2);
        return (
          <group key={i} position={[x, -1.1, 0]}>
            {Array.from({ length: cells }, (_, j) => {
              const p = easeInOut(
                phase(t, 0.06 * i + 0.05 * j, 0.5 + 0.06 * i + 0.05 * j),
              );
              // Real component values when available, drifting slightly per
              // column so the array doesn't look like one vector copy-pasted.
              const value = hasValues
                ? values[j] * (1 - 0.18 * (i - (n - 1) / 2) * (j % 2 ? 1 : -1) * 0.4)
                : 0;
              const color = hasValues
                ? valueColor(value, scale)
                : new THREE.Color().setHSL(0.45 + 0.25 * hash(i, j), 0.55, 0.62);
              return (
                <group key={j} position={[0, j * 0.4, 0]}>
                  <mesh scale={[1, Math.max(p, 0.001), 1]}>
                    <boxGeometry args={[0.55, 0.34, 0.34]} />
                    <meshStandardMaterial
                      color={color}
                      emissive={color}
                      emissiveIntensity={0.3}
                      transparent
                      opacity={0.35 + 0.65 * p}
                    />
                  </mesh>
                  {hasValues && front && p > 0.6 && (
                    <NumberTag value={values[j]} position={[0.62, 0, 0]} />
                  )}
                </group>
              );
            })}
            {step.items[i] ? <ChipLabel text={step.items[i]} y={-0.5} /> : null}
          </group>
        );
      })}
      <DetailLabel text={step.detail} position={[0, 1.9, 0]} />
    </group>
  );
}

function MatrixTransform({ step, t }: { step: ProcessStep; t: number }) {
  const n = 4;
  const inColor = new THREE.Color(TEAL);
  const outColor = new THREE.Color(PURPLE);
  return (
    <group>
      {/* the learned matrix: a vertical wireframe grid the data passes through */}
      <mesh rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[2.6, 2.6, 6, 6]} />
        <meshBasicMaterial color={AMBER} wireframe transparent opacity={0.5} />
      </mesh>
      {Array.from({ length: n }, (_, i) => {
        const p = easeInOut(phase(t, i * 0.1, 0.75 + i * 0.08));
        const x = THREE.MathUtils.lerp(-3.6, 3.6, p);
        const crossed = x > 0;
        const color = crossed ? outColor : inColor;
        const y = (i - (n - 1) / 2) * 0.62;
        return (
          <mesh key={i} position={[x, y, 0]}>
            <boxGeometry args={[0.75, 0.42, 0.3]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={crossed ? 0.5 : 0.25}
            />
          </mesh>
        );
      })}
      <DetailLabel text={step.detail || step.label_out} position={[0, 1.9, 0]} />
    </group>
  );
}

/** Real attention weights: one query fanning out to every unit. */
function WeightedAttention({ step, t }: { step: ProcessStep; t: number }) {
  const weights = stepValues(step);
  const n = weights.length;
  const maxWeight = Math.max(...weights, 0.001);
  const strongest = weights.indexOf(maxWeight);

  // Built once per step: tube thickness encodes the weight, so geometry is
  // static and only material opacity animates.
  const geometry = useMemo(() => {
    const query = new THREE.Vector3(0, 1.7, 0);
    return weights.map((weight, i) => {
      const target = new THREE.Vector3((i - (n - 1) / 2) * 1.35, -0.8, 0);
      const mid = query.clone().add(target).multiplyScalar(0.5);
      mid.x *= 0.72;
      const curve = new THREE.QuadraticBezierCurve3(query, mid, target);
      const width = 0.014 + 0.08 * (weight / maxWeight);
      return {
        target,
        tube: new THREE.TubeGeometry(curve, 22, width, 7, false),
      };
    });
  }, [weights, n, maxWeight]);

  useEffect(() => {
    return () => geometry.forEach((item) => item.tube.dispose());
  }, [geometry]);

  return (
    <group>
      {/* the query unit */}
      <mesh position={[0, 1.7, 0]}>
        <sphereGeometry args={[0.32, 18, 18]} />
        <meshStandardMaterial color={AMBER} emissive={AMBER} emissiveIntensity={0.55} />
      </mesh>
      <group position={[0, 1.7, 0]}>
        <ChipLabel text={step.label_in || "query"} y={0.62} />
      </group>

      {geometry.map(({ target, tube }, i) => {
        const relative = weights[i] / maxWeight;
        const reveal = easeInOut(phase(t, 0.08 + i * 0.06, 0.5 + i * 0.06));
        const settle = easeInOut(phase(t, 0.55, 0.9));
        const isStrongest = i === strongest;
        return (
          <group key={i}>
            <mesh geometry={tube}>
              <meshStandardMaterial
                color={isStrongest ? AMBER : PINK}
                emissive={isStrongest ? AMBER : PINK}
                emissiveIntensity={0.3 + 0.4 * relative}
                transparent
                opacity={reveal * (0.2 + 0.75 * relative)}
              />
            </mesh>
            <mesh position={target}>
              <sphereGeometry args={[0.24, 14, 14]} />
              <meshStandardMaterial
                color={TEAL}
                emissive={TEAL}
                emissiveIntensity={0.2 + 0.5 * relative * settle}
              />
            </mesh>
            {reveal > 0.7 && (
              <NumberTag
                value={weights[i]}
                position={[target.x, target.y + 0.62, target.z]}
                highlight={isStrongest}
              />
            )}
            {step.items[i] ? (
              <group position={target}>
                <ChipLabel text={step.items[i]} y={-0.55} />
              </group>
            ) : null}
          </group>
        );
      })}
      <DetailLabel text={step.detail} position={[0, 2.75, 0]} />
    </group>
  );
}

/** Fallback when the paper yields no concrete weights: pairwise exchange arcs. */
function PairwiseAttention({ step, t }: { step: ProcessStep; t: number }) {
  const n = Math.min(step.count || 6, 8);
  const positions = useMemo(
    () =>
      Array.from(
        { length: n },
        (_, i) => new THREE.Vector3((i - (n - 1) / 2) * 1.15, -0.7, 0),
      ),
    [n],
  );
  const links = useMemo(() => {
    const list: { geometry: THREE.TubeGeometry; i: number; j: number; weight: number }[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (!(j - i === 1 || hash(i, j) > 0.55)) continue;
        const start = positions[i];
        const end = positions[j];
        const mid = start
          .clone()
          .add(end)
          .multiplyScalar(0.5)
          .add(new THREE.Vector3(0, 0.5 + (j - i) * 0.34, 0));
        const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
        const weight = 0.3 + 0.7 * hash(i, j, 7);
        list.push({
          geometry: new THREE.TubeGeometry(curve, 20, 0.02 + weight * 0.04, 6, false),
          i,
          j,
          weight,
        });
        if (list.length >= 14) return list;
      }
    }
    return list;
  }, [n, positions]);

  useEffect(() => {
    return () => links.forEach((link) => link.geometry.dispose());
  }, [links]);

  return (
    <group>
      {positions.map((position, i) => (
        <mesh key={i} position={position}>
          <sphereGeometry args={[0.26, 16, 16]} />
          <meshStandardMaterial color={TEAL} emissive={TEAL} emissiveIntensity={0.4} />
        </mesh>
      ))}
      {links.map(({ geometry, i, j, weight }, index) => {
        const pulse = Math.max(0, Math.sin(t * Math.PI * 4 + hash(i, j, 3) * Math.PI * 2));
        const reveal = phase(t, 0.05 + 0.03 * index, 0.4 + 0.03 * index);
        return (
          <mesh key={index} geometry={geometry}>
            <meshBasicMaterial
              color={PINK}
              transparent
              opacity={reveal * (0.18 + 0.55 * pulse * weight)}
            />
          </mesh>
        );
      })}
      <DetailLabel text={step.detail} position={[0, 2.0, 0]} />
      {step.items.slice(0, n).map((item, i) => (
        <group key={`label-${i}`} position={positions[i]}>
          <ChipLabel text={item} y={-0.65} />
        </group>
      ))}
    </group>
  );
}

/** Hook-free dispatcher: each branch keeps its own hooks in its own component. */
function AttentionLinks({ step, t }: { step: ProcessStep; t: number }) {
  return stepValues(step).length > 1 ? (
    <WeightedAttention step={step} t={t} />
  ) : (
    <PairwiseAttention step={step} t={t} />
  );
}

function SplitParallel({ step, t, merge = false }: { step: ProcessStep; t: number; merge?: boolean }) {
  const n = Math.min(step.count || 4, 8);
  const sourceX = merge ? 3.2 : -3.2;
  const targetX = merge ? -2.2 : 2.2;
  return (
    <group>
      <group position={[sourceX, 0, 0]}>
        <Chip color={TEAL} label={merge ? step.label_out || undefined : step.label_in || undefined} />
      </group>
      {Array.from({ length: n }, (_, i) => {
        const y = (i - (n - 1) / 2) * 0.62;
        const p = easeInOut(phase(t, 0.08 + i * 0.05, 0.7 + i * 0.04));
        const from = new THREE.Vector3(sourceX + (merge ? -0.8 : 0.8), 0, 0);
        const to = new THREE.Vector3(targetX, y, 0);
        const dot = from.clone().lerp(to, merge ? 1 - p : p);
        return (
          <group key={i}>
            <mesh position={dot}>
              <sphereGeometry args={[0.14, 10, 10]} />
              <meshBasicMaterial color={AMBER} />
            </mesh>
            <mesh position={[targetX + (merge ? -0.9 : 0.9), y, 0]} scale={[1, Math.max(p, 0.001), 1]}>
              <boxGeometry args={[1.1, 0.4, 0.26]} />
              <meshStandardMaterial
                color={PURPLE}
                emissive={PURPLE}
                emissiveIntensity={0.3}
                transparent
                opacity={0.3 + 0.7 * p}
              />
            </mesh>
          </group>
        );
      })}
      <DetailLabel
        text={step.detail || `${n} parallel ${merge ? "branches merge" : "branches"}`}
        position={[0, 2.0, 0]}
      />
    </group>
  );
}

function ElementwiseCombine({ step, t }: { step: ProcessStep; t: number }) {
  const p = easeInOut(phase(t, 0.05, 0.55));
  const emerge = easeInOut(phase(t, 0.55, 0.9));
  return (
    <group>
      <group position={[THREE.MathUtils.lerp(-3.4, -0.85, p), 0, 0]}>
        <Chip color={TEAL} label={step.label_in || undefined} />
      </group>
      <group position={[THREE.MathUtils.lerp(3.4, 0.85, p), 0, 0]}>
        <Chip color={PINK} />
      </group>
      <Html center position={[0, 0, 0.4]} distanceFactor={8} style={{ pointerEvents: "none" }} zIndexRange={[20, 0]}>
        <div
          className="font-mono text-lg font-bold text-amber-300"
          style={{ opacity: p > 0.85 ? 1 : p * 0.6, transform: `scale(${1 + emerge * 0.4})` }}
        >
          {step.detail || "+"}
        </div>
      </Html>
      <group position={[0, 0.55 + emerge * 0.85, 0]} scale={Math.max(emerge, 0.001)}>
        <Chip color={PURPLE} label={step.label_out || undefined} width={1.6} />
      </group>
    </group>
  );
}

function Nonlinearity({ step, t }: { step: ProcessStep; t: number }) {
  const values = stepValues(step);
  // Real pre-activation values when the paper gives them, so the reader sees
  // exactly which entries the activation clips.
  const raws =
    values.length > 0
      ? values
      : Array.from({ length: 7 }, (_, i) => hash(i, 11) * 2 - 1);
  const n = raws.length;
  const scale = Math.max(...raws.map(Math.abs), 0.001);
  const gateX = THREE.MathUtils.lerp(-3.6, 3.6, easeInOut(phase(t, 0.15, 0.75)));

  return (
    <group>
      <mesh position={[gateX, 0, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[1.6, 2.6]} />
        <meshBasicMaterial color={AMBER} transparent opacity={0.25} side={THREE.DoubleSide} />
      </mesh>
      {raws.map((raw, i) => {
        const x = (i - (n - 1) / 2) * 1.0;
        const normalized = (raw / scale) * 1.15;
        const passed = gateX > x;
        const height =
          passed && normalized < 0
            ? normalized * (1 - easeInOut(phase(t, 0.2 + i * 0.06, 0.6 + i * 0.06)))
            : normalized;
        const clipped = passed && raw < 0;
        return (
          <group key={i}>
            <mesh position={[x, height / 2, 0]}>
              <boxGeometry args={[0.55, Math.max(Math.abs(height), 0.02), 0.35]} />
              <meshStandardMaterial
                color={height < 0 ? RED : TEAL}
                emissive={height < 0 ? RED : TEAL}
                emissiveIntensity={0.3}
              />
            </mesh>
            {values.length > 0 && (
              <NumberTag
                value={clipped ? 0 : raw}
                position={[x, normalized > 0 ? normalized + 0.32 : 0.32, 0]}
                highlight={clipped}
              />
            )}
          </group>
        );
      })}
      <DetailLabel text={step.detail || "activation"} position={[0, 1.9, 0]} />
    </group>
  );
}

function Normalize({ step, t }: { step: ProcessStep; t: number }) {
  const values = stepValues(step);
  const raws =
    values.length > 0
      ? values
      : Array.from({ length: 7 }, (_, i) => 0.3 + 1.6 * hash(i, 23));
  const n = raws.length;
  const p = easeInOut(phase(t, 0.15, 0.8));

  // Softmax when the paper says so, otherwise scale to a common range.
  const softmax = /softmax/i.test(step.detail);
  const normalized = useMemo(() => {
    if (softmax) {
      const shifted = raws.map((value) => Math.exp(value - Math.max(...raws)));
      const sum = shifted.reduce((total, value) => total + value, 0) || 1;
      return shifted.map((value) => value / sum);
    }
    const max = Math.max(...raws.map(Math.abs), 0.001);
    return raws.map((value) => value / max);
  }, [raws, softmax]);

  const rawScale = Math.max(...raws.map(Math.abs), 0.001);
  const normScale = Math.max(...normalized.map(Math.abs), 0.001);

  return (
    <group>
      {raws.map((raw, i) => {
        const x = (i - (n - 1) / 2) * 1.0;
        const from = (raw / rawScale) * 1.7;
        const to = (normalized[i] / normScale) * 1.7;
        const height = THREE.MathUtils.lerp(from, to, p);
        return (
          <group key={i}>
            <mesh position={[x, height / 2 - 0.8, 0]}>
              <boxGeometry args={[0.55, Math.max(Math.abs(height), 0.02), 0.35]} />
              <meshStandardMaterial
                color={TEAL}
                emissive={TEAL}
                emissiveIntensity={0.25 + 0.3 * p}
              />
            </mesh>
            {values.length > 0 && (
              <NumberTag
                value={THREE.MathUtils.lerp(raw, normalized[i], p)}
                position={[x, height - 0.5, 0]}
                highlight={p > 0.9}
              />
            )}
          </group>
        );
      })}
      <DetailLabel text={step.detail || "normalize"} position={[0, 1.9, 0]} />
    </group>
  );
}

function Distribution({ step, t }: { step: ProcessStep; t: number }) {
  const labels = step.items;
  const values = stepValues(step);
  const n = values.length || labels.length || Math.min(step.count || 6, 10);
  // Real probabilities when supplied, so bar heights carry actual meaning.
  const raws =
    values.length > 0
      ? values
      : Array.from({ length: n }, (_, i) => 0.25 + 1.8 * hash(i, 31));
  const scale = Math.max(...raws.map(Math.abs), 0.001);
  const heights = raws.map((value) => (Math.abs(value) / scale) * 1.9);
  const maxIndex = raws.indexOf(Math.max(...raws));
  return (
    <group>
      {Array.from({ length: n }, (_, i) => {
        const p = easeInOut(phase(t, 0.05 + i * 0.06, 0.55 + i * 0.06));
        const height = heights[i] * p;
        const isMax = i === maxIndex;
        const glow = isMax ? 0.35 + 0.5 * phase(t, 0.7, 0.95) : 0.25;
        return (
          <group key={i} position={[(i - (n - 1) / 2) * 0.95, 0, 0]}>
            <mesh position={[0, height / 2 - 0.9, 0]}>
              <boxGeometry args={[0.55, Math.max(height, 0.02), 0.35]} />
              <meshStandardMaterial
                color={isMax ? AMBER : PURPLE}
                emissive={isMax ? AMBER : PURPLE}
                emissiveIntensity={glow}
              />
            </mesh>
            {values.length > 0 && p > 0.5 && (
              <NumberTag
                value={raws[i]}
                position={[0, height - 0.62, 0]}
                highlight={isMax}
              />
            )}
            {labels[i] ? <ChipLabel text={labels[i]} y={-1.25} /> : null}
          </group>
        );
      })}
      <DetailLabel text={step.detail} position={[0, 1.9, 0]} />
    </group>
  );
}

function FilterSelect({ step, t }: { step: ProcessStep; t: number }) {
  const labels = step.items;
  const values = stepValues(step);
  const n = values.length || labels.length || Math.min(step.count || 6, 8);
  const drop = easeInOut(phase(t, 0.4, 0.85));

  // With real scores, survivors are the genuine top half by score.
  const cutoff = useMemo(() => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => b - a);
    const keepCount = Math.max(1, Math.ceil(sorted.length / 2));
    return sorted[keepCount - 1];
  }, [values]);

  return (
    <group>
      {Array.from({ length: n }, (_, i) => {
        const kept =
          cutoff === null ? hash(i, 41) > 0.45 : values[i] >= cutoff;
        const x = (i - (n - 1) / 2) * 1.5;
        const y = kept ? 0 : -drop * 2.2;
        const opacity = kept ? 1 : 1 - drop * 0.85;
        return (
          <group key={i} position={[x, y, 0]}>
            <Chip color={kept ? TEAL : DIM} label={labels[i]} opacity={opacity} />
            {values.length > 0 && (
              <NumberTag value={values[i]} position={[0, 0.55, 0]} highlight={kept} />
            )}
          </group>
        );
      })}
      <DetailLabel text={step.detail || "select"} position={[0, 1.6, 0]} />
    </group>
  );
}

const COMPARE_ARC = new THREE.TubeGeometry(
  new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(-1.3, 0, 0),
    new THREE.Vector3(0, 1.3, 0),
    new THREE.Vector3(1.3, 0, 0),
  ),
  20,
  0.04,
  6,
  false,
);

function Compare({ step, t }: { step: ProcessStep; t: number }) {
  const p = easeInOut(phase(t, 0.05, 0.5));
  const meter = easeInOut(phase(t, 0.5, 0.9));
  return (
    <group>
      <group position={[THREE.MathUtils.lerp(-3.6, -1.3, p), 0, 0]}>
        <Chip color={TEAL} label={step.label_in || undefined} />
      </group>
      <group position={[THREE.MathUtils.lerp(3.6, 1.3, p), 0, 0]}>
        <Chip color={PINK} />
      </group>
      <mesh geometry={COMPARE_ARC}>
        <meshBasicMaterial color={AMBER} transparent opacity={0.2 + 0.7 * meter} />
      </mesh>
      <DetailLabel text={step.detail || "similarity"} position={[0, 2.0, 0]} />
    </group>
  );
}

function LoopRepeat({ step, t }: { step: ProcessStep; t: number }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    if (ref.current) ref.current.rotation.z = -t * Math.PI * 3;
  });
  return (
    <group>
      <group ref={ref}>
        <mesh>
          <torusGeometry args={[1.1, 0.09, 12, 40, Math.PI * 1.6]} />
          <meshStandardMaterial color={AMBER} emissive={AMBER} emissiveIntensity={0.4} />
        </mesh>
        <mesh position={[1.1 * Math.cos(Math.PI * 1.6), 1.1 * Math.sin(Math.PI * 1.6), 0]} rotation={[0, 0, Math.PI * 1.6 + Math.PI / 2]}>
          <coneGeometry args={[0.22, 0.5, 10]} />
          <meshStandardMaterial color={AMBER} emissive={AMBER} emissiveIntensity={0.4} />
        </mesh>
      </group>
      <Html center distanceFactor={9} style={{ pointerEvents: "none" }} zIndexRange={[20, 0]}>
        <div className="whitespace-nowrap rounded bg-zinc-900/85 px-2 py-0.5 text-xs font-semibold text-amber-200">
          {step.count ? `× ${step.count}` : "repeat"}
          {step.detail ? ` ${step.detail}` : ""}
        </div>
      </Html>
    </group>
  );
}

function Note({ t }: { t: number }) {
  const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 4);
  return (
    <mesh>
      <sphereGeometry args={[0.28, 16, 16]} />
      <meshStandardMaterial color={TEAL} emissive={TEAL} emissiveIntensity={0.2 + 0.5 * pulse} />
    </mesh>
  );
}

/** Per-primitive framing: keep each scene inside the backdrop panel. */
function framingScale(step: ProcessStep): number {
  const values = stepValues(step);
  const items = step.items.length || values.length || step.count || 4;
  switch (step.primitive) {
    case "token_stream":
      // items spread at 1.55 apart
      return Math.min(1, 8.6 / Math.max(items * 1.55, 1));
    case "vector_array":
      return Math.min(1, 7.4 / Math.max(Math.min(items, 8) * 0.9, 1)) * 0.92;
    case "attention_links":
      // the weighted layout is taller (query above the row) and wider per unit
      return values.length > 1
        ? Math.min(0.86, 8.6 / Math.max(values.length * 1.35, 1))
        : Math.min(1, 8.4 / Math.max(Math.min(items, 8) * 1.15, 1)) * 0.95;
    case "split_parallel":
    case "merge_parallel":
      return Math.min(1, 4.6 / Math.max(Math.min(items, 8) * 0.62, 1));
    case "distribution":
    case "filter_select":
      return Math.min(1, 8.6 / Math.max(items * (step.primitive === "distribution" ? 0.95 : 1.5), 1));
    default:
      return 1;
  }
}

function StepScene({ step, t }: { step: ProcessStep; t: number }) {
  switch (step.primitive) {
    case "token_stream":
      return <TokenStream step={step} t={t} />;
    case "vector_array":
      return <VectorArray step={step} t={t} />;
    case "matrix_transform":
      return <MatrixTransform step={step} t={t} />;
    case "attention_links":
      return <AttentionLinks step={step} t={t} />;
    case "split_parallel":
      return <SplitParallel step={step} t={t} />;
    case "merge_parallel":
      return <SplitParallel step={step} t={t} merge />;
    case "elementwise_combine":
      return <ElementwiseCombine step={step} t={t} />;
    case "nonlinearity":
      return <Nonlinearity step={step} t={t} />;
    case "normalize":
      return <Normalize step={step} t={t} />;
    case "distribution":
      return <Distribution step={step} t={t} />;
    case "filter_select":
      return <FilterSelect step={step} t={t} />;
    case "compare":
      return <Compare step={step} t={t} />;
    case "loop_repeat":
      return <LoopRepeat step={step} t={t} />;
    default:
      return <Note t={t} />;
  }
}

export type TheaterControl = {
  paused: boolean;
  seekStep: number | null;
};

export function ProcessTheater({
  position,
  steps,
  loop,
  control,
  onStepChange,
  onComplete,
}: {
  position: THREE.Vector3;
  steps: ProcessStep[];
  loop: boolean;
  control?: { current: TheaterControl };
  onStepChange?: (index: number) => void;
  onComplete?: () => void;
}) {
  const [stepIndex, setStepIndex] = useState(0);
  const [t, setT] = useState(0);
  const elapsedRef = useRef(0);
  const doneRef = useRef(false);

  useEffect(() => {
    elapsedRef.current = 0;
    doneRef.current = false;
    setStepIndex(0);
    setT(0);
  }, [steps]);

  useFrame((_, delta) => {
    if (steps.length === 0) return;
    const ctrl = control?.current;

    if (ctrl && ctrl.seekStep !== null) {
      elapsedRef.current = ctrl.seekStep * STEP_SECONDS;
      ctrl.seekStep = null;
      doneRef.current = false;
    } else if (!ctrl?.paused && !doneRef.current) {
      elapsedRef.current += Math.min(delta, 0.1);
    }

    const total = steps.length * STEP_SECONDS;
    let elapsed = elapsedRef.current;

    if (elapsed >= total) {
      if (loop) {
        if (elapsed >= total + LOOP_GAP_SECONDS) {
          elapsedRef.current = 0;
          elapsed = 0;
        } else {
          return;
        }
      } else {
        elapsedRef.current = total;
        if (!doneRef.current) {
          doneRef.current = true;
          onComplete?.();
        }
        return;
      }
    }

    const index = Math.min(Math.floor(elapsed / STEP_SECONDS), steps.length - 1);
    const local = (elapsed - index * STEP_SECONDS) / STEP_SECONDS;
    if (index !== stepIndex) {
      setStepIndex(index);
      onStepChange?.(index);
    }
    setT(local);
  });

  if (steps.length === 0) return null;
  const step = steps[Math.min(stepIndex, steps.length - 1)];

  // Enter/exit envelope: each step's scene grows and rises in, then sinks out,
  // so step changes read as transitions instead of hard cuts.
  const envelope = Math.min(
    easeInOut(phase(t, 0, 0.09)),
    1 - easeInOut(phase(t, 0.93, 1)),
  );

  return (
    <group position={[position.x, position.y + 3.4, position.z]}>
      {/* backdrop panel for readability */}
      <mesh position={[0, 0.3, -0.9]}>
        <planeGeometry args={[10.5, 6]} />
        <meshBasicMaterial color="#111113" transparent opacity={0.72} />
      </mesh>
      <group
        scale={framingScale(step) * (0.82 + 0.18 * envelope)}
        position={[0, (1 - envelope) * 0.45, 0]}
      >
        <StepScene step={step} t={t} />
      </group>
    </group>
  );
}
