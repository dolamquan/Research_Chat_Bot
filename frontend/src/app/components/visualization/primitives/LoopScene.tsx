import * as THREE from "three";

import type { PrimitiveSceneProps } from "../sceneTypes";
import {
  Caption,
  Cell,
  EntityLabel,
  Link,
  PALETTE,
  clamp01,
  easeInOut,
  normalizedValues,
  phase,
  seriesColor,
  spread,
  stagger,
  unitCount,
} from "./shared";

/** A block repeated a stated number of times, shown as a travelling cycle. */
export function LoopScene({ step, t, inputs, outputs, dimmed, onSelectEntity }: PrimitiveSceneProps) {
  const iterations = Math.max(2, Math.min(step.count || 3, 8));
  const opacity = dimmed ? 0.3 : 1;
  const ring = 1.7;
  const angle = t * Math.PI * 2 * iterations;
  return (
    <group>
      {Array.from({ length: 48 }, (_, i) => {
        const a = (i / 48) * Math.PI * 2;
        return (
          <Cell
            key={i}
            position={[Math.cos(a) * ring, Math.sin(a) * ring, 0]}
            color={PALETTE.muted}
            scale={0.2}
            opacity={opacity * 0.5}
            shape="sphere"
          />
        );
      })}
      <Cell
        position={[Math.cos(angle) * ring, Math.sin(angle) * ring, 0]}
        color={PALETTE.accent}
        scale={1.1}
        opacity={opacity}
      />
      {Array.from({ length: iterations }, (_, i) => {
        const a = (i / iterations) * Math.PI * 2;
        const done = t * iterations > i;
        return (
          <Cell
            key={`m${i}`}
            position={[Math.cos(a) * (ring + 0.55), Math.sin(a) * (ring + 0.55), 0]}
            color={done ? PALETTE.primary : PALETTE.muted}
            scale={0.32}
            opacity={opacity}
            shape="sphere"
          />
        );
      })}
      <EntityLabel entity={inputs[0]} position={[-3.4, 1.8, 0]} onSelect={onSelectEntity} />
      <EntityLabel entity={outputs[0]} position={[3.4, 1.8, 0]} onSelect={onSelectEntity} />
      <Caption text={step.caption ? `${step.caption} (x${iterations})` : ""} />
    </group>
  );
}

export default LoopScene;
