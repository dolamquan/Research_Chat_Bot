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

/** Parallel branches converging back into one. */
export function ParallelMergeScene({ step, t, inputs, outputs, dimmed, onSelectEntity }: PrimitiveSceneProps) {
  const branches = Math.max(2, Math.min(inputs.length || step.count || 3, 6));
  const opacity = dimmed ? 0.3 : 1;
  const close = easeInOut(phase(t, 0.1, 0.8));
  return (
    <group>
      {Array.from({ length: branches }, (_, i) => {
        const y = (i - (branches - 1) / 2) * 1.3 * (1 - close * 0.85);
        return (
          <group key={i}>
            <Cell position={[-3, y, 0]} color={seriesColor(i)} opacity={opacity} />
            <Link
              from={new THREE.Vector3(-2.7, y, 0)}
              to={new THREE.Vector3(2.8, 0, 0)}
              color={seriesColor(i)}
              opacity={opacity * close * 0.7}
            />
            <EntityLabel entity={inputs[i]} position={[-4.4, y, 0]} onSelect={onSelectEntity} />
          </group>
        );
      })}
      <Cell position={[3.2, 0, 0]} color={PALETTE.accent} scale={0.6 + 0.8 * close} opacity={opacity * close} />
      <EntityLabel entity={outputs[0]} position={[3.2, 1.4, 0]} onSelect={onSelectEntity} />
      <Caption text={step.caption} />
    </group>
  );
}

export default ParallelMergeScene;
