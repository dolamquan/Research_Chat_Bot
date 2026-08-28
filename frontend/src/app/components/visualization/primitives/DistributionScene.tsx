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

/** A probability or score distribution over candidates. */
export function DistributionScene({ step, t, inputs, outputs, dimmed, onSelectEntity }: PrimitiveSceneProps) {
  const values = normalizedValues(step.values, unitCount(step.count, step.items, 9));
  const n = values.length;
  const opacity = dimmed ? 0.3 : 1;
  const total = values.reduce((a, b) => a + Math.abs(b), 0) || 1;
  return (
    <group>
      {values.map((value, i) => {
        const share = Math.abs(value) / total;
        const a = stagger(t, i, n, 0.55);
        const height = Math.max(0.08, share * n * 1.5 * a);
        return (
          <group key={i} position={[spread(i, n), 0, 0]}>
            <mesh position={[0, height / 2 - 1.2, 0]}>
              <boxGeometry args={[0.38, height, 0.38]} />
              <meshStandardMaterial
                color={seriesColor(i)}
                emissive={seriesColor(i)}
                emissiveIntensity={0.5}
                transparent
                opacity={opacity}
                toneMapped={false}
              />
            </mesh>
            {step.items[i] ? <Caption text={step.items[i]} position={[0, -1.55, 0]} /> : null}
          </group>
        );
      })}
      <EntityLabel entity={inputs[0]} position={[-3.7, 1.9, 0]} onSelect={onSelectEntity} />
      <EntityLabel entity={outputs[0]} position={[3.7, 1.9, 0]} onSelect={onSelectEntity} />
      <Caption text={step.caption} />
    </group>
  );
}

export default DistributionScene;
