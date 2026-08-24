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

/** Two aligned collections combined position by position. */
export function ElementwiseCombineScene({ step, t, inputs, outputs, dimmed, onSelectEntity }: PrimitiveSceneProps) {
  const n = unitCount(step.count, step.items, 6);
  const opacity = dimmed ? 0.3 : 1;
  const merge = easeInOut(phase(t, 0.2, 0.75));
  return (
    <group>
      {Array.from({ length: n }, (_, i) => {
        const x = spread(i, n);
        const gap = 1.25 * (1 - merge);
        const done = phase(t, 0.7, 1);
        return (
          <group key={i}>
            <Cell position={[x, gap, 0]} color={PALETTE.primary} opacity={opacity} />
            <Cell position={[x, -gap, 0]} color={PALETTE.secondary} opacity={opacity} />
            <Cell
              position={[x, 0, 0]}
              color={PALETTE.accent}
              scale={0.4 + 0.8 * done}
              opacity={opacity * done}
            />
          </group>
        );
      })}
      <EntityLabel entity={inputs[0]} position={[-3.8, 1.9, 0]} onSelect={onSelectEntity} />
      <EntityLabel entity={inputs[1]} position={[-3.8, -1.9, 0]} onSelect={onSelectEntity} />
      <EntityLabel entity={outputs[0]} position={[3.8, 0, 0]} onSelect={onSelectEntity} />
      <Caption text={step.caption} />
    </group>
  );
}

export default ElementwiseCombineScene;
