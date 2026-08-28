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

/** A pointwise function: the curve draws in, then values snap onto it. */
export function NonlinearityScene({ step, t, inputs, outputs, dimmed, onSelectEntity }: PrimitiveSceneProps) {
  const samples = 40;
  const opacity = dimmed ? 0.3 : 1;
  const draw = phase(t, 0, 0.55);
  const apply = phase(t, 0.5, 1);
  const values = normalizedValues(step.values, 6);
  return (
    <group>
      {Array.from({ length: samples }, (_, i) => {
        const u = i / (samples - 1);
        if (u > draw) return null;
        const x = (u - 0.5) * 6;
        // A ReLU-like bend: the shape most nonlinearity captions describe.
        const y = Math.max(0, x) * 0.42 - 0.6;
        return <Cell key={i} position={[x, y, 0]} color={PALETTE.cool} scale={0.28} opacity={opacity} shape="sphere" />;
      })}
      {values.map((value, i) => {
        const x = (i / Math.max(1, values.length - 1) - 0.5) * 5;
        const raw = value * 1.6;
        const gated = Math.max(0, raw);
        const y = THREE.MathUtils.lerp(raw, gated, apply) - 0.6;
        return (
          <Cell
            key={`v${i}`}
            position={[x, y, 0.35]}
            color={gated > 0 ? PALETTE.primary : PALETTE.muted}
            opacity={opacity}
          />
        );
      })}
      <EntityLabel entity={inputs[0]} position={[-3.4, 1.9, 0]} onSelect={onSelectEntity} />
      <EntityLabel entity={outputs[0]} position={[3.4, 1.9, 0]} onSelect={onSelectEntity} />
      <Caption text={step.caption} />
    </group>
  );
}

export default NonlinearityScene;
