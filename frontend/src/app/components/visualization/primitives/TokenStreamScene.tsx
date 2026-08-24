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

/** A sequence of discrete items entering in reading order. */
export function TokenStreamScene({ step, t, inputs, outputs, dimmed, onSelectEntity }: PrimitiveSceneProps) {
  const n = unitCount(step.count, step.items, 8);
  const opacity = dimmed ? 0.3 : 1;
  return (
    <group>
      {Array.from({ length: n }, (_, i) => {
        const a = stagger(t, i, n);
        const x = THREE.MathUtils.lerp(-6.5, spread(i, n), a);
        return (
          <group key={i} position={[x, 0, 0]}>
            <Cell position={[0, 0, 0]} color={PALETTE.primary} scale={0.7 + 0.3 * a} opacity={opacity * (0.25 + 0.75 * a)} />
            {step.items[i] ? (
              <Caption text={step.items[i]} position={[0, 0.65, 0]} />
            ) : null}
          </group>
        );
      })}
      <EntityLabel entity={inputs[0]} position={[-3.6, 1.5, 0]} onSelect={onSelectEntity} />
      <EntityLabel entity={outputs[0]} position={[3.6, 1.5, 0]} onSelect={onSelectEntity} />
      <Caption text={step.caption} />
    </group>
  );
}

export default TokenStreamScene;
