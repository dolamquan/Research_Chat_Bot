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

/** A 1-D array drawn as bars whose heights are the step's values. */
export function VectorArrayScene({ step, t, inputs, outputs, dimmed, onSelectEntity }: PrimitiveSceneProps) {
  const values = normalizedValues(step.values, unitCount(step.count, step.items, 8));
  const n = values.length;
  const opacity = dimmed ? 0.3 : 1;
  return (
    <group>
      {values.map((value, i) => {
        const a = stagger(t, i, n);
        const height = Math.max(0.08, Math.abs(value) * 2.2 * a);
        return (
          <group key={i} position={[spread(i, n), 0, 0]}>
            <mesh position={[0, height / 2 - 1, 0]}>
              <boxGeometry args={[0.34, height, 0.34]} />
              <meshStandardMaterial
                color={value < 0 ? PALETTE.warm : PALETTE.primary}
                emissive={value < 0 ? PALETTE.warm : PALETTE.primary}
                emissiveIntensity={0.5}
                transparent
                opacity={opacity}
                toneMapped={false}
              />
            </mesh>
            {step.items[i] ? <Caption text={step.items[i]} position={[0, -1.35, 0]} /> : null}
          </group>
        );
      })}
      <EntityLabel entity={inputs[0]} position={[-3.6, 1.7, 0]} onSelect={onSelectEntity} />
      <EntityLabel entity={outputs[0]} position={[3.6, 1.7, 0]} onSelect={onSelectEntity} />
      <Caption text={step.caption} />
    </group>
  );
}

export default VectorArrayScene;
