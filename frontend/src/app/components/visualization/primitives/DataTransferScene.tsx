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

/** Something moving between two components or stores. */
export function DataTransferScene({ step, t, inputs, outputs, dimmed, onSelectEntity }: PrimitiveSceneProps) {
  const packets = Math.max(3, Math.min(step.count || 5, 10));
  const opacity = dimmed ? 0.3 : 1;
  const from = new THREE.Vector3(-3.4, 0, 0);
  const to = new THREE.Vector3(3.4, 0, 0);
  return (
    <group>
      <Cell position={from.toArray() as [number, number, number]} color={PALETTE.primary} scale={1.3} opacity={opacity} />
      <Cell position={to.toArray() as [number, number, number]} color={PALETTE.secondary} scale={1.3} opacity={opacity} />
      <Link from={from} to={to} color={PALETTE.muted} opacity={opacity * 0.5} thickness={0.02} />
      {Array.from({ length: packets }, (_, i) => {
        const u = clamp01((t * 1.4 + i / packets) % 1);
        const x = THREE.MathUtils.lerp(from.x + 0.5, to.x - 0.5, u);
        return (
          <Cell
            key={i}
            position={[x, 0, 0]}
            color={PALETTE.accent}
            scale={0.34}
            opacity={opacity * (0.35 + 0.65 * Math.sin(u * Math.PI))}
            shape="sphere"
          />
        );
      })}
      <EntityLabel entity={inputs[0]} position={[-3.4, 1.5, 0]} onSelect={onSelectEntity} />
      <EntityLabel entity={outputs[0]} position={[3.4, 1.5, 0]} onSelect={onSelectEntity} />
      <Caption text={step.caption} />
    </group>
  );
}

export default DataTransferScene;
