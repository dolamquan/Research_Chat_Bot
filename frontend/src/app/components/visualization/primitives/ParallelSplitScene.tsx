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

/** One input fanning out into parallel branches. */
export function ParallelSplitScene({ step, t, inputs, outputs, dimmed, onSelectEntity }: PrimitiveSceneProps) {
  const branches = Math.max(2, Math.min(outputs.length || step.count || 3, 6));
  const opacity = dimmed ? 0.3 : 1;
  const open = easeInOut(phase(t, 0.15, 0.85));
  return (
    <group>
      <Cell position={[-3.4, 0, 0]} color={PALETTE.primary} scale={1.2} opacity={opacity} />
      {Array.from({ length: branches }, (_, i) => {
        const y = (i - (branches - 1) / 2) * 1.3 * open;
        return (
          <group key={i}>
            <Link
              from={new THREE.Vector3(-3.1, 0, 0)}
              to={new THREE.Vector3(2.6, y, 0)}
              color={seriesColor(i)}
              opacity={opacity * open * 0.7}
            />
            <Cell position={[3, y, 0]} color={seriesColor(i)} scale={0.5 + 0.6 * open} opacity={opacity * open} />
            <EntityLabel entity={outputs[i]} position={[4.4, y, 0]} onSelect={onSelectEntity} />
          </group>
        );
      })}
      <EntityLabel entity={inputs[0]} position={[-3.4, 1.4, 0]} onSelect={onSelectEntity} />
      <Caption text={step.caption} />
    </group>
  );
}

export default ParallelSplitScene;
