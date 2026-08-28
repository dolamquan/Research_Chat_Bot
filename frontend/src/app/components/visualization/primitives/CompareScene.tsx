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

/** Two quantities placed side by side and scored. */
export function CompareScene({ step, t, inputs, outputs, dimmed, onSelectEntity }: PrimitiveSceneProps) {
  const values = normalizedValues(step.values, 2);
  const left = Math.abs(values[0] ?? 0.6);
  const right = Math.abs(values[1] ?? 0.4);
  const opacity = dimmed ? 0.3 : 1;
  const grow = easeInOut(phase(t, 0.1, 0.7));
  const verdict = phase(t, 0.7, 1);
  const winner = left >= right ? -1 : 1;
  return (
    <group>
      {[[-1.7, left, PALETTE.primary], [1.7, right, PALETTE.secondary]].map(([x, v, color], i) => {
        const height = Math.max(0.1, (v as number) * 2.6 * grow);
        return (
          <mesh key={i} position={[x as number, height / 2 - 1.2, 0]}>
            <boxGeometry args={[0.9, height, 0.9]} />
            <meshStandardMaterial
              color={color as string}
              emissive={color as string}
              emissiveIntensity={0.5}
              transparent
              opacity={opacity}
              toneMapped={false}
            />
          </mesh>
        );
      })}
      <Cell
        position={[winner * 1.7, 2, 0]}
        color={PALETTE.accent}
        scale={0.4 + 0.8 * verdict}
        opacity={opacity * verdict}
        shape="sphere"
      />
      <EntityLabel entity={inputs[0]} position={[-1.7, -1.7, 0]} onSelect={onSelectEntity} />
      <EntityLabel entity={inputs[1]} position={[1.7, -1.7, 0]} onSelect={onSelectEntity} />
      <EntityLabel entity={outputs[0]} position={[0, 2.7, 0]} onSelect={onSelectEntity} />
      <Caption text={step.caption} />
    </group>
  );
}

export default CompareScene;
