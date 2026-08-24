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

/** Values rescaled to a common range: bars converge toward a shared band. */
export function NormalizationScene({ step, t, inputs, outputs, dimmed, onSelectEntity }: PrimitiveSceneProps) {
  const values = normalizedValues(step.values, unitCount(step.count, step.items, 7));
  const n = values.length;
  const opacity = dimmed ? 0.3 : 1;
  const settle = easeInOut(phase(t, 0.15, 0.9));
  const mean = values.reduce((a, b) => a + Math.abs(b), 0) / Math.max(1, n);
  return (
    <group>
      <mesh position={[0, mean * 1.6 - 0.6, -0.4]}>
        <boxGeometry args={[6.2, 0.02, 0.02]} />
        <meshBasicMaterial color={PALETTE.muted} transparent opacity={opacity * 0.7} />
      </mesh>
      {values.map((value, i) => {
        const target = THREE.MathUtils.lerp(Math.abs(value), mean, settle);
        const height = Math.max(0.08, target * 2.2);
        return (
          <mesh key={i} position={[spread(i, n), height / 2 - 0.6, 0]}>
            <boxGeometry args={[0.34, height, 0.34]} />
            <meshStandardMaterial
              color={PALETTE.cool}
              emissive={PALETTE.cool}
              emissiveIntensity={0.45}
              transparent
              opacity={opacity}
              toneMapped={false}
            />
          </mesh>
        );
      })}
      <EntityLabel entity={inputs[0]} position={[-3.6, 2, 0]} onSelect={onSelectEntity} />
      <EntityLabel entity={outputs[0]} position={[3.6, 2, 0]} onSelect={onSelectEntity} />
      <Caption text={step.caption} />
    </group>
  );
}

export default NormalizationScene;
