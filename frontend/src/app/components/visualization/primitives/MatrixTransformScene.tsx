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

/** A 2-D grid being projected: cells light up row by row as the product forms. */
export function MatrixTransformScene({ step, t, inputs, outputs, dimmed, onSelectEntity }: PrimitiveSceneProps) {
  const side = Math.max(2, Math.min(Math.round(Math.sqrt(unitCount(step.count, step.items, 16))) || 4, 6));
  const opacity = dimmed ? 0.3 : 1;
  const cells = [];
  for (let r = 0; r < side; r += 1) {
    for (let c = 0; c < side; c += 1) {
      const index = r * side + c;
      const a = stagger(t, index, side * side, 0.6);
      cells.push(
        <Cell
          key={index}
          position={[(c - (side - 1) / 2) * 0.55 - 1.8, (r - (side - 1) / 2) * 0.55, 0]}
          color={PALETTE.secondary}
          scale={0.55 + 0.45 * a}
          opacity={opacity * (0.25 + 0.75 * a)}
        />,
      );
    }
  }
  const out = phase(t, 0.45, 1);
  return (
    <group>
      {cells}
      <group position={[2.2, 0, 0]} scale={0.4 + 0.6 * out}>
        {Array.from({ length: side }, (_, r) => (
          <Cell
            key={r}
            position={[0, (r - (side - 1) / 2) * 0.55, 0]}
            color={PALETTE.accent}
            opacity={opacity * out}
          />
        ))}
      </group>
      <EntityLabel entity={inputs[0]} position={[-1.8, 2.1, 0]} onSelect={onSelectEntity} />
      <EntityLabel entity={outputs[0]} position={[2.2, 2.1, 0]} onSelect={onSelectEntity} />
      <Caption text={step.caption} />
    </group>
  );
}

export default MatrixTransformScene;
