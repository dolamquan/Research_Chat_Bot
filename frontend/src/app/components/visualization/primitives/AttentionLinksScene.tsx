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

/** Weighted connections between two rows, brightening in weight order. */
export function AttentionLinksScene({ step, t, inputs, outputs, dimmed, onSelectEntity }: PrimitiveSceneProps) {
  const n = unitCount(step.count, step.items, 7);
  const weights = normalizedValues(step.values, n);
  const opacity = dimmed ? 0.3 : 1;
  return (
    <group>
      {Array.from({ length: n }, (_, i) => (
        <Cell key={`q${i}`} position={[spread(i, n), 1.6, 0]} color={PALETTE.primary} opacity={opacity} />
      ))}
      {Array.from({ length: n }, (_, i) => (
        <Cell key={`k${i}`} position={[spread(i, n), -1.6, 0]} color={PALETTE.secondary} opacity={opacity} />
      ))}
      {Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => {
          const weight = Math.abs(weights[(i * n + j) % weights.length] ?? 0.4);
          const a = phase(t, 0.1 + (i / n) * 0.5, 0.5 + (i / n) * 0.5);
          if (weight < 0.18) return null;
          return (
            <Link
              key={`l${i}-${j}`}
              from={new THREE.Vector3(spread(i, n), 1.4, 0)}
              to={new THREE.Vector3(spread(j, n), -1.4, 0)}
              color={PALETTE.accent}
              opacity={opacity * a * weight * 0.8}
              thickness={0.012 + weight * 0.02}
            />
          );
        }),
      )}
      <EntityLabel entity={inputs[0]} position={[-3.7, 2.3, 0]} onSelect={onSelectEntity} />
      <EntityLabel entity={outputs[0]} position={[3.7, -2.3, 0]} onSelect={onSelectEntity} />
      <Caption text={step.caption} />
    </group>
  );
}

export default AttentionLinksScene;
