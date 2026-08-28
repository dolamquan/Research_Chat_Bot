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

/** A subset chosen from candidates: the rest fade and drop away. */
export function FilterSelectScene({ step, t, inputs, outputs, dimmed, onSelectEntity }: PrimitiveSceneProps) {
  const n = unitCount(step.count, step.items, 9);
  const keep = Math.max(1, Math.min(Math.round(n / 3), n));
  const opacity = dimmed ? 0.3 : 1;
  const sift = easeInOut(phase(t, 0.2, 0.85));
  return (
    <group>
      {Array.from({ length: n }, (_, i) => {
        const selected = i < keep;
        const y = selected ? sift * 1.2 : -sift * 1.6;
        return (
          <group key={i} position={[spread(i, n), y, 0]}>
            <Cell
              position={[0, 0, 0]}
              color={selected ? PALETTE.primary : PALETTE.muted}
              scale={selected ? 0.8 + 0.4 * sift : 0.8 - 0.35 * sift}
              opacity={opacity * (selected ? 1 : 1 - 0.75 * sift)}
            />
            {step.items[i] ? <Caption text={step.items[i]} position={[0, 0.6, 0]} /> : null}
          </group>
        );
      })}
      <EntityLabel entity={inputs[0]} position={[-3.8, 2.1, 0]} onSelect={onSelectEntity} />
      <EntityLabel entity={outputs[0]} position={[3.8, 2.1, 0]} onSelect={onSelectEntity} />
      <Caption text={step.caption} />
    </group>
  );
}

export default FilterSelectScene;
